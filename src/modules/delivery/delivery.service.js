const shadowfaxService = require('./shadowfax/shadowfax.service');
const mapper = require('./shadowfax/shadowfax.mapper');
const env = require('../../config/env');
const logger = require('../../../lib/logger');
const { prisma } = require('../../../lib/prisma');

// Sandbox rider simulation pacing. Default 3× the base delays (~2 min end-to-end)
// so each phase (assigned → at store → picked up → arrived → delivered) is long
// enough to observe and switch between the customer/vendor apps. Tune via
// SFX_SIM_SCALE (e.g. 4-5 for slower, 1 for the original ~38s).
const SIM_SCALE = Number(process.env.SFX_SIM_SCALE) || 3;

/**
 * Orchestration layer for Delivery operations.
 * Isolates the core modules (Orders, Vendors) from the specific 3PL implementation (Shadowfax).
 */
class DeliveryService {
  /**
   * Initiates the delivery process post-payment.
   * @param {string} orderId
   * @returns {Promise<void>}
   */
  async initiateDelivery(orderId) {
    // Delivery mode is INDEPENDENT of the payment sandbox (placeholder payments can drive
    // either a REAL Shadowfax order or the local simulator). See env.SFX_DELIVERY_MODE.
    if (!env.SFX_LIVE) {
      logger.info(`[DeliveryService] SIMULATE mode: registering a local SFX order for ${orderId} (no Shadowfax call).`);

      const mockSfxId = BigInt(Math.floor(Math.random() * 90000000) + 10000000);
      const mockCoid = `SFX-SIM-${orderId.substring(0, 8)}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

      try {
        await prisma.sfxOrder.upsert({
          where: { internalOrderId: orderId },
          update: { sfxOrderId: mockSfxId, sfxStatus: 'ACCEPTED', clientOrderId: mockCoid },
          create: {
            internalOrderId: orderId,
            sfxOrderId: mockSfxId,
            storeCode: env.SFX_ACTIVE_CLIENT_CODE || 'SIMULATED',
            clientOrderId: mockCoid,
            sfxStatus: 'ACCEPTED'
          }
        });
        await prisma.order.update({ where: { id: orderId }, data: { sfxOrderId: mockSfxId } });
        logger.info(`[DeliveryService] Simulated SFX order registered for ${orderId}`);
      } catch (err) {
        logger.error(`[DeliveryService] Failed to create simulated SfxOrder: ${err.message}`);
      }
      return;
    }

    // ── LIVE: place a real Shadowfax Marketplace order ──────────────────────────
    logger.info(`[DeliveryService] LIVE mode: placing real Shadowfax order for ${orderId}`);
    try {
      // IDEMPOTENCY GUARD. Shadowfax does NOT dedupe `client_order_id`: re-POSTing the same COID
      // returns 201 and books a SECOND rider (billed twice). So we never retry order-create —
      // if this internal order already has an sfx_order, we stop here.
      const existing = await prisma.sfxOrder.findUnique({ where: { internalOrderId: orderId } });
      if (existing?.sfxOrderId) {
        logger.warn(`[DeliveryService] Order ${orderId} already placed (sfx_order_id=${existing.sfxOrderId}); skipping duplicate placement.`);
        return;
      }

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { items: true, customer: true, vendor: true }
      });
      if (!order) throw new Error('Order not found');
      if (order.vendor?.latitude == null || order.vendor?.longitude == null) {
        throw new Error(`Vendor ${order.vendorId} has no coordinates; cannot place a live delivery.`);
      }

      const { payload, clientOrderId } = mapper.buildPlaceOrderPayload(order, order.vendor, order.customer);
      const sfx = await shadowfaxService.placeOrder(payload);

      await prisma.sfxOrder.create({
        data: {
          internalOrderId: order.id,
          sfxOrderId: BigInt(sfx.sfxOrderId),
          // Marketplace has no store_code; we keep the account-level client_code in this column.
          storeCode: env.SFX_ACTIVE_CLIENT_CODE || 'MARKETPLACE',
          clientOrderId,
          sfxStatus: sfx.status,
          trackUrl: sfx.trackUrl,
          deliveryCost: sfx.deliveryCost
        }
      });

      await prisma.order.update({
        where: { id: order.id },
        data: { sfxOrderId: BigInt(sfx.sfxOrderId) }
      });

      logger.info(`[DeliveryService] Live delivery placed for order ${orderId}, sfx_order_id=${sfx.sfxOrderId}`);
    } catch (error) {
      logger.error(`[DeliveryService] Error initiating live delivery for order ${orderId}: ${error.message}`);
      this._emitAdminError(orderId, error);
      throw error;
    }
  }

  /**
   * Attempts to cancel an ongoing delivery.
   * @param {string} orderId
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async cancelDelivery(orderId, reason) {
    logger.info(`[DeliveryService] cancelDelivery called for order ${orderId} with reason: ${reason}`);
    try {
      const sfxOrder = await prisma.sfxOrder.findUnique({ where: { internalOrderId: orderId } });
      if (!sfxOrder) {
        logger.info(`[DeliveryService] No SFX order found for internal order ${orderId}, skipping 3PL cancel.`);
        return;
      }

      const cancelPayload = mapper.mapCancelReasonToSfx(reason, 'Seller');
      await shadowfaxService.cancelOrder({
        sfxOrderId: sfxOrder.sfxOrderId.toString(),
        reason: cancelPayload.reason,
        user: cancelPayload.user
      });
      logger.info(`[DeliveryService] successfully cancelled delivery for order ${orderId}`);
    } catch (error) {
      logger.warn(`[DeliveryService] Failed to cancel delivery for order ${orderId} on SFX: ${error.message}`);
      this._emitAdminError(orderId, error);
    }
  }

  /**
   * Triggers the 3PL dispatch signal when the vendor marks the order ready.
   * @param {string} orderId
   * @returns {Promise<void>}
   */
  async onVendorReadyForPickup(orderId) {
    logger.info(`[DeliveryService] onVendorReadyForPickup called for order ${orderId}`);

    if (!env.SFX_LIVE) {
      logger.info(`[DeliveryService] SIMULATE mode: driving the rider simulation for ${orderId}`);
      this.startSandboxRiderSimulation(orderId);
      return;
    }

    try {
      const sfxOrder = await prisma.sfxOrder.findUnique({ where: { internalOrderId: orderId } });
      if (!sfxOrder) {
        logger.info(`[DeliveryService] No SFX order found for internal order ${orderId}, skipping 3PL dispatch.`);
        return;
      }
      
      const shipmentReadyTimestamp = new Date().toISOString();
      await shadowfaxService.markDispatchReady({
        coid: sfxOrder.clientOrderId,
        shipmentReadyTimestamp
      });
      logger.info(`[DeliveryService] successfully sent dispatch ready signal for order ${orderId}`);
    } catch (error) {
      logger.warn(`[DeliveryService] Failed to send dispatch ready signal for order ${orderId}: ${error.message}`);
      this._emitAdminError(orderId, error);
    }
  }

  /**
   * Processes status updates received via Shadowfax webhooks.
   */
  async processSfxStatusUpdate({ sfxOrderId, internalStatus, sfxStatusRaw, rider, dbCallbackId }) {
    logger.info(`[DeliveryService] Processing status update for SFX Order ${sfxOrderId}: ${sfxStatusRaw || '?'} -> ${internalStatus || '(no internal change)'}`);
    try {
      const sfxOrder = await prisma.sfxOrder.findUnique({
        where: { sfxOrderId: BigInt(sfxOrderId) }
      });

      if (!sfxOrder) {
        logger.warn(`[DeliveryService] Could not find internal order mapped to SFX order ${sfxOrderId}`);
        return;
      }

      // Always record what Shadowfax told us — even when it maps to no internal change
      // (e.g. ACCEPTED, which means "booked, no rider yet" and must NOT touch Order.status).
      if (sfxStatusRaw || internalStatus) {
        await prisma.sfxOrder.update({
          where: { internalOrderId: sfxOrder.internalOrderId },
          data: { sfxStatus: sfxStatusRaw || internalStatus }
        });
      }

      if (internalStatus) {
        const OrderService = require('../../../services/orderService');
        const updated = await OrderService.updateOrderStatus(sfxOrder.internalOrderId, internalStatus, 'SYSTEM');

        // Re-emit the status WITH rider identity so the customer can show who is delivering
        // (the OrderService emit above carries no rider; this is idempotent for the UI).
        if (rider && (rider.name || rider.phone)) {
          try {
            const { emitOrderStatusUpdate } = require('../../../lib/socket');
            emitOrderStatusUpdate(sfxOrder.internalOrderId, internalStatus, 'SYSTEM', updated?.vendorId || null, rider);
          } catch (emitErr) {
            logger.warn(`[DeliveryService] Failed to re-emit status with rider: ${emitErr.message}`);
          }
        }
      }

      if (dbCallbackId) {
        await prisma.sfxCallback.update({
          where: { id: dbCallbackId },
          data: { processed: true }
        });
      }
    } catch (error) {
      logger.error(`[DeliveryService] Failed to process status update for SFX Order ${sfxOrderId}: ${error.message}`);
      this._emitAdminError(null, error);
      throw error;
    }
  }

  _emitAdminError(orderId, error) {
    try {
      const { getIo } = require('../../../lib/socket');
      const io = getIo();
      if (io) {
        io.of('/admin').to('admin_global').emit('sfx_error', {
          orderId: orderId || 'UNKNOWN',
          errorCode: error.code || 'UNKNOWN_ERROR',
          message: error.message,
          timestamp: new Date().toISOString()
        });
      }
    } catch (socketErr) {
      logger.error(`[DeliveryService] Failed to emit admin error: ${socketErr.message}`);
    }
  }

  /**
   * Simulates rider progress for sandbox testing.
   * Generates a progressive coordinates path and status changes.
   */
  async startSandboxRiderSimulation(orderId) {
    logger.info(`[SandboxRider] Initializing high-fidelity GPS simulation for order ${orderId}`);
    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { vendor: true }
      });
      if (!order) {
        logger.error(`[SandboxRider] Order ${orderId} not found for simulation`);
        return;
      }

      const sfxOrder = await prisma.sfxOrder.findUnique({
        where: { internalOrderId: orderId }
      });
      const sfxOrderId = sfxOrder ? sfxOrder.sfxOrderId : BigInt(Math.floor(Math.random() * 90000000) + 10000000);

      const vendor = order.vendor;
      const vendorId = order.vendorId;

      // Synthetic rider identity so the customer UI can show a name/phone during simulation.
      const simRider = { name: 'Ravi (Simulated)', phone: '9999900000', id: 'SIM-RIDER-1' };

      // Extract coordinates (default to Delhi coordinates if missing)
      const vendorLat = Number(vendor?.latitude) || 28.6304;
      const vendorLng = Number(vendor?.longitude) || 77.2177;

      const addressSnapshot = order.addressSnapshot || {};
      const dropLat = Number(addressSnapshot.latitude) || 28.6448;
      const dropLng = Number(addressSnapshot.longitude) || 77.1873;

      // Spawn Rider starting location (~1.5 km away from Store)
      const riderStartLat = vendorLat + 0.011;
      const riderStartLng = vendorLng - 0.011;

      const simulationSteps = [
        // PHASE 1: Rider assigned and moving to store
        { status: 'RIDER_ASSIGNED', lat: riderStartLat, lng: riderStartLng, pickupEta: 8, dropEta: null, delay: 0 },
        { status: 'RIDER_ASSIGNED', lat: riderStartLat * 0.75 + vendorLat * 0.25, lng: riderStartLng * 0.75 + vendorLng * 0.25, pickupEta: 6, dropEta: null, delay: 4000 },
        { status: 'RIDER_ASSIGNED', lat: riderStartLat * 0.50 + vendorLat * 0.50, lng: riderStartLng * 0.50 + vendorLng * 0.50, pickupEta: 4, dropEta: null, delay: 8000 },
        { status: 'RIDER_ASSIGNED', lat: riderStartLat * 0.25 + vendorLat * 0.75, lng: riderStartLng * 0.25 + vendorLng * 0.75, pickupEta: 2, dropEta: null, delay: 12000 },
        
        // PHASE 2: Rider arrived at store
        { status: 'RIDER_AT_STORE', lat: vendorLat, lng: vendorLng, pickupEta: 0, dropEta: null, delay: 16000 },
        
        // PHASE 3: Rider picks up product and goes towards customer
        { status: 'picked_up', lat: vendorLat, lng: vendorLng, pickupEta: null, dropEta: 12, delay: 22000 },
        { status: 'picked_up', lat: vendorLat * 0.66 + dropLat * 0.34, lng: vendorLng * 0.66 + dropLng * 0.34, pickupEta: null, dropEta: 8, delay: 26000 },
        { status: 'picked_up', lat: vendorLat * 0.33 + dropLat * 0.67, lng: vendorLng * 0.33 + dropLng * 0.67, pickupEta: null, dropEta: 4, delay: 30000 },
        
        // PHASE 4: Rider arrives at customer doorstep
        { status: 'arrived_at_customer', lat: dropLat, lng: dropLng, pickupEta: null, dropEta: 1, delay: 34000 },
        
        // PHASE 5: Order delivered
        { status: 'delivered', lat: dropLat, lng: dropLng, pickupEta: null, dropEta: 0, delay: 38000 }
      ];

      for (const step of simulationSteps) {
        setTimeout(async () => {
          try {
            // Check if order has been cancelled mid-simulation
            const currentOrder = await prisma.order.findUnique({ where: { id: orderId } });
            if (!currentOrder || ['CANCELLED', 'ORDER_CANCELLED', 'CANCELLED_BY_VENDOR'].includes(currentOrder.status.toUpperCase())) {
              logger.info(`[SandboxRider] Order ${orderId} cancelled. Stopping simulation.`);
              return;
            }

            logger.info(`[SandboxRider] Order ${orderId} - Step Status: ${step.status}, Location: [${step.lat.toFixed(5)}, ${step.lng.toFixed(5)}], ETA: P:${step.pickupEta} D:${step.dropEta}`);

            // 1. Log Location in DB, and persist a callback row shaped exactly like a real
            //    Shadowfax callback. Sockets only reach clients already listening — a screen
            //    opened late seeds rider identity from sfx_callbacks (see lib/sfxTracking.js),
            //    so the simulator must leave the same trail the live integration does.
            try {
              await prisma.sfxRiderLocationLog.create({
                data: {
                  sfxOrderId: sfxOrderId,
                  lat: step.lat,
                  lng: step.lng,
                  pickupEta: step.pickupEta,
                  dropEta: step.dropEta
                }
              });
              await prisma.sfxCallback.create({
                data: {
                  sfxOrderId: sfxOrderId,
                  processed: true,
                  payload: {
                    order_status: step.status,
                    client_order_id: orderId,
                    rider_name: simRider.name,
                    rider_contact: simRider.phone,
                    rider_id: simRider.id,
                    rider_latitude: step.lat,
                    rider_longitude: step.lng,
                    pickup_eta: step.pickupEta,
                    drop_eta: step.dropEta
                  }
                }
              });
            } catch (dbErr) {
              logger.error(`[SandboxRider] Failed to log coordinates/callback: ${dbErr.message}`);
            }

            // 2. If status changes, update database and emit updates
            const statusChanged = currentOrder.status !== step.status;
            if (statusChanged) {
              const OrderService = require('../../../services/orderService');
              await OrderService.updateOrderStatus(orderId, step.status, 'SYSTEM');

              await prisma.sfxOrder.updateMany({
                where: { internalOrderId: orderId },
                data: { sfxStatus: step.status }
              });
            }

            // 3. Emit live coordinate updates. Customer sees location the whole time; the vendor
            //    only receives coordinates PRE-PICKUP (RIDER_ASSIGNED / RIDER_AT_STORE), then status-only.
            const { emitLocationUpdate } = require('../../../lib/socket');
            const vendorIdForEmit = mapper.isPrePickupInternalStatus(step.status) ? vendorId : null;
            emitLocationUpdate(orderId, step.lat, step.lng, step.pickupEta, step.dropEta, vendorIdForEmit, simRider);

          } catch (stepErr) {
            logger.error(`[SandboxRider] Error in step execution for ${orderId}: ${stepErr.message}`);
          }
        }, step.delay * SIM_SCALE);
      }

    } catch (err) {
      logger.error(`[SandboxRider] Simulation failure for order ${orderId}: ${err.message}`);
    }
  }
}

module.exports = new DeliveryService();


