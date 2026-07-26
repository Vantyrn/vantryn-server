/**
 * ONE place that sends a notification.
 *
 * Before this, "notify the user" meant calling fcm.sendToVendor / sendToCustomer
 * directly from a route, and nothing was ever written down — the notification_logs
 * table existed but no code touched it, so a push that arrived while the phone was
 * off was simply lost. Every send now goes through notify(), which does both:
 *   1. writes a notification_logs row  → the in-app inbox, survives restarts
 *   2. sends the FCM push              → the lock-screen alert
 *
 * Add a new event by calling notify() — never by calling fcm.* directly, or the
 * event will push without appearing in the user's inbox.
 *
 * Delivery is best-effort by design: a failed push must never fail the business
 * operation that triggered it (accepting an order, submitting KYC). Everything is
 * caught and logged. The inbox row is written FIRST so history survives even when
 * FCM is down or the device token is stale.
 */
const { prisma } = require('./prisma');
const fcm = require('./fcm');
const logger = require('./logger');

/**
 * Resolve the profile row that owns a notification.
 * `userId` on notification_logs is a Profile.id — one identity for both roles,
 * and the only id we can reach from either a firebaseUid or a vendorId.
 */
async function resolveProfile({ firebaseUid, vendorId, customerId, profileId }) {
  if (profileId) return { id: profileId };
  if (firebaseUid) {
    return prisma.profile.findUnique({ where: { firebaseUid }, select: { id: true, role: true } });
  }
  if (vendorId) {
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { profile: { select: { id: true, firebaseUid: true } } },
    });
    return vendor?.profile || null;
  }
  if (customerId) {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { profile: { select: { id: true, firebaseUid: true } } },
    });
    return customer?.profile || null;
  }
  return null;
}

/**
 * Record + deliver one notification.
 *
 * @param {object} opts
 * @param {'VENDOR'|'CUSTOMER'} opts.role     which app this belongs to
 * @param {string} [opts.vendorId]            addressee, pick ONE of these
 * @param {string} [opts.customerId]
 * @param {string} [opts.firebaseUid]
 * @param {string} opts.title                 notification title
 * @param {string} opts.body                  notification body
 * @param {string} opts.type                  event name, drives icon + deep link
 * @param {object} [opts.data]                route params ({ orderId }, ...)
 * @returns {Promise<boolean>}                true if it was recorded
 */
async function notify({ role, vendorId, customerId, firebaseUid, title, body, type, data = {} }) {
  try {
    const profile = await resolveProfile({ firebaseUid, vendorId, customerId });
    if (!profile?.id) {
      logger.warn?.(`[NOTIFY] No profile for ${role} (${vendorId || customerId || firebaseUid}) — "${title}" dropped`);
      return false;
    }

    // History first: an inbox entry must survive a dead/stale device token.
    await prisma.notificationLog.create({
      data: { userId: profile.id, role, title, body, type, data, status: 'sent' },
    });

    // FCM data payload values must be strings — a nested object silently fails to send.
    const payload = { title, body, type };
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined) payload[k] = String(v);
    }

    if (role === 'VENDOR' && vendorId) await fcm.sendToVendor(vendorId, payload);
    else if (firebaseUid) await fcm.sendToCustomer(firebaseUid, payload);
    else if (profile.firebaseUid) await fcm.sendToCustomer(profile.firebaseUid, payload);

    return true;
  } catch (err) {
    // Never let a notification failure break the caller's transaction.
    logger.error?.(`[NOTIFY] "${title}" failed: ${err.message}`);
    return false;
  }
}

/** Notify a vendor. */
const notifyVendor = (vendorId, { title, body, type, data }) =>
  notify({ role: 'VENDOR', vendorId, title, body, type, data });

/** Notify a customer by their firebaseUid. */
const notifyCustomer = (firebaseUid, { title, body, type, data }) =>
  notify({ role: 'CUSTOMER', firebaseUid, title, body, type, data });

module.exports = { notify, notifyVendor, notifyCustomer };
