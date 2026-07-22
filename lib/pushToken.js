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

/** Detach the device token on logout so the next push doesn't follow the old account. */
async function releasePushToken(firebaseUid) {
  await prisma.profile.updateMany({
    where: { firebaseUid },
    data: { fcmToken: null },
  });
}

module.exports = { claimPushToken, releasePushToken };
