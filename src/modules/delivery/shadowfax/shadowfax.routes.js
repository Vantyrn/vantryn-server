const express = require('express');
const router = express.Router();
const webhookHandler = require('./shadowfax.webhook');
const env = require('../../../config/env');

// Simple middleware to validate shared secret if provided
function validateWebhookSecret(req, res, next) {
  if (env.SFX_WEBHOOK_SECRET) {
    const authHeader = req.headers['authorization'];
    // In a real scenario, this might be an HMAC signature verification
    // For now, simple token match if specified
    if (!authHeader || authHeader !== `Bearer ${env.SFX_WEBHOOK_SECRET}`) {
      console.warn('[Shadowfax Webhook] Unauthorized attempt');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  next();
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
