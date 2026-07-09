const shadowfaxClient = require('./shadowfaxClient');
const logger = require('../../../../lib/logger');

/**
 * Shadowfax HL **Marketplace** API adapter.
 * Docs: https://sfxhlmarketplaceapi.docs.apiary.io/
 * Verified live against staging 2026-07-09 — see d:\Vantryn\DELIVERY_SHADOWFAX_INTEGRATION.md
 *
 * Endpoints:
 *   PUT  /api/v1/order-serviceability/          — serviceability + delivery cost
 *   POST /api/v2/orders/                        — place order  (doc says PUT; PUT returns 405)
 *   GET  /api/v2/orders/{sfx_order_id}/status/  — status pull
 *   PUT  /api/v2/orders/{sfx_order_id}/cancel/  — cancel
 *   PUT  /api/v2/orders/{coid}/dispatch-ready/  — dispatch-ready (keyed by CLIENT order id)
 *
 * Auth: `Authorization: Token <token>` (added by shadowfaxClient interceptor).
 * There is NO store_code in this model — one account-level `client_code`, pickup lat/lng per order.
 */

const ERROR_CODES = {
  SFX_API_ERROR: 'SFX_API_ERROR',
  SFX_CANCEL_FAILED: 'SFX_CANCEL_FAILED',
  SFX_ORDER_REJECTED: 'SFX_ORDER_REJECTED',
  SFX_SERVICE_UNAVAILABLE: 'SFX_SERVICE_UNAVAILABLE',
  SFX_TIMEOUT: 'SFX_TIMEOUT',
  SFX_VALIDATION_ERROR: 'SFX_VALIDATION_ERROR',
  SFX_INVALID_RESPONSE: 'SFX_INVALID_RESPONSE',
};

class AppError extends Error {
  constructor(message, code, statusCode = 500) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function handleSfxError(error, context) {
  if (error.response) {
    const status = error.response.status;
    const msg = error.response.data?.message || error.response.data?.detail || JSON.stringify(error.response.data);
    let code = ERROR_CODES.SFX_API_ERROR;
    if (status === 400) code = context === 'cancelOrder' ? ERROR_CODES.SFX_CANCEL_FAILED : ERROR_CODES.SFX_ORDER_REJECTED;
    else if (status >= 500) code = ERROR_CODES.SFX_SERVICE_UNAVAILABLE;
    logger.error(`[Shadowfax] ${context} failed (${status}): ${msg}`);
    throw new AppError(`Shadowfax ${context}: ${msg}`, code, status);
  }
  if (error.code === 'ECONNABORTED') {
    logger.error(`[Shadowfax] ${context} timed out`);
    throw new AppError(`Shadowfax ${context} timed out`, ERROR_CODES.SFX_TIMEOUT, 504);
  }
  logger.error(`[Shadowfax] ${context} unavailable: ${error.message}`);
  throw new AppError(`Shadowfax ${context}: ${error.message}`, ERROR_CODES.SFX_SERVICE_UNAVAILABLE, 503);
}

const isLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90;
const isLng = (v) => Number.isFinite(v) && v >= -180 && v <= 180;

class ShadowfaxService {
  /**
   * PUT /api/v1/order-serviceability/
   * +ve → { serviceable:true, delivery_cost, pickup_eta, drop_eta, approx_distance, rain_surge_amount }
   * -ve → { serviceable:false, reason }   ← no charges returned
   */
  async checkServiceability({ pickupLat, pickupLng, dropLat, dropLng, orderValue, paid = true }) {
    const pLat = Number(pickupLat), pLng = Number(pickupLng);
    const dLat = Number(dropLat), dLng = Number(dropLng);
    if (!isLat(pLat) || !isLng(pLng)) throw new AppError('Invalid pickup coordinates', ERROR_CODES.SFX_VALIDATION_ERROR, 400);
    if (!isLat(dLat) || !isLng(dLng)) throw new AppError('Invalid drop coordinates', ERROR_CODES.SFX_VALIDATION_ERROR, 400);

    try {
      const { data } = await shadowfaxClient.put('/api/v1/order-serviceability/', {
        pickup_latitude: String(pLat),
        pickup_longitude: String(pLng),
        drop_latitude: String(dLat),
        drop_longitude: String(dLng),
        paid: String(Boolean(paid)),
        order_value: Number(orderValue) || 0,
        stage_of_check: 'pre_order',
      });
      if (!data || typeof data.serviceable === 'undefined') {
        throw new AppError('Serviceability response missing `serviceable`', ERROR_CODES.SFX_INVALID_RESPONSE, 502);
      }

      const isServiceable = data.serviceable === true;
      logger.info(`[Shadowfax] serviceable=${isServiceable} cost=${data.delivery_cost} dist=${data.approx_distance}${isServiceable ? '' : ` reason=${data.reason}`}`);

      return {
        isServiceable,
        deliveryCost: Number(data.delivery_cost || 0) + Number(data.rain_surge_amount || 0),
        pickupEta: data.pickup_eta ?? null,
        dropEta: data.drop_eta ?? null,
        approxDistance: data.approx_distance ?? null,
        reason: data.reason || null,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      handleSfxError(error, 'checkServiceability');
    }
  }

  /**
   * POST /api/v2/orders/
   *
   * ⚠️ Shadowfax does NOT dedupe `client_order_id`: posting the same COID twice returns 201 and
   * creates a SECOND order (a second rider, billed twice). Callers MUST guarantee one call per
   * internal order — see delivery.service.js `initiateDelivery`.
   */
  async placeOrder(payload) {
    try {
      logger.info(`[Shadowfax] placing order coid=${payload?.order_details?.client_order_id} client_code=${payload?.client_code}`);
      const { data } = await shadowfaxClient.post('/api/v2/orders/', payload);
      const d = data?.data;
      if (!d?.sfx_order_id) throw new AppError('Order create response missing sfx_order_id', ERROR_CODES.SFX_INVALID_RESPONSE, 502);

      logger.info(`[Shadowfax] order created sfx_order_id=${d.sfx_order_id} status=${d.status}`);
      return {
        sfxOrderId: d.sfx_order_id,
        status: d.status || 'ACCEPTED',
        deliveryCost: Number(d.delivery_cost || 0),
        trackUrl: d.track_url && d.track_url !== 'NA' ? d.track_url : null, // staging returns "NA"
        clientOrderId: d.order_details?.client_order_id ?? payload?.order_details?.client_order_id,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      handleSfxError(error, 'placeOrder');
    }
  }

  /** GET /api/v2/orders/{sfx_order_id}/status/ */
  async getOrderStatus({ sfxOrderId }) {
    if (!sfxOrderId) throw new AppError('sfxOrderId is required for status pull', ERROR_CODES.SFX_VALIDATION_ERROR, 400);
    try {
      const { data } = await shadowfaxClient.get(`/api/v2/orders/${sfxOrderId}/status/`);
      const d = data?.data || {};
      const rd = d.rider_details || {};
      const loc = rd.rider_location;
      return {
        status: d.status,
        // ⚠️ `rider_location` here is STALE on staging (shared sandbox rider). Live coordinates
        // arrive ONLY via the rider-location callback — never treat this as a live position.
        rider: rd.rider_name ? { name: rd.rider_name, phone: rd.rider_phone || null, lat: loc ? Number(loc.latitude) : null, lng: loc ? Number(loc.longitude) : null } : null,
        raw: d,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      handleSfxError(error, 'getOrderStatus');
    }
  }

  /** PUT /api/v2/orders/{sfx_order_id}/cancel/ — `user` ∈ Customer | Seller | Rider */
  async cancelOrder({ sfxOrderId, reason, user }) {
    if (!sfxOrderId) throw new AppError('sfxOrderId is required for cancellation', ERROR_CODES.SFX_VALIDATION_ERROR, 400);
    try {
      const { data } = await shadowfaxClient.put(`/api/v2/orders/${sfxOrderId}/cancel/`, {
        reason: String(reason || 'Cancelled by seller').slice(0, 128),
        user: user || 'Seller',
      });
      logger.info(`[Shadowfax] order ${sfxOrderId} cancelled`);
      return data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      handleSfxError(error, 'cancelOrder');
    }
  }

  /** PUT /api/v2/orders/{coid}/dispatch-ready/ — keyed by CLIENT order id, not sfx_order_id. */
  async markDispatchReady({ coid, shipmentReadyTimestamp }) {
    if (!coid) throw new AppError('coid is required for dispatch-ready', ERROR_CODES.SFX_VALIDATION_ERROR, 400);
    try {
      const { data } = await shadowfaxClient.put(`/api/v2/orders/${coid}/dispatch-ready/`, {
        shipment_ready_timestamp: shipmentReadyTimestamp || new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      });
      logger.info(`[Shadowfax] dispatch-ready sent for coid=${coid}`);
      return data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      handleSfxError(error, 'markDispatchReady');
    }
  }
}

const service = new ShadowfaxService();
service.ERROR_CODES = ERROR_CODES;
service.AppError = AppError;
module.exports = service;
