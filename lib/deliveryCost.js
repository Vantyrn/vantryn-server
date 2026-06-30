const shadowfaxService = require('../src/modules/delivery/shadowfax/shadowfax.service');
const env = require('../src/config/env');

/**
 * Server-authoritative delivery cost. NEVER trust a client-supplied delivery fee —
 * a manipulated fee underpays the order. This mirrors the logic in /orders/checkout so
 * the UPI initiate path computes the same amount the customer was shown.
 *
 * @throws {Error} with status 422 / code DELIVERY_UNAVAILABLE if not serviceable.
 */
async function computeDeliveryCost({ vendor, address, cartTotal }) {
  const isSandbox = env.USE_SANDBOX_PAYMENTS || process.env.USE_SANDBOX_PAYMENTS === 'true';
  if (isSandbox) {
    // base + rain incentive + demand surge (matches the sandbox branch of checkout)
    return 40.0 + 15.0 + 20.0;
  }
  try {
    const sfx = await shadowfaxService.checkServiceability({
      pickupDetails: {
        building_name: vendor?.businessName || 'Store Vendor',
        latitude: vendor?.latitude ? Number(vendor.latitude) : 28.6304,
        longitude: vendor?.longitude ? Number(vendor.longitude) : 77.2177,
        address: vendor?.businessAddress || 'Store Address',
      },
      dropDetails: {
        building_name: address?.addressType || 'Customer Residence',
        latitude: address?.latitude ? Number(address.latitude) : 28.6448,
        longitude: address?.longitude ? Number(address.longitude) : 77.1873,
        address: address?.addressLine1 || 'Customer Address',
      },
      orderValue: cartTotal,
      paid: true,
    });
    if (sfx && sfx.isServiceable === false) {
      const e = new Error('DELIVERY_UNAVAILABLE: Delivery is currently unavailable in your area.');
      e.status = 422; e.code = 'DELIVERY_UNAVAILABLE';
      throw e;
    }
    if (sfx) {
      return Number(sfx.total_amount || 0) + Number(sfx.rain_rider_incentive || 0) + Number(sfx.high_demand_surge || 0);
    }
    return 75.0;
  } catch (err) {
    if (err.code === 'DELIVERY_UNAVAILABLE') throw err;
    console.warn('[DELIVERY-COST] Serviceability check failed, using fallback ₹75:', err.message);
    return 75.0;
  }
}

module.exports = { computeDeliveryCost };
