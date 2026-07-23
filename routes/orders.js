const express = require('express');
const router = express.Router();
const firebaseAuth = require('../middleware/auth');
const requireCustomer = require('../middleware/customer');
const CartService = require('../services/cartService');
const { prisma } = require('../lib/prisma');
const sfxMapper = require('../src/modules/delivery/shadowfax/shadowfax.mapper');
const env = require('../src/config/env');
const { assertServiceable } = require('../lib/deliveryCost');
const { getSfxTracking } = require('../lib/sfxTracking');
const { isCancellableStatus } = require('../lib/orderStatus');
const { isVendorReachable } = require('../lib/vendorReachable');
const { emitVendorStatusUpdate } = require('../lib/socket');

/**
 * MODULE 5 — ORDER & PAYMENT
 */

// POST /orders — initiate payment, validate cart, age verification, guest login
router.post('/checkout', firebaseAuth, requireCustomer, async (req, res) => {
  try {
    const { deliveryPreference, addressId, vendorId } = req.body;

    if (!vendorId) {
      return res.status(400).json({ error: 'Vendor ID is required for checkout' });
    }

    // 2. Delivery preference must be explicitly set
    if (!deliveryPreference) {
      return res.status(400).json({ error: 'Delivery preference must be explicitly selected.' });
    }

    // 3. Get Cart
    const cart = await CartService.getCart({ customerId: req.customer.id }, vendorId);
    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty for this vendor' });
    }

    // VENDOR GATEKEEPER CHECK (Pre-Payment)
    const vendor = await prisma.vendor.findUnique({ where: { id: cart.vendorId } });
    // Reachability, not just the stored flag: a vendor who killed the app stays 'online'
    // in the DB forever. If they say online but haven't checked in recently, they cannot
    // see or accept this order — flip them offline so they drop out of browsing for the
    // next customer too, and reject the order cleanly instead of letting it sit.
    if (vendor && vendor.onlineStatus === 'online' && !isVendorReachable(vendor)) {
      await prisma.vendor.update({ where: { id: vendor.id }, data: { onlineStatus: 'offline' } }).catch(() => {});
      try { emitVendorStatusUpdate(vendor.id, false); } catch (_) {}
      console.log(`[ORDERS] Vendor ${vendor.id} was 'online' but stale (app closed) — flipped offline, order rejected.`);
      return res.status(403).json({
        error: 'VENDOR_OFFLINE',
        message: 'This vendor just went offline and is not accepting orders right now.'
      });
    }
    if (!vendor || vendor.onlineStatus !== 'online') {
      return res.status(403).json({
        error: 'VENDOR_OFFLINE',
        message: 'This vendor is currently offline and not accepting orders.'
      });
    }

    // Only check operating hours if not explicitly 'online' (though onlineStatus check above already covers this for now)
    // We prioritize manual 'online' status as a force-open override.
    const { checkVendorAvailability } = require('../lib/availability');
    const { isOpen, nextOpen } = checkVendorAvailability(vendor.operatingHours);
    
    if (vendor.onlineStatus !== 'online' && !isOpen) {
      return res.status(403).json({ 
        error: 'VENDOR_CLOSED', 
        message: `This vendor is currently closed. They will be back online ${nextOpen || 'soon'}.`
      });
    }

    // 4. Validate Age Verification for restricted products
    const hasRestrictedProducts = cart.items.some(item => item.isRestricted === true);

    if (hasRestrictedProducts) {
        const verification = req.customer.ageVerification;
        const now = new Date();

        if (verification && verification.isVerified === false && verification.verificationId === 'UNDERAGE_ACKNOWLEDGED') {
            console.log(`[CHECKOUT] Age verification failed: user is verified minor for ${req.customer.id}.`);
            return res.status(403).json({ 
                error: 'UNDERAGE_RESTRICTION', 
                message: 'You are under 18. Restricted items cannot be purchased.' 
            });
        }

        if (!verification || verification.isVerified === false || new Date(verification.expiresAt) < now) {
            console.log(`[CHECKOUT] Age verification failed/required for ${req.customer.id}.`);
            return res.status(403).json({ 
                error: 'AGE_VERIFICATION_REQUIRED', 
                message: 'Age verification required.' 
            });
        }
    }

    // 5. Validate Address
    // Validate if it's a UUID string to prevent Prisma crash
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(addressId)) {
        return res.status(400).json({ error: 'Invalid address ID format' });
    }
    const address = await prisma.address.findUnique({ where: { id: addressId, customerId: req.customer.id } });

    if (!address) return res.status(400).json({ error: 'Valid delivery address required' });

    // FIRST gate: is the vendor→customer route serviceable? A "+ve" result returns delivery
    // charges; a "-ve" result blocks the order. Single source of truth: lib/deliveryCost.
    let deliveryCost = 0;
    try {
      ({ deliveryCost } = await assertServiceable({ vendor, address, cartTotal: cart.total, paid: true }));
    } catch (error) {
      if (error.code === 'DELIVERY_UNAVAILABLE') {
        return res.status(422).json({ error: 'DELIVERY_UNAVAILABLE', message: error.message });
      }
      console.warn('[CHECKOUT] Serviceability check failed:', error.message);
      return res.status(422).json({
        error: 'DELIVERY_CHECK_FAILED',
        message: 'Could not verify delivery serviceability right now. Please try again.'
      });
    }

    // 6. Initiate Payment (Sandbox or Real)
    let paymentData = {
      success: true,
      amount: cart.total,
      deliveryFee: deliveryCost,
      totalToPay: cart.total + deliveryCost,
      currency: 'INR',
      clientSecret: 'mock_secret_123',
    };

    if (env.SANDBOX_PAYMENTS) {
      const sandboxPaymentService = require('../services/sandboxPaymentService');
      const sandboxIntent = sandboxPaymentService.createPaymentIntent(
        cart.total + deliveryCost,
        req.customer.id,
        cart.vendorId
      );
      paymentData.paymentIntentId = sandboxIntent.id;
      paymentData.isSandbox = true;
      paymentData.message = 'PayPal Sandbox payment initiated.';
    } else {
      // In real app, call Stripe/Razorpay here
      paymentData.paymentIntentId = `pi_${Math.random().toString(36).substring(7)}`;
      paymentData.message = 'Payment initiated. Awaiting confirmation.';
    }
    
    res.json(paymentData);

  } catch (error) {
    console.error('[CHECKOUT] error:', error);
    res.status(500).json({ error: 'Checkout initiation failed' });
  }
});

/**
 * POST /orders/validate-delivery
 * Pre-checkout serviceability check for Shadowfax
 */
router.post('/validate-delivery', firebaseAuth, requireCustomer, async (req, res) => {
  try {
    const { addressId, vendorId } = req.body;

    // vendorId scopes the lookup to the right cart when the customer has carts with several vendors.
    const cart = await CartService.getCart({ customerId: req.customer.id }, vendorId);
    if (!cart) return res.status(404).json({ error: 'Cart empty' });

    const vendor = await prisma.vendor.findUnique({ where: { id: cart.vendorId } });
    const address = await prisma.address.findUnique({ where: { id: addressId, customerId: req.customer.id } });

    if (!vendor || !address) return res.status(400).json({ error: 'Invalid vendor or address' });

    try {
      const { deliveryCost, pickupEta, dropEta } = await assertServiceable({
        vendor, address, cartTotal: cart.total, paid: true
      });
      res.json({
        success: true,
        isServiceable: true,
        deliveryFee: deliveryCost,
        pickupEta,
        dropEta,
        eta: dropEta != null ? `${dropEta} Mins` : '15 Mins'
      });
    } catch (sfxErr) {
      res.status(422).json({
        success: false,
        error: sfxErr.code === 'DELIVERY_UNAVAILABLE' ? 'DELIVERY_UNAVAILABLE' : 'DELIVERY_CHECK_FAILED',
        message: sfxErr.code === 'DELIVERY_UNAVAILABLE'
          ? sfxErr.message
          : 'Delivery serviceability validation failed at this time.'
      });
    }
  } catch (error) {
    res.status(500).json({ error: 'Validation failed' });
  }
});

// GET /orders — customer order history
router.get('/', firebaseAuth, requireCustomer, async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { customerId: req.customer.id },
      include: { 
        vendor: {
            select: { businessName: true, logoUrl: true }
        },
        items: true
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, orders });
  } catch (error) {
    console.error('[ORDERS-FETCH] 500 Error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch order history', 
      details: error.message
    });
  }
});

// GET /orders/:id — order detail and current status
router.get('/:id', firebaseAuth, requireCustomer, async (req, res) => {
  try {
    const { id } = req.params;
    const order = await prisma.order.findUnique({
      where: { id, customerId: req.customer.id },
      include: { 
        vendor: true, 
        rider: true,
        items: true,
        statusHistory: {
            orderBy: { changedAt: 'asc' }
        },
        tracking: {
            orderBy: { recordedAt: 'asc' }
        }
      }
    });

    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch order details' });
  }
});

// POST /orders/:id/cancel — customer order cancellation
router.post('/:id/cancel', firebaseAuth, requireCustomer, async (req, res) => {
  try {
    const { id } = req.params;
    const order = await prisma.order.findUnique({
      where: { id, customerId: req.customer.id }
    });

    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Cancellable only before the rider takes the parcel — Shadowfax bills 100% of the
    // delivery fee for a post-pickup cancellation.
    if (!isCancellableStatus(order.status)) {
        return res.status(400).json({ error: 'Order cannot be cancelled at this stage' });
    }

    // Route through OrderService: it cancels the Shadowfax delivery, writes status history,
    // sets refundStatus, and emits sockets + push. A direct prisma.update here would leave a
    // real rider en route to a cancelled order.
    const OrderService = require('../services/orderService');
    const updatedOrder = await OrderService.updateOrderStatus(id, 'cancelled', 'CUSTOMER');

    // Notify vendor
    const { getIo } = require('../lib/socket');
    getIo().to(`vendor_${order.vendorId}`).emit('order_cancelled', { orderId: id, reason: 'Cancelled by customer' });

    try {
        const fcm = require('../lib/fcm');
        await fcm.sendToVendor(order.vendorId, {
            title: 'Order Cancelled',
            body: `Order #${id.substring(0, 8)} was cancelled by the customer.`,
            type: 'ORDER_CANCELLED',
            orderId: id
        });
    } catch (pushErr) {
        console.error('[ORDER CANCEL] Failed to send push notification to vendor:', pushErr.message);
    }

    res.json({ success: true, order: updatedOrder });
  } catch (error) {
    console.error('[ORDER CANCEL] Error:', error);
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

/**
 * MODULE 7 — LIVE ORDER TRACKING
 */
router.get('/:id/tracking', firebaseAuth, requireCustomer, async (req, res) => {
  try {
    const { id } = req.params;
    const order = await prisma.order.findUnique({
      where: { id, customerId: req.customer.id },
      include: { vendor: { select: { businessName: true, latitude: true, longitude: true } } }
    });

    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Delivery telemetry comes from Shadowfax (real or simulated), stored in the sfx_* tables.
    const { sfxStatus, trackUrl, rider, riderLocation } = await getSfxTracking(id);

    const snap = order.addressSnapshot || {};
    res.json({
      success: true,
      status: order.status,
      sfxStatus,
      trackUrl,
      rider,
      riderLocation,
      vendorLocation: (order.vendor?.latitude && order.vendor?.longitude)
        ? { lat: Number(order.vendor.latitude), lng: Number(order.vendor.longitude), name: order.vendor.businessName }
        : null,
      destination: (snap.latitude && snap.longitude)
        ? { lat: Number(snap.latitude), lng: Number(snap.longitude) }
        : null
    });
  } catch (error) {
    console.error('[TRACKING] Failed:', error.message);
    res.status(500).json({ error: 'Failed to fetch tracking info' });
  }
});

module.exports = router;
