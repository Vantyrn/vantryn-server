// Mobile telemetry ingest (workflow §4.5).
// The Customer & Vendor Expo apps batch key events / API failures and POST them
// here so device logs land in the same central sink as backend logs, joined by
// the shared x-request-id. Auth-optional (guests log too) and rate-limited.
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const logger = require('../lib/logger');
const firebaseAuthOptional = require('../middleware/auth_optional');
const { runWithContext } = require('../lib/logContext');

const ALLOWED_LEVELS = new Set(['error', 'warn', 'info', 'debug']);
const ALLOWED_SERVICES = new Set(['customer', 'vendor']);
const MAX_BATCH = 50;

// Generous but bounded — a misbehaving device can't flood the sink.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // batches per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many telemetry requests' },
});

// POST /api/telemetry/logs
// Body: { service, releaseVersion?, logs: [{ level, message, screen?, orderId?, requestId?, ts?, ...meta }] }
router.post('/logs', limiter, firebaseAuthOptional, (req, res) => {
  const { service, logs, releaseVersion } = req.body || {};

  if (!ALLOWED_SERVICES.has(service)) {
    return res.status(400).json({ error: 'invalid service' });
  }
  if (!Array.isArray(logs) || logs.length === 0) {
    return res.status(400).json({ error: 'logs must be a non-empty array' });
  }

  const batch = logs.slice(0, MAX_BATCH);
  const userId = req.user && (req.user.uid || req.user.user_id || req.user.sub);

  for (const entry of batch) {
    const level = ALLOWED_LEVELS.has(entry && entry.level) ? entry.level : 'info';
    const { message, level: _l, requestId, orderId, role, screen, ...meta } = entry || {};

    // Run inside a context so the logger stamps device-supplied correlation ids;
    // service is forced to the device's value (overriding the backend's "server").
    runWithContext(
      { requestId, userId, orderId: orderId != null ? String(orderId) : undefined, role },
      () => {
        logger.log(level, `[${service}] ${message || 'client.event'}`, {
          ...meta,
          service, // mobile origin, not the backend
          screen,
          clientReleaseVersion: releaseVersion,
          source: 'mobile-telemetry',
        });
      }
    );
  }

  res.status(202).json({ accepted: batch.length });
});

module.exports = router;
