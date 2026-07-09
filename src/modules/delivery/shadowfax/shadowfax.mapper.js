/**
 * Shadowfax Data Mapper (HL **Marketplace** API)
 * Transforms internal orders into the Marketplace order schema and maps Shadowfax
 * statuses / rider details back into our internal representation.
 */

const env = require('../../../config/env');

const cleanPhone = (v) => (v ? String(v).replace(/[^0-9]/g, '').slice(-10) : '9999999999');
const numOr = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));

/**
 * Build the Marketplace place-order payload.
 * POST /api/v2/orders/
 *
 * Marketplace has NO store_code: a single account-level `client_code`, and pickup
 * coordinates are supplied per order from the vendor record.
 *
 * `client_order_id` is the internal order UUID — stable, so a replay maps to the same
 * order in our DB. (Shadowfax itself does NOT dedupe COIDs; see delivery.service.js.)
 *
 * @param {object} internalOrder  Prisma Order (+ items).
 * @param {object} vendor         Prisma Vendor (needs latitude/longitude).
 * @param {object} customer       Prisma Customer.
 * @returns {{payload: object, clientOrderId: string}}
 */
function buildPlaceOrderPayload(internalOrder, vendor, customer) {
  const coid = String(internalOrder.id);

  const method = (internalOrder.paymentMethod || '').toUpperCase();
  const isPrepaid = method !== 'COD' && method !== 'CASH';

  // Value of the goods, excluding our delivery fee — that's what Shadowfax insures / collects.
  const orderValue = Math.max(0, numOr(internalOrder.totalAmount) - numOr(internalOrder.deliveryFee));

  const snap = internalOrder.addressSnapshot || {};

  const payload = {
    client_code: env.SFX_ACTIVE_CLIENT_CODE,
    order_details: {
      client_order_id: coid,
      order_value: orderValue,
      paid: isPrepaid ? 'true' : 'false', // Shadowfax expects the STRING "true"/"false"
      rts_required: true,
    },
    pickup_details: {
      name: vendor?.businessName || 'Store',
      contact_number: cleanPhone(vendor?.phone),
      address: vendor?.businessAddress || 'Store address',
      city: vendor?.city || '',
      latitude: numOr(vendor?.latitude),
      longitude: numOr(vendor?.longitude),
    },
    drop_details: {
      name: customer?.fullName || snap.name || 'Customer',
      contact_number: cleanPhone(snap.phone || customer?.phone),
      address: snap.addressLine1 || snap.address || 'Customer delivery address',
      city: snap.city || vendor?.city || '',
      latitude: numOr(snap.latitude),
      longitude: numOr(snap.longitude),
    },
    order_items: (internalOrder.items || []).map((it) => ({
      id: String(it.productId || it.id),
      name: it.productName || it.name || 'Item',
      price: numOr(it.unitPrice || it.price),
      quantity: numOr(it.quantity, 1),
    })),
  };

  return { payload, clientOrderId: coid };
}

// Internal statuses that mean "the rider does NOT have the parcel yet".
// The vendor sees the rider's live location only during these; afterwards, status only.
const PRE_PICKUP_INTERNAL_STATUSES = new Set(['RIDER_ASSIGNED', 'RIDER_AT_STORE']);

function isPrePickupInternalStatus(internalStatus) {
  return PRE_PICKUP_INTERNAL_STATUSES.has(internalStatus);
}

// Order.status values meaning the rider already has the parcel (pickup done or later).
const POST_PICKUP_ORDER_STATUSES = new Set([
  'picked_up', 'out_for_delivery', 'dispatched', 'arrived_at_customer',
  'delivered', 'delivery_failed', 'cancelled', 'cancelled_by_vendor',
  'RETURN_TO_STORE_IN_PROGRESS', 'RETURNED_TO_SELLER',
]);

/** True while the vendor should still receive live rider coordinates for this order status. */
function isPrePickupOrderStatus(orderStatus) {
  if (!orderStatus) return true;
  return !POST_PICKUP_ORDER_STATUSES.has(String(orderStatus));
}

/**
 * Map a Shadowfax Marketplace status to an internal order status.
 *
 * Returns `null` when the event carries no internal state change — the caller MUST then
 * leave Order.status alone. This matters for:
 *   ACCEPTED — Shadowfax accepted the order but no rider exists yet. Our order is still
 *              `pending_vendor`; treating it as RIDER_ASSIGNED would skip the vendor entirely.
 *   unknown  — never clobber a real status with a placeholder.
 */
function mapSfxStatusToInternal(sfxStatus) {
  if (!sfxStatus) return null;

  switch (String(sfxStatus).toUpperCase()) {
    case 'ACCEPTED':
      return null; // order booked with Shadowfax; no rider yet
    case 'ALLOTTED':
      return 'RIDER_ASSIGNED';
    case 'ARRIVED':
    case 'ARRIVED_AT_STORE':
      return 'RIDER_AT_STORE';
    case 'COLLECTED':
    case 'DISPATCHED':
    case 'PICKED_UP':
      return 'picked_up';
    case 'ARRIVED_CUSTOMER_DOORSTEP':
    case 'CUSTOMER_DOOR_STEP':
    case 'ARRIVED_AT_CUSTOMER_DOORSTEP':
      return 'arrived_at_customer';
    case 'DELIVERED':
      return 'delivered';
    case 'UNDELIVERED':
      return 'delivery_failed';
    case 'CANCELLED':
    case 'CANCELLED_BY_CUSTOMER':
      return 'cancelled';
    case 'UNASSIGNED':
      return 'RIDER_UNASSIGNED';
    case 'RTS_INITIATED':
      return 'RETURN_TO_STORE_IN_PROGRESS';
    case 'RTS_COMPLETED':
    case 'RETURNED_TO_SELLER':
      return 'RETURNED_TO_SELLER';
    default:
      console.warn(`[Shadowfax Mapper] Unknown SFX status: ${sfxStatus}`);
      return null;
  }
}

/** Extract rider identity from a status/location callback payload (fields vary by event). */
function extractRider(payload = {}) {
  const name = payload.rider_name || payload.riderName || null;
  const phone = payload.rider_contact || payload.rider_phone || payload.riderContact || null;
  const id = payload.rider_id || payload.sfx_rider_id || payload.riderId || null;
  if (!name && !phone && !id) return null;
  return { name, phone: phone ? String(phone) : null, id: id != null ? String(id) : null };
}

/** Maps an internal cancel reason to the Shadowfax cancel payload shape. */
function mapCancelReasonToSfx(internalReason, user = 'Seller') {
  const reason = String(internalReason || 'Cancelled by seller');
  return {
    reason: reason.length > 128 ? reason.slice(0, 125) + '...' : reason,
    user,
  };
}

module.exports = {
  buildPlaceOrderPayload,
  mapSfxStatusToInternal,
  mapCancelReasonToSfx,
  extractRider,
  isPrePickupInternalStatus,
  isPrePickupOrderStatus,
  PRE_PICKUP_INTERNAL_STATUSES,
  POST_PICKUP_ORDER_STATUSES,
};
