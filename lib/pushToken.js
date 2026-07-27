const { prisma } = require('./prisma');

/**
 * Store an FCM token against a profile, taking EXCLUSIVE ownership of it.
 *
 * An FCM token identifies a DEVICE, not a person. Two testers sharing one phone —
 * or one tester logging out of vendor A and in as vendor B — left the token attached
 * to BOTH profiles, because saving only ever wrote to the current profile and never
 * cleared the previous owner. fcm.sendToVendor(A) then looked up A's token, found the
 * shared device token, and delivered A's "New order received" to the phone currently
 * logged in as B. Verified in the live DB: two vendor profiles held the same token.
 *
 * Whoever registers a token now owns it, so this also self-heals a stale row the next
 * time that device registers — which matters because a logout can always be missed
 * (app uninstalled, force-closed, storage cleared).
 */
async function claimPushToken(firebaseUid, token) {
  if (!token) return;
  await prisma.$transaction([
    prisma.profile.updateMany({
      where: { fcmToken: token, firebaseUid: { not: firebaseUid } },
      data: { fcmToken: null },
    }),
    prisma.profile.update({
      where: { firebaseUid },
      data: { fcmToken: token },
    }),
  ]);
}

/**
 * Store the VENDOR app's device token on the vendor row, not the shared profile.
 *
 * One phone can run both apps, and with the same number both resolve to the SAME
 * Profile — which has exactly one fcm_token column. Both apps were claiming it, so
 * whichever registered last owned it and then received BOTH the vendor and the
 * customer pushes ("Order delivered" landing in the vendor app, etc.). The two apps
 * are separate FCM registrations and need separate homes: vendors.fcm_token for the
 * vendor app, profiles.fcm_token for the customer app.
 */
async function claimVendorPushToken(firebaseUid, token) {
  if (!token) return;
  const profile = await prisma.profile.findUnique({
    where: { firebaseUid },
    select: { id: true, fcmToken: true, vendor: { select: { id: true } } },
  });
  if (!profile?.vendor?.id) return;

  await prisma.$transaction([
    // Exclusive ownership among vendors — a shared test device must not keep
    // delivering another vendor's orders after a re-login.
    prisma.vendor.updateMany({
      where: { fcmToken: token, id: { not: profile.vendor.id } },
      data: { fcmToken: null },
    }),
    prisma.vendor.update({ where: { id: profile.vendor.id }, data: { fcmToken: token } }),
    // If this token was previously claimed on the profile (by the older vendor build
    // that wrote there), release it so the customer app's own token can take over and
    // customer pushes stop arriving on the vendor device.
    prisma.profile.updateMany({
      where: { id: profile.id, fcmToken: token },
      data: { fcmToken: null },
    }),
  ]);
}

/** Detach the vendor device token on vendor logout. */
async function releaseVendorPushToken(firebaseUid) {
  const profile = await prisma.profile.findUnique({
    where: { firebaseUid },
    select: { vendor: { select: { id: true } } },
  });
  if (!profile?.vendor?.id) return;
  await prisma.vendor.update({ where: { id: profile.vendor.id }, data: { fcmToken: null } });
}

/** Detach the device token on logout so the next push doesn't follow the old account. */
async function releasePushToken(firebaseUid) {
  await prisma.profile.updateMany({
    where: { firebaseUid },
    data: { fcmToken: null },
  });
}

module.exports = { claimPushToken, releasePushToken, claimVendorPushToken, releaseVendorPushToken };
