/**
 * Self-check for the Shadowfax HL Marketplace adapter.
 *
 *   node scratch/check_shadowfax_marketplace.js          # offline: mapper + gate logic only
 *   SFX_DELIVERY_MODE=live node scratch/check_shadowfax_marketplace.js   # + real staging round-trip
 *
 * Exits non-zero on the first failed assertion.
 */
const assert = require('assert');

const env = require('../src/config/env');
const mapper = require('../src/modules/delivery/shadowfax/shadowfax.mapper');
const service = require('../src/modules/delivery/shadowfax/shadowfax.service');
const validator = require('../src/modules/delivery/shadowfax/shadowfax.validator');

const ok = (m) => console.log(`  ok  ${m}`);

// ── 1. Status mapping ────────────────────────────────────────────────────────
// ACCEPTED must NOT advance the order: Shadowfax booked it, no rider exists yet, and the
// vendor still has to accept. Mapping it to RIDER_ASSIGNED would skip the vendor entirely.
assert.strictEqual(mapper.mapSfxStatusToInternal('ACCEPTED'), null);
assert.strictEqual(mapper.mapSfxStatusToInternal('ALLOTTED'), 'RIDER_ASSIGNED');
assert.strictEqual(mapper.mapSfxStatusToInternal('ARRIVED'), 'RIDER_AT_STORE');
assert.strictEqual(mapper.mapSfxStatusToInternal('DISPATCHED'), 'picked_up');
assert.strictEqual(mapper.mapSfxStatusToInternal('DELIVERED'), 'delivered');
assert.strictEqual(mapper.mapSfxStatusToInternal('CANCELLED'), 'cancelled');
assert.strictEqual(mapper.mapSfxStatusToInternal('UNDELIVERED'), 'delivery_failed');
assert.strictEqual(mapper.mapSfxStatusToInternal('SOMETHING_NEW'), null); // never clobber
ok('status mapping (ACCEPTED and unknown → null)');

// ── 2. Vendor location cut-off at pickup ─────────────────────────────────────
assert.strictEqual(mapper.isPrePickupOrderStatus('RIDER_ASSIGNED'), true);
assert.strictEqual(mapper.isPrePickupOrderStatus('RIDER_AT_STORE'), true);
assert.strictEqual(mapper.isPrePickupOrderStatus('picked_up'), false);
assert.strictEqual(mapper.isPrePickupOrderStatus('delivered'), false);
ok('vendor sees rider location only pre-pickup');

// ── 3. Place-order payload shape (Marketplace) ───────────────────────────────
const order = {
  id: '11111111-2222-3333-4444-555555555555',
  paymentMethod: 'CASH',
  totalAmount: 323,
  deliveryFee: 75,
  addressSnapshot: { addressLine1: 'Drop addr', latitude: 12.9279, longitude: 77.6271, phone: '+91 99876 54321' },
  items: [{ productId: 'p1', productName: 'Biryani', unitPrice: 248, quantity: 1 }],
};
const vendor = { businessName: 'Test Store', businessAddress: 'Pickup addr', city: 'Bangalore', latitude: 12.9379319, longitude: 77.6244159 };
const { payload, clientOrderId } = mapper.buildPlaceOrderPayload(order, vendor, { fullName: 'Cust' });

assert.strictEqual(clientOrderId, order.id, 'COID must be the internal order id (stable)');
assert.ok(!('store_code' in payload), 'Marketplace has no store_code');
assert.ok('client_code' in payload && 'pickup_details' in payload && 'drop_details' in payload && 'order_items' in payload);
assert.strictEqual(payload.order_details.paid, 'false', 'CASH → COD → paid must be the STRING "false"');
assert.strictEqual(payload.order_details.order_value, 248, 'order_value excludes our delivery fee');
assert.strictEqual(payload.drop_details.contact_number, '9987654321', 'phone normalised to last 10 digits');
assert.strictEqual(payload.pickup_details.latitude, 12.9379319);
ok('place-order payload matches Marketplace schema');

const prepaid = mapper.buildPlaceOrderPayload({ ...order, paymentMethod: 'Online' }, vendor, {}).payload;
assert.strictEqual(prepaid.order_details.paid, 'true');
ok('prepaid → paid="true"');

// ── 4. Callback validation (Marketplace field names) ─────────────────────────
const status = validator.validateStatusCallback({
  order_status: 'ALLOTTED', client_order_id: order.id, sfx_order_id: 21046128,
  rider_name: 'Aastha Jain', rider_contact: '8750879029', rider_latitude: 12.93, rider_longitude: 77.62,
});
assert.strictEqual(status.status, 'ALLOTTED', 'order_status normalises to status');
const rider = mapper.extractRider(status);
assert.strictEqual(rider.name, 'Aastha Jain');
assert.strictEqual(rider.phone, '8750879029');

// Location callback keys the order by `order_id` (= COID), and carries no sfx_order_id.
const loc = validator.validateLocationCallback({
  order_id: order.id, sfx_rider_id: 3419, rider_latitude: 12.93, rider_longitude: 77.62, drop_eta: 18,
});
assert.strictEqual(loc.coid, order.id, 'order_id must resolve to coid');
ok('status + location callbacks validate and normalise');

// ── 5. Order-status sets ─────────────────────────────────────────────────────
const { isActiveStatus, isCancellableStatus } = require('../lib/orderStatus');

// An order out for delivery is still ACTIVE. If these drop out, the vendor loses the order
// from their list and checkAndTransitionVendorOffline flips the store offline mid-delivery.
assert.strictEqual(isActiveStatus('pending_vendor'), true);
assert.strictEqual(isActiveStatus('RIDER_ASSIGNED'), true);
assert.strictEqual(isActiveStatus('picked_up'), true);
assert.strictEqual(isActiveStatus('arrived_at_customer'), true);
assert.strictEqual(isActiveStatus('delivered'), false);
assert.strictEqual(isActiveStatus('cancelled'), false);
ok('active-order statuses include the delivery leg');

// Money guard: Shadowfax bills 100% of the delivery fee for a post-pickup cancellation.
assert.strictEqual(isCancellableStatus('pending_vendor'), true);
assert.strictEqual(isCancellableStatus('RIDER_ASSIGNED'), true);
assert.strictEqual(isCancellableStatus('RIDER_AT_STORE'), true);
assert.strictEqual(isCancellableStatus('picked_up'), false);
assert.strictEqual(isCancellableStatus('arrived_at_customer'), false);
assert.strictEqual(isCancellableStatus('delivered'), false);
ok('cancellation blocked once the rider has the parcel');

// ── 6. Live staging round-trip (only with SFX_DELIVERY_MODE=live) ────────────
(async () => {
  // Deterministic: stub the transport so we test OUR handling of a -ve response, not Shadowfax's
  // sandbox (staging happily returns serviceable:true with approx_distance:"Not_Available").
  {
    const client = require('../src/modules/delivery/shadowfax/shadowfaxClient');
    const origPut = client.put;
    client.put = async () => ({ data: { serviceability: false, serviceable: false, reason: 'TOO_FAR' } });
    const neg = await service.checkServiceability({ pickupLat: 12.93, pickupLng: 77.62, dropLat: 13.08, dropLng: 80.27, orderValue: 248 });
    client.put = origPut;
    assert.strictEqual(neg.isServiceable, false);
    assert.strictEqual(neg.reason, 'TOO_FAR');
    assert.strictEqual(neg.deliveryCost, 0, 'an unserviceable route must quote NO delivery charge');
    ok('unserviceable response → isServiceable=false, zero charge, reason surfaced');
  }

  if (!env.SFX_LIVE) {
    console.log('\nSIMULATE mode — skipped live staging round-trip.');
    console.log('   re-run with: SFX_DELIVERY_MODE=live node scratch/check_shadowfax_marketplace.js');
    console.log('\nALL OFFLINE CHECKS PASSED');
    return process.exit(0); // logger transports keep the event loop alive
  }

  console.log(`\nLIVE round-trip against ${env.SFX_ACTIVE_BASE_URL} (client_code=${env.SFX_ACTIVE_CLIENT_CODE})`);
  const PICK = { lat: 12.9379319, lng: 77.6244159 }; // Koramangala — the only serviceable staging area
  const DROP = { lat: 12.9279, lng: 77.6271 };

  const svc = await service.checkServiceability({
    pickupLat: PICK.lat, pickupLng: PICK.lng, dropLat: DROP.lat, dropLng: DROP.lng, orderValue: 248, paid: true,
  });
  assert.strictEqual(svc.isServiceable, true);
  assert.ok(svc.deliveryCost > 0, 'serviceable route must return a delivery cost');
  ok(`serviceability → cost=${svc.deliveryCost} pickupEta=${svc.pickupEta} dropEta=${svc.dropEta}`);

  // Informational only — staging's geo-gate is unreliable (it has returned serviceable:true for a
  // Bangalore→Chennai drop with approx_distance:"Not_Available"). Never assert on it.
  const far = await service.checkServiceability({
    pickupLat: PICK.lat, pickupLng: PICK.lng, dropLat: 13.0827, dropLng: 80.2707, orderValue: 248, paid: true,
  });
  console.log(`  --  staging far-drop check: serviceable=${far.isServiceable} reason=${far.reason ?? 'none'} (not asserted)`);

  const live = mapper.buildPlaceOrderPayload(
    { ...order, id: `selfcheck-${Date.now()}`, paymentMethod: 'Online', totalAmount: 323 },
    vendor, { fullName: 'Self Check' }
  );
  const placed = await service.placeOrder(live.payload);
  assert.ok(placed.sfxOrderId, 'placeOrder must return sfx_order_id');
  assert.strictEqual(placed.status, 'ACCEPTED');
  ok(`placeOrder → sfx_order_id=${placed.sfxOrderId} status=${placed.status} cost=${placed.deliveryCost}`);

  const pulled = await service.getOrderStatus({ sfxOrderId: placed.sfxOrderId });
  assert.strictEqual(pulled.status, 'ACCEPTED');
  ok('getOrderStatus → ACCEPTED');

  await service.cancelOrder({ sfxOrderId: placed.sfxOrderId, reason: 'self-check cleanup', user: 'Seller' });
  const after = await service.getOrderStatus({ sfxOrderId: placed.sfxOrderId });
  assert.strictEqual(after.status, 'CANCELLED');
  ok('cancelOrder → CANCELLED (test order cleaned up)');

  console.log('\nALL CHECKS PASSED (offline + live staging)');
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exit(1);
});
