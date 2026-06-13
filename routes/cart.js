const express = require('express');
const router = express.Router();
const firebaseAuthOptional = require('../middleware/auth_optional'); 
const guestSession = require('../middleware/guest');
const CartService = require('../services/cartService');
const { prisma, getOrCreateCustomerProfile } = require('../lib/prisma');

/**
 * MODULE 3 — CART
 */

// POST /cart — create or update cart
router.post('/', firebaseAuthOptional, guestSession, async (req, res) => {
  try {
    const { productId, vendorId, quantity, options, isRestricted } = req.body;
    
    const identifier = { 
      customerId: null, 
      guestId: req.guestId 
    };
    
    if (req.user) {
        const profile = await getOrCreateCustomerProfile(req.user);
        identifier.customerId = profile.customer.id;
    }

    const updatedItem = await CartService.updateCart(identifier, { 
      productId, 
      vendorId, 
      quantity, 
      options, 
      isRestricted 
    });

    res.json({ success: true, item: updatedItem });
  } catch (error) {
    console.error('[CART-ROUTE] Update error:', error);
    if (error.status) return res.status(error.status).json({ message: error.message });
    res.status(500).json({ 
      message: 'Failed to update cart',
      details: error.message || error,
      code: error.code
    });
  }
});

// GET /cart — return current cart
router.get('/', firebaseAuthOptional, guestSession, async (req, res) => {
  try {
    const identifier = { 
      customerId: null, 
      guestId: req.guestId 
    };
    
    if (req.user) {
        const profile = await getOrCreateCustomerProfile(req.user);
        identifier.customerId = profile.customer.id;
    }

    const cart = await CartService.getCart(identifier);
    if (!cart) return res.json({ success: true, cart: { items: [], total: 0 } });

    res.json({ success: true, cart });
  } catch (error) {
    console.error('[CART] Get error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch cart',
      message: error.message,
      stack: error.stack,
      details: error
    });
  }
});

// DELETE /cart/item/:id — remove item
router.delete('/item/:id', firebaseAuthOptional, guestSession, async (req, res) => {
  try {
    const { id } = req.params;
    const identifier = { 
      customerId: null, 
      guestId: req.guestId 
    };
    
    if (req.user) {
        const profile = await getOrCreateCustomerProfile(req.user);
        identifier.customerId = profile.customer.id;
    }

    await CartService.removeItem(identifier, id);
    res.json({ success: true });
  } catch (error) {
    console.error('[CART] Remove item error:', error);
    res.status(500).json({ error: 'Failed to remove item', details: error.message });
  }
});


// DELETE /cart — clear cart
router.delete('/', firebaseAuthOptional, guestSession, async (req, res) => {
  try {
    const identifier = { 
      customerId: null, 
      guestId: req.guestId 
    };
    
    if (req.user) {
        const profile = await getOrCreateCustomerProfile(req.user);
        identifier.customerId = profile.customer.id;
    }

    const { vendorId } = req.query;
    const baseWhere = identifier.customerId ? { customerId: identifier.customerId } : { guestId: identifier.guestId };
    
    await prisma.cart.deleteMany({
      where: vendorId ? { ...baseWhere, vendorId } : baseWhere
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear cart' });
  }
});

module.exports = router;
