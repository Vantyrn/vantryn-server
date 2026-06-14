// Error & crash tracking via GlitchTip (Sentry-API-compatible) — workflow §4.5.
// We use the standard @sentry/node SDK and point the DSN at GlitchTip; if funds
// ever appear, the identical code points at Sentry's own tier (env change only).
const Sentry = require('@sentry/node');
const { redact } = require('./redact');
const { getContext } = require('./logContext');

let initialized = false;

function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.warn('[SENTRY] SENTRY_DSN not set — error tracking disabled (errors will only hit logs).');
    return false;
  }
  try {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.RELEASE_VERSION || 'dev',
      // GlitchTip free tier: no performance tracing/profiling, just errors.
      tracesSampleRate: 0,
      // Final safety net so no secret/PII reaches the error sink.
      beforeSend(event) {
        try {
          if (event.request && event.request.headers) {
            event.request.headers = redact(event.request.headers);
          }
          if (event.request && event.request.data) {
            event.request.data = redact(event.request.data);
          }
          if (event.extra) event.extra = redact(event.extra);
          if (event.contexts) event.contexts = redact(event.contexts);
        } catch (_) { /* never let scrubbing break delivery */ }
        return event;
      },
    });
    initialized = true;
    console.log('✅ [SENTRY] GlitchTip error tracking initialized.');
    return true;
  } catch (err) {
    console.error('[SENTRY] init failed:', err.message);
    return false;
  }
}

/**
 * Capture an exception with the current request correlation context attached,
 * so an error in GlitchTip can be cross-referenced with logs by requestId/orderId.
 */
function captureException(err, extra = {}) {
  if (!initialized) return;
  try {
    const ctx = getContext();
    Sentry.withScope((scope) => {
      if (ctx.userId) scope.setUser({ id: String(ctx.userId), role: ctx.role });
      if (ctx.requestId) scope.setTag('requestId', ctx.requestId);
      if (ctx.orderId) scope.setTag('orderId', String(ctx.orderId));
      const merged = redact({ ...ctx, ...extra });
      scope.setContext('vantryn', merged);
      Sentry.captureException(err);
    });
  } catch (_) { /* swallow */ }
}

function isInitialized() {
  return initialized;
}

module.exports = { Sentry, initSentry, captureException, isInitialized };
