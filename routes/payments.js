const express = require('express');
const router = express.Router();
const { prisma } = require('../lib/prisma');
const OrderService = require('../services/orderService');
const CartService = require('../services/cartService');
const deliveryService = require('../src/modules/delivery/delivery.service');

const firebaseAuth = require('../middleware/auth');
const requireCustomer = require('../middleware/customer');
const guestSession = require('../middleware/guest');
const { validateBody, z } = require('../lib/validate');

// Lenient on purpose: only the field the handler genuinely requires is enforced,
// extra keys (deliveryFee, paymentMethod, customerName, razorpay_*) pass through.
const verifySchema = z.object({
  paymentIntentId: z.string().min(1, 'paymentIntentId is required'),
  status: z.string().optional(),
  deliveryPreference: z.string().optional(),
  addressId: z.string().optional(),
  vendorId: z.string().optional(),
}).passthrough();

/**
 * MODULE 5 — PAYMENT WEBHOOK
 */

// POST /payments/verify — payment webhook handler (SECURE)
router.post('/verify', firebaseAuth, requireCustomer, guestSession, validateBody(verifySchema), async (req, res) => {
  const { paymentIntentId, status, deliveryPreference, addressId } = req.body;
  const customerId = req.customer.id; // Trusted DB UUID
  const guestId = req.guestId;       // From guestSession middleware

  try {
    // ── Payment authenticity gate ───────────────────────────────────────────
    // NEVER trust a client-asserted status:'succeeded' on its own. Real payments
    // must pass Razorpay HMAC verification; sandbox/test payments are accepted
    // without a real charge ONLY when explicitly enabled (the Razorpay-test pilot)
    // or in dev — never silently in a live production build.
    const isSandbox = typeof paymentIntentId === 'string' && paymentIntentId.startsWith('pi_sandbox_');
    if (isSandbox) {
      const sandboxAllowed = process.env.SANDBOX_PAYMENTS === 'on' || process.env.NODE_ENV !== 'production';
      if (!sandboxAllowed) {
        console.error('[PAYMENT] Sandbox payment rejected: SANDBOX_PAYMENTS off in production.');
        return res.status(403).json({ error: 'PAYMENT_NOT_VERIFIED', message: 'Test payments are disabled.' });
      }
    } else {
      const { verifyPaymentSignature } = require('../lib/razorpay');
      let verified = false;
      try {
        verified = verifyPaymentSignature({
          orderId: req.body.razorpay_order_id,
          paymentId: req.body.razorpay_payment_id || paymentIntentId,
          signature: req.body.razorpay_signature,
        });
      } catch (e) {
        console.error('[PAYMENT] Signature verification error:', e.message);
      }
      if (!verified) {
        console.error('[PAYMENT] Razorpay signature verification FAILED for intent:', paymentIntentId);
        return res.status(400).json({ error: 'PAYMENT_NOT_VERIFIED', message: 'Payment could not be verified.' });
      }
    }

    if (status !== 'succeeded') {
      // Payment failure -> do NOT create order, keep cart intact, return error.
      console.log(`[PAYMENT] Payment failed for intent: ${paymentIntentId}`);
      return res.status(200).json({ success: false, message: 'Payment failed. Cart preserved.' });
    }

    // 1. Get the intent details to find the vendorId
    let vendorId = req.body.vendorId; // Fallback if provided by client
    
    if (paymentIntentId.startsWith('pi_sandbox_')) {
      const sandboxPaymentService = require('../services/sandboxPaymentService');
      const intent = sandboxPaymentService.getPaymentIntent(paymentIntentId);
      if (intent) {
        vendorId = intent.vendorId;
        console.log('[PAYMENT] Found vendorId from sandbox intent:', vendorId);
      }
    }

    // 2. Get the specific cart for this vendor
    console.log('[PAYMENT] Fetching cart for customer:', customerId, 'Vendor:', vendorId);
    const cart = await CartService.getCart({ customerId, guestId }, vendorId);
    
    if (!cart) {
      console.warn('[PAYMENT] Cart not found or already cleared');
      return res.status(404).json({ error: 'Cart not found for this transaction' });
    }

    // 2. Fetch address details for the order
    console.log('[PAYMENT] Validating address:', addressId);
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let address = null;
    if (uuidRegex.test(addressId)) {
        address = await prisma.address.findUnique({ where: { id: addressId } }).catch(e => {
            console.error('[PAYMENT] Address fetch error (swallowing):', e.message);
            return null;
        });
    }
    
    if (!address) {
        address = await prisma.address.findFirst({ where: { customerId } }).catch(() => null);
    }
    
    cart.deliveryAddress = address ? `${address.addressLine1}, ${address.landmark || ''}` : 'Default Delivery Point';

    // 3. Create the order via OrderService
    console.log('[PAYMENT] Creating order from cart:', cart.id);
    const order = await OrderService.createOrderFromCart(
      cart, 
      customerId, 
      req.customer?.fullName || req.body.customerName || 'Customer', 
      deliveryPreference,
      req.body.paymentMethod || 'Online',
      paymentIntentId,
      req.body.deliveryFee || 0
    ).catch(err => {
        console.error('[PAYMENT] OrderService.createOrderFromCart CRASH:', err.message);
        throw err; // rethrow to hit main catch
    });

    console.log('[PAYMENT] Order created successfully:', order.id);
    
    // If order was cancelled by system (e.g. suspicious high-value order), log transaction and return early.
    if (order.status === 'CANCELLED') {
      console.log('[PAYMENT] Order was auto-cancelled by system (suspicious order). Logging transaction and returning early.');
      await prisma.paymentTransaction.create({
        data: {
          orderId: order.id,
          gateway: paymentIntentId.startsWith('pi_sandbox_') ? 'SANDBOX' : 'RAZORPAY', // Auto-detect
          txnId: paymentIntentId,
          status: 'SUCCESS',
          amount: order.totalAmount,
          webhookPayload: { paymentIntentId, deliveryPreference, addressId, deliveryFee: req.body.deliveryFee }
        }
      }).catch(e => console.warn('[PAYMENT] Failed to log transaction record:', e.message));

      return res.json({ success: true, orderId: order.id });
    }
    await prisma.paymentTransaction.create({
      data: {
        orderId: order.id,
        gateway: paymentIntentId.startsWith('pi_sandbox_') ? 'SANDBOX' : 'RAZORPAY', // Auto-detect
        txnId: paymentIntentId,
        status: 'SUCCESS',
        amount: order.totalAmount,
        webhookPayload: { paymentIntentId, deliveryPreference, addressId, deliveryFee: req.body.deliveryFee }
      }
    }).catch(e => console.warn('[PAYMENT] Failed to log transaction record:', e.message));

    // Send Payment Received notification to Vendor via push
    try {
      const fcm = require('../lib/fcm');
      await fcm.sendToVendor(order.vendorId, {
        title: 'Payment Received',
        body: `Payment of ₹${order.totalAmount} received for order #${order.id.substring(0, 8)}.`,
        type: 'PAYMENT_RECEIVED',
        orderId: order.id
      });
    } catch (pushErr) {
      console.error('[PAYMENT-NOTIFICATION] Failed to send payment push to vendor:', pushErr.message);
    }

    // Send Payment Successful notification to Customer via push
    try {
      const fcm = require('../lib/fcm');
      await fcm.sendToCustomer(req.user.uid, {
        title: 'Order Placed Successfully',
        body: `Your payment of ₹${order.totalAmount} was processed successfully for order #${order.id.substring(0, 8)}.`,
        type: 'PAYMENT_SUCCESSFUL',
        orderId: order.id
      });
    } catch (pushErr) {
      console.error('[PAYMENT-CUSTOMER-NOTIFICATION] Failed to send payment push to customer:', pushErr.message);
    }

    // INITIATE SFX DELIVERY
    try {
      await deliveryService.initiateDelivery(order.id);
    } catch (sfxErr) {
      console.error('[PAYMENT] Shadowfax delivery initiation failed:', sfxErr.message);
      try {
        const { emitToRoom } = require('../lib/socket');
        emitToRoom('admin:alerts', 'SFX_ORDER_PLACEMENT_FAILED', { orderId: order.id, error: sfxErr.message });
      } catch (e) {
        // ignore socket emit errors
      }
    }

    res.json({ success: true, orderId: order.id });
  } catch (error) {
    console.error('[PAYMENT] CRITICAL Webhook processing error:', error.message);
    
    // Categorize errors for better frontend UX
    if (error.message.includes('VENDOR_CLOSED') || error.message.includes('VENDOR_OFFLINE')) {
        return res.status(403).json({ error: 'VENDOR_UNAVAILABLE', message: error.message });
    }
    if (error.message.includes('CART_INVALID')) {
        return res.status(400).json({ error: 'CART_ERROR', message: error.message });
    }

    res.status(500).json({ error: 'Failed to process payment verification', code: 'PAYMENT_PROCESSING_ERROR' });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// UPI deep-link payment confirmation (no PSP webhook).
// Customer endpoints open a UPI app and report/poll; the order is created ONLY
// by an authoritative confirm() (Admin reconciliation now, PSP/bank webhook later).
// ──────────────────────────────────────────────────────────────────────────
const upiPaymentService = require('../services/upiPaymentService');

// Service-to-service guard for the confirm/reject endpoints: only the Admin server
// (holding ADMIN_SECRET) or a future PSP webhook proxy may confirm a payment. Reuses
// the existing admin convention (X-Admin-Key header ↔ ADMIN_SECRET).
function requireAdminSecret(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'CONFIRM_DISABLED', message: 'ADMIN_SECRET not configured.' });
  const provided = req.headers['x-admin-key'] || req.headers['x-admin-secret'];
  if (provided !== secret) return res.status(401).json({ error: 'UNAUTHORIZED' });
  next();
}

function handleUpiError(res, error, fallback) {
  const status = error.status || 500;
  if (status >= 500) console.error('[UPI-ROUTE]', error.message);
  return res.status(status).json({ success: false, error: error.code || error.message, message: error.message || fallback });
}

// POST /payments/upi/initiate — create a PENDING request + return the deep-link pieces.
router.post('/upi/initiate', firebaseAuth, requireCustomer, guestSession, async (req, res) => {
  try {
    const { vendorId, addressId, deliveryPreference, deliveryFee, upiApp } = req.body || {};
    const out = await upiPaymentService.initiate({
      customerId: req.customer.id, guestId: req.guestId,
      vendorId, addressId, deliveryPreference, deliveryFee: Number(deliveryFee) || 0, upiApp,
    });
    res.json({ success: true, ...out });
  } catch (e) { handleUpiError(res, e, 'Failed to start UPI payment'); }
});

// POST /payments/upi/claim — customer reports the outcome after returning (provisional only).
router.post('/upi/claim', firebaseAuth, requireCustomer, guestSession, async (req, res) => {
  try {
    const { tr, clientStatus, utr } = req.body || {};
    if (!tr) return res.status(400).json({ success: false, message: 'tr is required' });
    const out = await upiPaymentService.claim({ tr, customerId: req.customer.id, guestId: req.guestId, clientStatus, utr });
    res.json({ success: true, ...out });
  } catch (e) { handleUpiError(res, e, 'Failed to record claim'); }
});

// GET /payments/upi/status?tr= — poll target for the customer screen.
router.get('/upi/status', firebaseAuth, requireCustomer, guestSession, async (req, res) => {
  try {
    const { tr } = req.query;
    if (!tr) return res.status(400).json({ success: false, message: 'tr is required' });
    const out = await upiPaymentService.getStatus({ tr, customerId: req.customer.id, guestId: req.guestId });
    res.json({ success: true, ...out });
  } catch (e) { handleUpiError(res, e, 'Failed to fetch status'); }
});

// POST /payments/upi/confirm — AUTHORITATIVE (admin / webhook). Creates the paid order.
router.post('/upi/confirm', requireAdminSecret, async (req, res) => {
  try {
    const { tr, utr, amount, source, actor } = req.body || {};
    if (!tr) return res.status(400).json({ success: false, message: 'tr is required' });
    const out = await upiPaymentService.confirm(tr, {
      utr, amount: amount != null ? Number(amount) : null,
      source: source || 'ADMIN_MANUAL', actor: actor || 'admin',
    });
    res.json({ success: true, ...out });
  } catch (e) { handleUpiError(res, e, 'Failed to confirm payment'); }
});

// POST /payments/upi/reject — admin marks a pending payment failed; unlocks the cart.
router.post('/upi/reject', requireAdminSecret, async (req, res) => {
  try {
    const { tr, reason, actor } = req.body || {};
    if (!tr) return res.status(400).json({ success: false, message: 'tr is required' });
    const out = await upiPaymentService.reject(tr, { reason, actor: actor || 'admin' });
    res.json({ success: true, ...out });
  } catch (e) { handleUpiError(res, e, 'Failed to reject payment'); }
});

module.exports = router;
