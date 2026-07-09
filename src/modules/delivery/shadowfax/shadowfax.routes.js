const express = require('express');
const router = express.Router();
const webhookHandler = require('./shadowfax.webhook');
const env = require('../../../config/env');

// Validate the secret Shadowfax sends in the Authorization header of its webhook calls.
// We accept EITHER a dedicated SFX_WEBHOOK_SECRET or the active API token (Shadowfax may reuse
// the same token value on its callbacks). The header may be raw ("Vantyrn_Secure_2026") or
// scheme-prefixed ("Bearer …" / "Token …"). If neither is configured we do NOT enforce (dev
// convenience) but log loudly.
function validateWebhookSecret(req, res, next) {
  const accepted = [env.SFX_WEBHOOK_SECRET, env.SFX_ACTIVE_TOKEN].filter(Boolean);
  if (accepted.length === 0) {
    console.warn('[Shadowfax Webhook] No SFX_WEBHOOK_SECRET / token set — accepting webhook WITHOUT verification (dev only).');
    return next();
  }
  const authHeader = (req.headers['authorization'] || '').trim();
  const bare = authHeader.replace(/^(Bearer|Token)\s+/i, '');
  if (accepted.includes(authHeader) || accepted.includes(bare)) {
    return next();
  }
  console.warn('[Shadowfax Webhook] Unauthorized attempt (bad/missing Authorization).');
  return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * POST /webhooks/shadowfax/status
 * Receives order status updates from Shadowfax.
 * MUST always return 200 OK immediately unless auth fails.
 */
router.post('/status', validateWebhookSecret, async (req, res) => {
  // 1. Immediately respond to acknowledge receipt
  res.status(200).json({ success: true, message: 'Webhook received' });

  // 2. Process asynchronously
  try {
    const result = await webhookHandler.handleStatusCallback(req.body);
    console.log(`[Shadowfax Webhook] Successfully processed status update: SFX Order ${result.sfxOrderId} -> ${result.internalStatus}`);
  } catch (error) {
    console.error(`[Shadowfax Webhook] Error processing status webhook: ${error.message}`);
    // Here we would typically queue the failed payload to a Dead Letter Queue or retry system
  }
});

/**
 * POST /webhooks/shadowfax/location
 * Receives rider location updates from Shadowfax.
 * MUST always return 200 OK.
 */
router.post('/location', validateWebhookSecret, async (req, res) => {
  // 1. Immediately respond to acknowledge receipt
  res.status(200).json({ success: true, message: 'Location webhook received' });

  // 2. Process asynchronously
  try {
    const result = await webhookHandler.handleLocationCallback(req.body);
    console.log(`[Shadowfax Webhook] Processed location update for Order ${result.orderId}: [${result.lat}, ${result.lng}]`);
  } catch (error) {
    console.error(`[Shadowfax Webhook] Error processing location webhook: ${error.message}`);
  }
});

module.exports = router;
