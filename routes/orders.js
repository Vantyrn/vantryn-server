const express = require('express');
const router = express.Router();
const firebaseAuth = require('../middleware/auth');
const requireCustomer = require('../middleware/customer');
const CartService = require('../services/cartService');
const { prisma } = require('../lib/prisma');
const shadowfaxService = require('../src/modules/delivery/shadowfax/shadowfax.service');
const env = require('../src/config/env');

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

    // SFX Serviceability Check
    let deliveryCost = 0;
    
    const isSandbox = env.USE_SANDBOX_PAYMENTS || process.env.USE_SANDBOX_PAYMENTS === 'true';
    console.log(`[CHECKOUT] Sandbox Check: ${isSandbox} (env: ${env.USE_SANDBOX_PAYMENTS}, process: ${process.env.USE_SANDBOX_PAYMENTS})`);

    if (isSandbox) {
      console.log('[CHECKOUT] Sandbox mode active: Applying mock delivery fee with dynamic weather/demand surges.');
      const mockRainIncentive = 15.00;
      const mockDemandSurge = 20.00;
      const mockBaseCharge = 40.00;
      deliveryCost = mockBaseCharge + mockRainIncentive + mockDemandSurge;
    } else {
      try {
        const sfxResponse = await shadowfaxService.checkServiceability({
          pickupDetails: {
            building_name: vendor.businessName || 'Store Vendor',
            latitude: vendor.latitude ? Number(vendor.latitude) : 28.6304,
            longitude: vendor.longitude ? Number(vendor.longitude) : 77.2177,
            address: vendor.businessAddress || 'Store Address'
          },
          dropDetails: {
            building_name: address.addressType || 'Customer Residence',
            latitude: address.latitude ? Number(address.latitude) : 28.6448,
            longitude: address.longitude ? Number(address.longitude) : 77.1873,
            address: address.addressLine1 || 'Customer Address'
          },
          orderValue: cart.total,
          paid: true
        });
        
        if (sfxResponse && !sfxResponse.isServiceable) {
          return res.status(422).json({ 
            error: 'DELIVERY_UNAVAILABLE', 
            message: 'Delivery is currently unavailable in your area.' 
          });
        }
        
        if (sfxResponse) {
          // Dynamic weather and surge charges are added dynamically to the delivery charges
          deliveryCost = Number(sfxResponse.total_amount || 0) + Number(sfxResponse.rain_rider_incentive || 0) + Number(sfxResponse.high_demand_surge || 0);
        }
      } catch (error) {
        console.warn('[CHECKOUT-DEMO] Serviceability check failed, forcing mock delivery cost of 75 for stability:', error.message);
        deliveryCost = 75.00;
      }
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

    if (env.USE_SANDBOX_PAYMENTS) {
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
    const { addressId } = req.body;
    
    const cart = await CartService.getCart({ customerId: req.customer.id });
    if (!cart) return res.status(404).json({ error: 'Cart empty' });

    const vendor = await prisma.vendor.findUnique({ where: { id: cart.vendorId } });
    const address = await prisma.address.findUnique({ where: { id: addressId, customerId: req.customer.id } });

    if (!vendor || !address) return res.status(400).json({ error: 'Invalid vendor or address' });

    const isSandbox = env.USE_SANDBOX_PAYMENTS || process.env.USE_SANDBOX_PAYMENTS === 'true';
    if (isSandbox) {
      const mockRainIncentive = 15.00;
      const mockDemandSurge = 20.00;
      const mockBaseCharge = 40.00;
      const totalDeliveryFee = mockBaseCharge + mockRainIncentive + mockDemandSurge;
      return res.json({
        success: true,
        isServiceable: true,
        riderCount: 5,
        deliveryFee: totalDeliveryFee,
        eta: '15 Mins'
      });
    }

    try {
      const sfxResponse = await shadowfaxService.checkServiceability({
        pickupDetails: {
          building_name: vendor.businessName || 'Store Vendor',
          latitude: vendor.latitude ? Number(vendor.latitude) : 28.6304,
          longitude: vendor.longitude ? Number(vendor.longitude) : 77.2177,
          address: vendor.businessAddress || 'Store Address'
        },
        dropDetails: {
          building_name: address.addressType || 'Customer Residence',
          latitude: address.latitude ? Number(address.latitude) : 28.6448,
          longitude: address.longitude ? Number(address.longitude) : 77.1873,
          address: address.addressLine1 || 'Customer Address'
        },
        orderValue: cart.total,
        paid: true
      });

      const totalDeliveryFee = Number(sfxResponse.total_amount || 0) + Number(sfxResponse.rain_rider_incentive || 0) + Number(sfxResponse.high_demand_surge || 0);

      res.json({
        success: true,
        isServiceable: sfxResponse.isServiceable,
        riderCount: sfxResponse.isServiceable ? 5 : 0,
        deliveryFee: totalDeliveryFee,
        eta: sfxResponse.eta || null
      });
    } catch (sfxErr) {
      res.status(422).json({ 
        success: false, 
        error: 'DELIVERY_CHECK_FAILED', 
        message: 'Delivery serviceability validation failed at this time.' 
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
    
    const cancellableStatuses = [
      'pending_vendor', 
      'accepted', 
      'preparing', 
      'ready', 
      'ready_for_pickup', 
      'on_the_way_to_pickup', 
      'arrived_at_pickup'
    ];
    if (!cancellableStatuses.includes(order.status)) {
        return res.status(400).json({ error: 'Order cannot be cancelled at this stage' });
    }

    let refundStatus = order.refundStatus;
    if (Number(order.totalAmount) > 0) {
        refundStatus = 'PENDING';
    }

    const updatedOrder = await prisma.order.update({
        where: { id },
        data: {
            status: 'cancelled',
            refundStatus,
        }
    });

    await prisma.orderStatusHistory.create({
        data: {
            orderId: id,
            status: 'cancelled',
            changedBy: 'CUSTOMER'
        }
    });

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
      include: { rider: { include: { profile: true } } }
    });

    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.riderId) return res.status(200).json({ success: true, status: order.status, message: 'Rider not yet assigned' });

    res.json({
      success: true,
      status: order.status,
      rider: {
        name: order.rider.fullName,
        phone: order.rider.profile?.phoneNumber || '',
        location: {
          lat: Number(order.rider.latitude),
          lng: Number(order.rider.longitude)
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tracking info' });
  }
});

module.exports = router;
