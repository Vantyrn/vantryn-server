const { prisma } = require('./prisma');
const sfxMapper = require('../src/modules/delivery/shadowfax/shadowfax.mapper');

/**
 * Delivery telemetry for an order, read from the sfx_* tables (real Shadowfax callbacks OR the
 * local simulator — both write the same rows, so this works in either mode).
 *
 * Single source for BOTH the customer and vendor tracking endpoints: sockets only deliver
 * updates to clients that are already listening, so any screen opened late needs to seed
 * from here or it will sit on "awaiting rider" forever.
 */
async function getSfxTracking(orderId) {
  const empty = { sfxStatus: null, trackUrl: null, rider: null, riderLocation: null };

  const sfxOrder = await prisma.sfxOrder.findUnique({ where: { internalOrderId: orderId } }).catch(() => null);
  if (!sfxOrder) return empty;

  const [latest, callbacks] = await Promise.all([
    prisma.sfxRiderLocationLog
      .findFirst({ where: { sfxOrderId: sfxOrder.sfxOrderId }, orderBy: { receivedAt: 'desc' } })
      .catch(() => null),
    prisma.sfxCallback
      .findMany({ where: { sfxOrderId: sfxOrder.sfxOrderId }, orderBy: { receivedAt: 'desc' }, take: 25 })
      .catch(() => []),
  ]);

  // Rider identity: newest callback payload that carries rider fields.
  let rider = null;
  for (const cb of callbacks) {
    const r = sfxMapper.extractRider(cb.payload || {});
    if (r) { rider = { name: r.name, phone: r.phone }; break; }
  }

  return {
    sfxStatus: sfxOrder.sfxStatus || null,
    trackUrl: sfxOrder.trackUrl || null,
    rider,
    riderLocation: latest
      ? { lat: Number(latest.lat), lng: Number(latest.lng), pickupEta: latest.pickupEta, dropEta: latest.dropEta }
      : null,
  };
}

module.exports = { getSfxTracking };
