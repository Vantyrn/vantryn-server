const { prisma } = require('../../../../lib/prisma');
const validator = require('./shadowfax.validator');
const mapper = require('./shadowfax.mapper');
const logger = require('../../../../lib/logger');

class ShadowfaxWebhookHandler {
  /**
   * Handle incoming status callbacks (order lifecycle: ALLOTTED → ARRIVED → DISPATCHED → DELIVERED …).
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

    let sfxOrder;
    try {
      sfxOrder = await prisma.sfxOrder.findFirst({
        where: { clientOrderId: coid },
        include: { order: true }
      });
    } catch (err) {
      logger.error(`[Shadowfax Webhook] Failed DB query for clientOrderId ${coid}: ${err.message}`);
    }

    if (!sfxOrder) {
      logger.warn(`[Shadowfax Webhook] No matching SFX order found for clientOrderId: ${coid}. Skipping callback.`);
      return { skipped: true, reason: 'Order not found' };
    }

    const resolvedSfxOrderId = validatedData.sfx_order_id || sfxOrder.sfxOrderId;

    // Idempotency Check — skip a repeat of the same status.
    try {
      const existingCallbacks = await prisma.sfxCallback.findMany({
        where: { sfxOrderId: resolvedSfxOrderId, processed: true }
      });
      // Marketplace sends `order_status`; older payloads sent `status`. Compare against both.
      const isDuplicate = existingCallbacks.some(
        cb => cb.payload && (cb.payload.status || cb.payload.order_status) === validatedData.status
      );
      if (isDuplicate) {
        logger.info(`[Shadowfax Webhook] Duplicate status callback for SFX Order ${resolvedSfxOrderId}: ${validatedData.status}. Skipping.`);
        return { duplicate: true };
      }
    } catch (err) {
      logger.error(`[Shadowfax Webhook] Failed idempotency check: ${err.message}`);
    }

    // Persist the raw payload (also our source of rider identity for the tracking endpoint).
    let dbRecordId;
    try {
      const dbRecord = await prisma.sfxCallback.create({
        data: { sfxOrderId: resolvedSfxOrderId, payload: rawPayload, processed: false }
      });
      dbRecordId = dbRecord.id;
    } catch (error) {
      logger.error(`[Shadowfax Webhook] Failed to save raw status payload: ${error.message}`);
    }

    const internalStatus = mapper.mapSfxStatusToInternal(validatedData.status);
    const rider = mapper.extractRider(validatedData);

    // Update internal order state + notify all parties (customer/vendor/admin sockets).
    try {
      const deliveryService = require('../delivery.service');
      await deliveryService.processSfxStatusUpdate({
        sfxOrderId: resolvedSfxOrderId.toString(),
        internalStatus,                       // null for ACCEPTED / unknown → Order.status untouched
        sfxStatusRaw: validatedData.status,
        rider,
        dbCallbackId: dbRecordId
      });
    } catch (e) {
      logger.error(`[Shadowfax Webhook] Failed to process status via DeliveryService: ${e.message}`);
    }

    // Flash/store status callbacks often include live coordinates — save + broadcast them.
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

        // Vendor gets live location ONLY until pickup. `internalStatus` is null for events that
        // carry no state change (e.g. ACCEPTED), so fall back to the order's current status.
        const effectiveStatus = internalStatus || sfxOrder.order?.status;
        const vendorIdForEmit = mapper.isPrePickupOrderStatus(effectiveStatus)
          ? (sfxOrder.order?.vendorId ?? null)
          : null;

        const { emitLocationUpdate } = require('../../../../lib/socket');
        emitLocationUpdate(
          sfxOrder.internalOrderId,
          validatedData.rider_latitude,
          validatedData.rider_longitude,
          validatedData.pickup_eta,
          validatedData.drop_eta,
          vendorIdForEmit,
          rider
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
   * Handle incoming rider-location callbacks (periodic during the delivery run).
   */
  async handleLocationCallback(rawPayload) {
    let validatedData;
    try {
      validatedData = validator.validateLocationCallback(rawPayload);
    } catch (error) {
      logger.error(`[Shadowfax Webhook] Validation failed for location callback: ${error.message}`);
      throw new Error('Invalid payload');
    }

    const coid = validatedData.coid || validatedData.client_order_id || validatedData.order_id;
    if (!coid) {
      logger.error('[Shadowfax Webhook] Missing coid/order_id in location callback');
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
      const rider = mapper.extractRider(validatedData);

      await prisma.sfxRiderLocationLog.create({
        data: {
          sfxOrderId: resolvedSfxOrderId,
          lat: validatedData.rider_latitude,
          lng: validatedData.rider_longitude,
          pickupEta: validatedData.pickup_eta || null,
          dropEta: validatedData.drop_eta || null
        }
      });

      // Vendor receives coordinates only pre-pickup (decided by the order's current status).
      const vendorIdForEmit = (sfxOrder.order && mapper.isPrePickupOrderStatus(sfxOrder.order.status))
        ? sfxOrder.order.vendorId
        : null;

      const { emitLocationUpdate } = require('../../../../lib/socket');
      emitLocationUpdate(
        sfxOrder.internalOrderId,
        validatedData.rider_latitude,
        validatedData.rider_longitude,
        validatedData.pickup_eta,
        validatedData.drop_eta,
        vendorIdForEmit,
        rider
      );

      return {
        lat: validatedData.rider_latitude,
        lng: validatedData.rider_longitude,
        orderId: coid,
        pickupEta: validatedData.pickup_eta,
        dropEta: validatedData.drop_eta
      };
    } catch (error) {
      logger.error(`[Shadowfax Webhook] Failed to save location log or emit: ${error.message}`);
      return { skipped: true, reason: error.message };
    }
  }
}

module.exports = new ShadowfaxWebhookHandler();
