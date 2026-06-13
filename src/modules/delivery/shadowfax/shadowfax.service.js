const shadowfaxClient = require('./shadowfaxClient');
const logger = require('../../../../lib/logger');

const ERROR_CODES = {
  SFX_API_ERROR: 'SFX_API_ERROR',
  SFX_DUPLICATE_COID: 'SFX_DUPLICATE_COID',
  SFX_CANCEL_FAILED: 'SFX_CANCEL_FAILED',
  SFX_ORDER_REJECTED: 'SFX_ORDER_REJECTED',
  SFX_SERVICE_UNAVAILABLE: 'SFX_SERVICE_UNAVAILABLE',
  SFX_TIMEOUT: 'SFX_TIMEOUT',
  SFX_VALIDATION_ERROR: 'SFX_VALIDATION_ERROR',
  SFX_INVALID_RESPONSE: 'SFX_INVALID_RESPONSE'
};

class AppError extends Error {
  constructor(message, code, statusCode = 500) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Handle Axios errors consistently
 */
function handleSfxError(error, context) {
  if (error.response) {
    const status = error.response.status;
    const sfxMessage = error.response.data?.message || JSON.stringify(error.response.data);
    
    let code = ERROR_CODES.SFX_API_ERROR;
    if (status === 400) {
      if (sfxMessage.includes('Repeating COID') || sfxMessage.includes('Duplicate COID')) {
        code = ERROR_CODES.SFX_DUPLICATE_COID;
      } else if (context === 'cancelOrder') {
        code = ERROR_CODES.SFX_CANCEL_FAILED;
      } else {
        code = ERROR_CODES.SFX_ORDER_REJECTED;
      }
    } else if (status >= 500) {
      code = ERROR_CODES.SFX_SERVICE_UNAVAILABLE;
    }

    logger.error(`[Shadowfax API] Error in ${context}: ${sfxMessage}`);
    throw new AppError(`Shadowfax API Error (${context}): ${sfxMessage}`, code, status);
  } else if (error.code === 'ECONNABORTED') {
    logger.error(`[Shadowfax API] Timeout in ${context}`);
    throw new AppError(`Shadowfax request timed out (${context})`, ERROR_CODES.SFX_TIMEOUT, 504);
  } else {
    logger.error(`[Shadowfax API] Service unavailable in ${context}: ${error.message}`);
    throw new AppError(`Shadowfax service unavailable (${context}): ${error.message}`, ERROR_CODES.SFX_SERVICE_UNAVAILABLE, 503);
  }
}

// Validation Helpers
const isValidLat = (lat) => typeof lat === 'number' && lat >= -90 && lat <= 90;
const isValidLng = (lng) => typeof lng === 'number' && lng >= -180 && lng <= 180;

class ShadowfaxService {
  /**
   * Check if Shadowfax is serviceable for a given location and value.
   * Flash Endpoint: POST /order/serviceability/
   */
  async checkServiceability({ pickupDetails, dropDetails, storeCode, orderValue, paid, dropLat, dropLng, coid }) {
    // Determine dynamic inputs with compatibility checks
    const pickup = pickupDetails || {
      building_name: 'Store Vendor',
      latitude: 0,
      longitude: 0,
      address: 'Store Address'
    };

    const drop = dropDetails || {
      building_name: 'Customer Apartment',
      latitude: dropLat || 0,
      longitude: dropLng || 0,
      address: 'Customer Address'
    };

    if (!isValidLat(pickup.latitude) || !isValidLng(pickup.longitude)) {
      throw new AppError('Invalid pickup coordinates', ERROR_CODES.SFX_VALIDATION_ERROR, 400);
    }
    if (!isValidLat(drop.latitude) || !isValidLng(drop.longitude)) {
      throw new AppError('Invalid drop coordinates', ERROR_CODES.SFX_VALIDATION_ERROR, 400);
    }

    try {
      const payload = {
        pickup_details: {
          building_name: pickup.building_name || pickup.name || 'Store Vendor',
          latitude: Number(pickup.latitude),
          longitude: Number(pickup.longitude),
          address: pickup.address || 'Store Vendor Address'
        },
        drop_details: {
          building_name: drop.building_name || drop.name || 'Customer Apartment',
          latitude: Number(drop.latitude),
          longitude: Number(drop.longitude),
          address: drop.address || 'Customer Delivery Address'
        }
      };

      logger.info(`[Shadowfax Service] Checking serviceability from [${payload.pickup_details.latitude}, ${payload.pickup_details.longitude}] to [${payload.drop_details.latitude}, ${payload.drop_details.longitude}]`);
      const response = await shadowfaxClient.post('/order/serviceability/', payload);
      
      if (!response.data || typeof response.data.is_serviceable === 'undefined') {
        throw new AppError('Invalid response: missing is_serviceable key', ERROR_CODES.SFX_INVALID_RESPONSE, 502);
      }
      
      logger.info(`[Shadowfax Service] Serviceability check passed. is_serviceable: ${response.data.is_serviceable}`);
      
      // Map to backward compatible and full response formats
      return {
        is_serviceable: response.data.is_serviceable,
        isServiceable: response.data.is_serviceable,
        total_amount: Number(response.data.total_amount || 0),
        delivery_cost: Number(response.data.total_amount || 0),
        rain_rider_incentive: Number(response.data.rain_rider_incentive || 0),
        high_demand_surge: Number(response.data.high_demand_surge || 0),
        pickup_eta: response.data.pickup_eta || '15 Mins',
        eta: response.data.pickup_eta || '15 Mins',
        available_rider_count: response.data.is_serviceable ? 5 : 0, // compatibility override
        message: response.data.message
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      handleSfxError(error, 'checkServiceability');
    }
  }

  /**
   * Place an order with Shadowfax.
   * Flash Endpoint: POST /order/create/
   */
  async placeOrder(payload) {
    try {
      logger.info(`[Shadowfax Service] Placing Flash order.`);
      const response = await shadowfaxClient.post('/order/create/', payload);
      
      if (!response.data || !response.data.is_order_created) {
        throw new AppError('Order placement was not marked created in response', ERROR_CODES.SFX_INVALID_RESPONSE, 502);
      }
      
      logger.info(`[Shadowfax Service] Order placed successfully. Flash ID: ${response.data.flash_order_id}`);
      
      // Map response to match system expectations
      return {
        sfx_order_id: response.data.flash_order_id,
        status: 'ALLOTTED',
        pickup_otp: response.data.pickup_otp,
        drop_otp: response.data.drop_otp,
        total_amount: response.data.total_amount,
        track_url: null,
        message: response.data.message
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      handleSfxError(error, 'placeOrder');
    }
  }

  /**
   * Cancel an existing Shadowfax order.
   * Flash Endpoint: POST /order/cancel/
   */
  async cancelOrder({ sfxOrderId, reason, user }) {
    if (!sfxOrderId) {
      throw new AppError('sfxOrderId is required for cancellation', ERROR_CODES.SFX_VALIDATION_ERROR, 400);
    }

    try {
      const payload = {
        order_id: sfxOrderId.toString()
      };
      logger.info(`[Shadowfax Service] Cancelling Flash order ${sfxOrderId}`);
      const response = await shadowfaxClient.post('/order/cancel/', payload);
      logger.info(`[Shadowfax Service] Order ${sfxOrderId} cancelled successfully.`);
      return response.data;
    } catch (error) {
      handleSfxError(error, 'cancelOrder');
    }
  }

  /**
   * Get real-time order tracking details.
   * Flash Endpoint: GET /order/track/{order_id}/
   */
  async getOrderStatus({ coid, sfxOrderId }) {
    // Flash uses client order ID (coid) for tracking. Accept both for compatibility.
    const trackingId = coid || sfxOrderId;
    if (!trackingId) {
      throw new AppError('coid or sfxOrderId is required for tracking', ERROR_CODES.SFX_VALIDATION_ERROR, 400);
    }

    try {
      logger.info(`[Shadowfax Service] Tracking Flash order: ${trackingId}`);
      const response = await shadowfaxClient.get(`/order/track/${trackingId}/`);
      return response.data;
    } catch (error) {
      handleSfxError(error, 'getOrderStatus');
    }
  }

  /**
   * Dynamic Flow deprecates static Store registration.
   */
  async createStore() {
    logger.warn('[Shadowfax Service] createStore is deprecated in Flash Hyperlocal dynamic pickup model.');
    return { store_code: 'DYNAMIC_PICKUP' };
  }

  /**
   * Mark an order as dispatch ready (Deprecated/Stubbed out in dynamic Flash model).
   */
  async markDispatchReady() {
    logger.info('[Shadowfax Service] markDispatchReady stubbed out for Flash.');
    return { success: true };
  }
}

module.exports = new ShadowfaxService();

