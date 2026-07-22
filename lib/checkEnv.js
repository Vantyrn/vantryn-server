// Loud boot-time environment assertions (workflow §4.5 / Phase 0).
// The backend previously degraded SILENTLY when secrets were missing (footgun #7):
//   - admin routes open if ADMIN_SECRET unset
//   - auth → mock if Firebase creds missing
//   - SLA timers no-op without REDIS_URL
// This makes those conditions impossible to miss: in production we refuse to boot
// on a missing security-critical secret; in development we warn loudly but continue.
const logger = require('./logger');

function checkEnv() {
  const isProd = process.env.NODE_ENV === 'production';

  // Security-critical: a missing value here is a vulnerability or a broken core.
  const securityCritical = {
    DATABASE_URL: process.env.DATABASE_URL,
    ADMIN_SECRET: process.env.ADMIN_SECRET,
    JWT_SECRET: process.env.JWT_SECRET,
    REDIS_URL: process.env.REDIS_URL,
  };
  const hasFirebase = Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY)
  );

  const missingCritical = Object.entries(securityCritical)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (!hasFirebase) missingCritical.push('FIREBASE_SERVICE_ACCOUNT (or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)');

  // Observability: required for the pilot, but never worth crashing the app over.
  const observability = {
    SENTRY_DSN: process.env.SENTRY_DSN,
    LOKI_URL: process.env.LOKI_URL,
    LOKI_USER: process.env.LOKI_USER,
    LOKI_API_KEY: process.env.LOKI_API_KEY,
  };
  const missingObs = Object.entries(observability).filter(([, v]) => !v).map(([k]) => k);

  // Demo footguns must be OFF in any non-dev build.
  if (process.env.DEV_BYPASS === 'on') {
    const msg = '🚨 DEV_BYPASS=on — demo footguns (mock auth tokens, test OTP, fake payment success) are ENABLED. This must be "off" in the pilot/staging build.';
    if (isProd) {
      // In production this is an auth-bypass vulnerability — refuse to boot rather
      // than serve traffic with mock auth / fake-payment acceptance enabled.
      logger.error('env.dev_bypass_on_in_production', { willExit: true });
      console.error('\n' + '='.repeat(72) + '\n' + msg + '\nRefusing to boot in production with DEV_BYPASS=on.\n' + '='.repeat(72) + '\n');
      process.exit(1);
    } else {
      logger.warn('env.dev_bypass_on', { note: 'fine for local dev' });
      console.warn(msg);
    }
  }

  // Sandbox payments accept client-asserted success without a real gateway charge.
  // Allowed for the pilot's Razorpay-test flow, but never silently in a live build.
  if (require('../src/config/env').SANDBOX_PAYMENTS && isProd) {
    logger.warn('env.sandbox_payments_on_in_production', {
      note: 'fake/test payments accepted — fine for the Razorpay-test pilot, MUST be off before taking real money',
    });
    console.warn('⚠️ [ENV] SANDBOX_PAYMENTS=on in production — test payments are accepted without a real charge. Turn off before going live.');
  }

  if (missingObs.length) {
    logger.error('env.observability_missing', { missing: missingObs });
    console.error(`⚠️ [ENV] Observability not fully configured (missing: ${missingObs.join(', ')}). Logs/errors may not reach the central sink.`);
  }

  if (missingCritical.length) {
    const banner = `❌ [ENV] Missing security-critical environment variables: ${missingCritical.join(', ')}`;
    logger.error('env.critical_missing', { missing: missingCritical, degraded: isProd });
    console.error('\n' + '='.repeat(72) + '\n' + banner);
    if (isProd) {
      // NOTE: this used to call process.exit(1). On Railway that killed the
      // process before it could bind $PORT / serve /health, so the deploy just
      // reported "1/1 replicas never became healthy" with no visible reason.
      // We now stay up in a DEGRADED state: the healthcheck passes and THIS
      // banner is visible in the deploy logs. The app is still insecure until
      // these are set (the affected subsystems — DB, admin auth, Firebase —
      // fail their own guards), so treat a degraded boot as broken until fixed.
      console.error('⚠️  Booting DEGRADED — set the variables above in Railway → Variables, then redeploy.\n' + '='.repeat(72) + '\n');
    } else {
      console.error('Running in development — continuing, but these MUST be set before the pilot.\n' + '='.repeat(72) + '\n');
    }
  } else {
    logger.info('env.check.ok', { env: process.env.NODE_ENV || 'development' });
  }
}

module.exports = checkEnv;
