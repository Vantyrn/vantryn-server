const { prisma } = require('../../../../lib/prisma');
const validator = require('./shadowfax.validator');
const mapper = require('./shadowfax.mapper');
const logger = require('../../../../lib/logger');

class ShadowfaxWebhookHandler {
  /**
   * Handle incoming status callbacks.
   */
  async handleStatusCallback(rawPayload) {
    let validatedData;
    try {
      validatedData = validator.validateStatusCallback(rawPayload);
    } catch (error) {
      logger.error(`[Shadowfax Webhook] Validation failed for status callback: ${error.message}`);
      throw new Error('Invalid payload');
    }

    const coid = validatedData.coid || validatedData.client_order_id;
    if (!coid) {
      logger.error('[Shadowfax Webhook] Missing coid/client_order_id in status callback');
      throw new Error('Missing client order identifier');
    }

    // Find the corresponding local SFX order
    let sfxOrder;
    try {
      sfxOrder = await prisma.sfxOrder.findFirst({
        where: { clientOrderId: coid }
      });
    } catch (err) {
      logger.error(`[Shadowfax Webhook] Failed DB query for clientOrderId ${coid}: ${err.message}`);
    }

    if (!sfxOrder) {
      logger.warn(`[Shadowfax Webhook] No matching SFX order found for clientOrderId: ${coid}. Skipping callback.`);
      return { skipped: true, reason: 'Order not found' };
    }

    const resolvedSfxOrderId = validatedData.sfx_order_id || sfxOrder.sfxOrderId;

    // Idempotency Check
    try {
      const existingCallbacks = await prisma.sfxCallback.findMany({
        where: {
          sfxOrderId: resolvedSfxOrderId,
          processed: true
        }
      });
      const isDuplicate = existingCallbacks.some(cb => cb.payload && cb.payload.status === validatedData.status);
      if (isDuplicate) {
        logger.info(`[Shadowfax Webhook] Duplicate status callback received for SFX Order ${resolvedSfxOrderId}: ${validatedData.status}. Skipping.`);
        return { duplicate: true };
      }
    } catch (err) {
      logger.error(`[Shadowfax Webhook] Failed to perform idempotency check: ${err.message}`);
    }

    // Save callback record
    let dbRecordId;
    try {
      const dbRecord = await prisma.sfxCallback.create({
        data: {
          sfxOrderId: resolvedSfxOrderId,
          payload: rawPayload,
          processed: false
        }
      });
      dbRecordId = dbRecord.id;
    } catch (error) {
      logger.error(`[Shadowfax Webhook] Failed to save raw status payload: ${error.message}`);
    }

    const internalStatus = mapper.mapSfxStatusToInternal(validatedData.status);
    
    // Call DeliveryService to update internal order state
    try {
      const deliveryService = require('../delivery.service');
      await deliveryService.processSfxStatusUpdate({
        sfxOrderId: resolvedSfxOrderId.toString(),
        internalStatus,
        dbCallbackId: dbRecordId
      });
    } catch (e) {
      logger.error(`[Shadowfax Webhook] Failed to process status via DeliveryService: ${e.message}`);
    }

    // Flash status callbacks often contain live coordinates. If present, save and broadcast them!
    if (typeof validatedData.rider_latitude === 'number' && typeof validatedData.rider_longitude === 'number') {
      try {
        await prisma.sfxRiderLocationLog.create({
          data: {
            sfxOrderId: resolvedSfxOrderId,
            lat: validatedData.rider_latitude,
            lng: validatedData.rider_longitude,
            pickupEta: validatedData.pickup_eta || null,
            dropEta: validatedData.drop_eta || null
          }
        });

        const { emitLocationUpdate } = require('../../../../lib/socket');
        emitLocationUpdate(
          sfxOrder.internalOrderId,
          validatedData.rider_latitude,
          validatedData.rider_longitude,
          validatedData.pickup_eta,
          validatedData.drop_eta,
          sfxOrder.order ? sfxOrder.order.vendorId : null
        );
      } catch (locErr) {
        logger.error(`[Shadowfax Webhook] Failed to save/emit status-bound rider location: ${locErr.message}`);
      }
    }

    return {
      internalStatus,
      sfxOrderId: resolvedSfxOrderId.toString(),
      clientOrderId: coid,
      dbCallbackId: dbRecordId
    };
  }

  /**
   * Handle incoming location callbacks.
   */
  async handleLocationCallback(rawPayload) {
    let validatedData;
    try {
      validatedData = validator.validateLocationCallback(rawPayload);
    } catch (error) {
      logger.error(`[Shadowfax Webhook] Validation failed for location callback: ${error.message}`);
      throw new Error('Invalid payload');
    }

    const coid = validatedData.coid || validatedData.client_order_id;
    if (!coid) {
      logger.error('[Shadowfax Webhook] Missing coid/client_order_id in location callback');
      throw new Error('Missing client order identifier');
    }

    try {
      const sfxOrder = await prisma.sfxOrder.findFirst({
        where: { clientOrderId: coid },
        include: { order: true }
      });

      if (!sfxOrder) {
        logger.warn(`[Shadowfax Webhook] No matching SFX order found for location clientOrderId: ${coid}`);
        return { skipped: true, reason: 'Order not found' };
      }

      const resolvedSfxOrderId = validatedData.sfx_order_id || sfxOrder.sfxOrderId;

      await prisma.sfxRiderLocationLog.create({
        data: {
          sfxOrderId: resolvedSfxOrderId,
          lat: validatedData.rider_latitude,
          lng: validatedData.rider_longitude,
          pickupEta: validatedData.pickup_eta || null,
          dropEta: validatedData.drop_eta || null
        }
      });

      if (sfxOrder.order) {
        const { emitLocationUpdate } = require('../../../../lib/socket');
        emitLocationUpdate(
          sfxOrder.internalOrderId,
          validatedData.rider_latitude,
          validatedData.rider_longitude,
          validatedData.pickup_eta,
          validatedData.drop_eta,
          sfxOrder.order.vendorId
        );
      }
    } catch (error) {
      logger.error(`[Shadowfax Webhook] Failed to save location log or emit: ${error.message}`);
    }

    return {
      lat: validatedData.rider_latitude,
      lng: validatedData.rider_longitude,
      orderId: coid,
      pickupEta: validatedData.pickup_eta,
      dropEta: validatedData.drop_eta
    };
  }
}

module.exports = new ShadowfaxWebhookHandler();


