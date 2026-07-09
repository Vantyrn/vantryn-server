const shadowfaxService = require('../src/modules/delivery/shadowfax/shadowfax.service');
const env = require('../src/config/env');

// Deterministic fee used in SIMULATE mode so local dev works with no Shadowfax credentials.
// (40 base + 15 rain + 20 surge — matches the old simulate branch of /orders/checkout.)
const SIMULATED_FEE = 75.0;

function unavailable(reason) {
  const e = new Error(`DELIVERY_UNAVAILABLE: ${reason || 'Delivery is currently unavailable for this route.'}`);
  e.status = 422;
  e.code = 'DELIVERY_UNAVAILABLE';
  return e;
}

/**
 * Hard serviceability gate — the single source of truth for "can Shadowfax deliver
 * vendor → customer, and for how much". Run this BEFORE creating an order.
 *
 * Shadowfax Marketplace takes pickup AND drop coordinates (there is no store code).
 * A -ve response returns no charges, only a `reason`.
 *
 * Fails CLOSED: if Shadowfax is unreachable we do NOT invent a delivery fee and let the
 * order through — we'd be selling a delivery we cannot dispatch.
 *
 * @throws {Error} status 422 / code DELIVERY_UNAVAILABLE
 * @returns {{isServiceable: true, deliveryCost: number, pickupEta: ?number, dropEta: ?number}}
 */
async function assertServiceable({ vendor, address, cartTotal, paid = true }) {
  if (!env.SFX_LIVE) {
    return { isServiceable: true, deliveryCost: SIMULATED_FEE, pickupEta: null, dropEta: null };
  }

  const sfx = await shadowfaxService.checkServiceability({
    pickupLat: vendor?.latitude,
    pickupLng: vendor?.longitude,
    dropLat: address?.latitude,
    dropLng: address?.longitude,
    orderValue: cartTotal,
    paid,
  });

  if (!sfx?.isServiceable) {
    throw unavailable(sfx?.reason);
  }

  return {
    isServiceable: true,
    deliveryCost: sfx.deliveryCost,
    pickupEta: sfx.pickupEta,
    dropEta: sfx.dropEta,
  };
}

/**
 * Server-authoritative delivery fee. NEVER trust a client-supplied delivery fee —
 * a manipulated fee underpays the order.
 * @throws {Error} status 422 / code DELIVERY_UNAVAILABLE if not serviceable.
 */
async function computeDeliveryCost(args) {
  const { deliveryCost } = await assertServiceable(args);
  return deliveryCost;
}

module.exports = { computeDeliveryCost, assertServiceable, SIMULATED_FEE };
