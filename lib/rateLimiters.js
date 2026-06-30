// Shared rate limiters (industry-standard abuse / brute-force protection).
// Keyed by client IP — requires app.set('trust proxy', 1) so the real device IP
// (X-Forwarded-For from Railway's proxy) is used, not the proxy's. Limits are
// sized for the pilot (a handful of vendors/customers, Android-first); revisit
// before scaling. The telemetry route keeps its own dedicated limiter.
const rateLimit = require('express-rate-limit');

const body = (message) => ({ error: message, code: 'rate_limited' });

const common = {
  windowMs: 60 * 1000,
  standardHeaders: true, // RateLimit-* headers
  legacyHeaders: false,
};

// Auth / identity endpoints — tightest. Stops credential/OTP brute-force and
// abusive re-sync loops. (OTP SMS itself is sent by Firebase, not this server.)
const authLimiter = rateLimit({
  ...common,
  max: 20,
  message: body('Too many attempts. Please wait a minute and try again.'),
});

// Payment verification — money path. Tight, but allows legitimate retries.
const paymentLimiter = rateLimit({
  ...common,
  max: 30,
  message: body('Too many payment attempts. Please wait and retry.'),
});

// General API guardrail — generous; only catches runaways / scraping. The vendor
// dashboard polls a few endpoints, so this is well above normal per-device load.
const apiLimiter = rateLimit({
  ...common,
  max: 600,
  message: body('Too many requests. Please slow down.'),
});

module.exports = { authLimiter, paymentLimiter, apiLimiter };
