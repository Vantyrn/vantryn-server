const { prisma, withRetry } = require('../lib/prisma');

/**
 * Cart Service for handling business logic related to shopping carts.
 */
class CartService {
  /**
   * Config for add-on charges
   */
  static CONFIG = {
    FREE_ADDON_LIMIT: 3,
    PER_UNIT_CHARGE: 2.50
  };

  /**
   * Guard for any cart MUTATION while a UPI payment is in flight.
   * - If the customer has already CLAIMED they paid (payment being confirmed) → block:
   *   editing now would let the order drift from what they paid for.
   * - Otherwise any merely-initiated (un-claimed) payment is stale the moment they
   *   change the cart → void it and unlock, then allow the edit. This is what frees a
   *   customer who started a payment, went back, and now wants to edit/clear/switch.
   */
  static async _assertEditable(identifier) {
    const { customerId, guestId } = identifier;
    const who = customerId ? { customerId } : { guestId };
    const claimed = await prisma.upiPaymentRequest.findFirst({
      where: { status: { in: ['PENDING', 'CONFIRMING'] }, clientClaim: 'CLAIMED_SUCCESS', ...who },
      select: { id: true },
    });
    if (claimed) {
      throw { status: 409, code: 'PAYMENT_IN_PROGRESS', message: 'A payment is being confirmed for this cart. Please wait for it to finish before changing items.' };
    }
    // Void un-claimed initiated payments and release the cart lock.
    await prisma.upiPaymentRequest.updateMany({
      where: { status: 'PENDING', clientClaim: null, ...who },
      data: { status: 'EXPIRED', failureReason: 'Cart changed before payment' },
    }).catch(() => {});
    await prisma.cart.updateMany({ where: who, data: { checkedOutAt: null } }).catch(() => {});
  }

  /**
   * Add or update an item in the cart
   */
  static async updateCart(identifier, { productId, vendorId, quantity, options, isRestricted }) {
    const { customerId, guestId } = identifier;
    console.log('[CART-SERVICE] Updating cart for:', identifier, { productId, vendorId });

    // Validation: Ensure IDs are valid UUIDs if they exist
    const isUuid = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    
    if (productId && !isUuid(productId)) {
        throw { status: 400, message: `Invalid productId format: ${productId}` };
    }
    if (vendorId && !isUuid(vendorId)) {
        throw { status: 400, message: `Invalid vendorId format: ${vendorId}` };
    }

    try {
        // A merely-initiated payment is voided here so the customer can keep editing;
        // a CLAIMED ("I've paid") payment blocks edits until it resolves.
        await CartService._assertEditable({ customerId, guestId });

        const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 hours expiry

        // 0. Verify Product belongs to Vendor (SECURITY)
        const targetProduct = await prisma.product.findUnique({ where: { id: productId } });
        if (!targetProduct || targetProduct.vendorId !== vendorId) {
            throw { status: 400, message: 'This product does not belong to the selected restaurant.' };
        }

        // 0.5 Check Age Restrictions for Restricted Items
        if (targetProduct.isRestricted && customerId) {
          const ageVerification = await prisma.ageVerification.findUnique({
            where: { customerId }
          });
          if (ageVerification && ageVerification.isVerified === false && ageVerification.verificationId === 'UNDERAGE_ACKNOWLEDGED') {
            throw { status: 403, message: 'You are under 18. Restricted items cannot be purchased.' };
          }
        }

        let queryWhere = customerId ? { customerId, vendorId } : { guestId, vendorId };

        // 1. Enforce Vendor Limits
        const allCarts = await prisma.cart.findMany({
          where: customerId ? { customerId } : { guestId },
          include: { items: true }
        });
        
        const allProductIds = allCarts.flatMap(c => c.items.map(i => i.productId));
        const allProducts = await prisma.product.findMany({
          where: { id: { in: allProductIds } },
          select: { vendorId: true }
        });
        
        const uniqueVendorsInCart = new Set(allProducts.map(p => p.vendorId));
        const alreadyHasThisVendor = uniqueVendorsInCart.has(vendorId);

        // ONE restaurant per order (for everyone). Unlimited items from the SAME
        // vendor; switching to a different vendor requires clearing the cart first.
        // 409 → the client prompts "clear cart & add?" and calls overrideCart.
        if (!alreadyHasThisVendor && uniqueVendorsInCart.size >= 1) {
          throw {
            status: 409,
            code: 'SINGLE_VENDOR_ONLY',
            message: 'Your cart has items from another restaurant. You can order from only one restaurant at a time — clear the cart to add this item?',
          };
        }

        const start = Date.now();
        let cart = await prisma.cart.findFirst({
          where: customerId ? { 
            customerId,
            vendorId
          } : { 
            guestId,
            vendorId
          },
          include: { items: true }
        });
        console.log(`[CART-SERVICE] Lookup took ${Date.now() - start}ms`);

        if (cart) {
          cart = await prisma.cart.update({
            where: { id: cart.id },
            data: { expiresAt },
            include: { items: true }
          });
        } else {
          // No cart for THIS vendor yet. Create one.
          cart = await prisma.cart.create({
            data: {
              customerId,
              guestId: customerId ? null : guestId,
              vendorId,
              expiresAt
            },
            include: { items: true }
          });
        }

        // 4. Handle Age Verification
        const ageVerified = isRestricted ? !!options?.ageVerified : true;

        // 5. Upsert Cart Item
        const existingItem = cart.items.find(item => item.productId === productId);
        if (existingItem) {
          return await prisma.cartItem.update({
            where: { id: existingItem.id },
            data: {
              quantity: quantity || existingItem.quantity,
              options: options || existingItem.options,
              ageVerifiedCheckbox: ageVerified
            }
          });
        } else {
          return await prisma.cartItem.create({
            data: {
              cartId: cart.id,
              productId,
              quantity: quantity || 1,
              options,
              ageVerifiedCheckbox: ageVerified
            }
          });
        }
    } catch (err) {
        console.error('[CART-SERVICE] Critical Update Error:', err);
        console.error('[CART-SERVICE] Payload:', { identifier, productId, vendorId, quantity, options });
        throw err;
    }
  }

  /**
   * Calculate cart totals with add-on charge logic
   */
  static async getCart(identifier, requestedVendorId = null) {
    const { customerId, guestId } = identifier;
    
    try {
        const queryWhere = customerId ? { customerId } : { guestId };
        
        // 1. Fetch carts
        const cartQuery = {
          where: requestedVendorId ? { ...queryWhere, vendorId: requestedVendorId } : queryWhere,
          include: { items: true }
        };

        if (requestedVendorId) {
          // SINGLE VENDOR MODE (Legacy support for checkout)
          const cart = await prisma.cart.findFirst({
            where: customerId ? { customerId, vendorId: requestedVendorId } : { guestId, vendorId: requestedVendorId },
            include: { items: true }
          });
          
          if (!cart) return null;
          
          // Enrich this single cart (reuse existing logic but for one)
          return await this._enrichCarts([cart], true);
        }

        // MULTI VENDOR MODE (For cart screen)
        const allCarts = await prisma.cart.findMany({
          where: queryWhere,
          include: { items: true }
        });

        if (allCarts.length === 0) return { carts: [], totalItems: 0, grandTotal: 0 };
        return await this._enrichCarts(allCarts, false);

    } catch (err) {
        console.error('[CART-SERVICE] Error in getCart:', err);
        throw err;
    }
  }

  /**
   * Internal helper to enrich cart items with product and vendor details
   */
  static async _enrichCarts(allCarts, singleMode = false) {
    // 1. Fetch all unique products across all carts
    const allProductIds = [...new Set(allCarts.flatMap(c => c.items.map(i => i.productId)))];
    const products = await prisma.product.findMany({
      where: { id: { in: allProductIds } },
      include: { 
        addOns: true,
        customizationGroups: { include: { options: true } }
      }
    });
    const productMap = products.reduce((acc, p) => ({ ...acc, [p.id]: p }), {});

    // 2. Fetch all unique vendors based on products in cart
    const vendorIds = [...new Set(products.map(p => p.vendorId))];
    const vendors = await prisma.vendor.findMany({ where: { id: { in: vendorIds } } });
    const vendorMap = vendors.reduce((acc, v) => ({ ...acc, [v.id]: v }), {});

    // 3. Flatten and regroup items by their PRODUCT'S vendor
    const allItems = allCarts.flatMap(c => c.items.map(item => ({ ...item, cartId: c.id })));
    const itemsByVendor = allItems.reduce((acc, item) => {
      const p = productMap[item.productId];
      const vid = p?.vendorId || 'unknown';
      if (!acc[vid]) acc[vid] = [];
      acc[vid].push(item);
      return acc;
    }, {});

    const enrichedCarts = Object.entries(itemsByVendor).map(([vid, items]) => {
      let subtotal = 0;
      let totalAddonCharges = 0;

      const enrichedItems = items.map(item => {
        const product = productMap[item.productId];
        if (!product) return { ...item, name: 'Unknown Product', price: 0, unitPrice: 0, total: 0 };

        const basePrice = Number(product.basePrice || 0);
        const itemSubtotal = basePrice * item.quantity;
        
        let itemAddonCharge = 0;
        const selectedAddons = item.options?.selectedAddons || [];
        selectedAddons.forEach(selected => {
          const addonName = typeof selected === 'string' ? selected : (selected.name || '');
          const addonDetails = product.addOns.find(a => a.name === addonName || a.id === selected.id);
          if (addonDetails) {
            const qty = selected.quantity || 1;
            const freeLimit = addonDetails.freeLimit || 0;
            itemAddonCharge += (Math.max(0, qty - freeLimit) * Number(addonDetails.price || 0));
          }
        });

        const selectedCustomizations = item.options?.customizations || [];
        selectedCustomizations.forEach(groupSelection => {
          const groupDetails = product.customizationGroups.find(g => g.id === groupSelection.groupId);
          if (groupDetails && groupSelection.selectedOptions) {
            groupSelection.selectedOptions.forEach(selectedOpt => {
              const optId = typeof selectedOpt === 'string' ? selectedOpt : selectedOpt.id;
              const optDetails = groupDetails.options.find(o => o.id === optId);
              if (optDetails) {
                const optQty = typeof selectedOpt === 'object' ? (selectedOpt.quantity || 1) : 1;
                itemAddonCharge += (Number(optDetails.priceModifier || 0) * Math.max(0, optQty - (optDetails.freeLimit || 0)));
              }
            });
          }
        });

        const totalLineAddonCharge = itemAddonCharge * item.quantity;
        subtotal += itemSubtotal;
        totalAddonCharges += totalLineAddonCharge;

        return {
          ...item,
          name: product.name,
          price: basePrice,
          unitPrice: basePrice + itemAddonCharge,
          total: itemSubtotal + totalLineAddonCharge,
          isRestricted: product.isRestricted || false
        };
      }).filter(Boolean);

      return {
        id: items[0].cartId, // Link back to original cart record
        vendorId: vid,
        vendorName: vendorMap[vid]?.businessName || 'Unknown Vendor',
        items: enrichedItems,
        subtotal,
        totalAddonCharges,
        total: subtotal + totalAddonCharges
      };
    }).filter(c => c.items.length > 0);

    if (singleMode) return enrichedCarts[0] || null;

    return {
      carts: enrichedCarts,
      totalItems: enrichedCarts.reduce((acc, c) => acc + c.items.length, 0),
      grandTotal: enrichedCarts.reduce((acc, c) => acc + c.total, 0)
    };
  }

  static async clearCart(identifier) {
    const { customerId, guestId } = identifier;
    await CartService._assertEditable(identifier); // voids an un-claimed payment; blocks if claimed
    const cart = await prisma.cart.findFirst({
        where: customerId ? { customerId } : { guestId }
    });
    if (cart) {
        await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    }
  }

  static async removeItem(identifier, itemId) {
    const { customerId, guestId } = identifier;
    
    const carts = await prisma.cart.findMany({
        where: customerId ? { customerId } : { guestId },
        select: { id: true }
    });

    if (carts.length === 0) return; // Cart doesn't exist, nothing to remove

    const cartIds = carts.map(c => c.id);

    // Removing an item voids a merely-initiated payment (the amount would change);
    // a CLAIMED payment blocks the edit until it resolves.
    await CartService._assertEditable(identifier);

    await prisma.cartItem.deleteMany({
      where: {
        id: itemId,
        cartId: { in: cartIds } // Security: Ensure item belongs to one of user's carts
      }
    });
  }
}

module.exports = CartService;
