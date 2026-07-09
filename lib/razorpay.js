const crypto = require('crypto');

// Razorpay payment signature verification (HMAC-SHA256).
// After checkout, Razorpay returns razorpay_order_id, razorpay_payment_id and
// razorpay_signature. The server MUST recompute the HMAC with the key secret and
// match it before trusting that a payment actually succeeded — otherwise a client
// can fake a success and get a free order.
// Ref: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/build-integration/#verify-payment-signature
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) throw new Error('RAZORPAY_KEY_SECRET is not configured');
  if (!orderId || !paymentId || !signature) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  // Constant-time comparison to avoid leaking validity via timing.
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { verifyPaymentSignature };
