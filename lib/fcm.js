const admin = require('firebase-admin');

// Expo Push delivery was removed: there is no pushToken column to read one from, so
// every send path is FCM-only. Both apps register a native FCM device token.

/**
 * Sends a standard push notification via FCM
 */
const sendPushNotification = async (fcmToken, title, body, dataPayload = {}) => {
  if (!admin.apps.length || !fcmToken) return;

  try {
    const channelId = dataPayload.channelId || 'default';
    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data: dataPayload,
      android: {
        priority: 'high',
        notification: {
          channelId: channelId
        }
      }
    });
    console.log(`[FCM] Notification sent to ${fcmToken.substring(0, 10)}... with channel ${channelId}`);
  } catch (error) {
    console.error(`[FCM] Error sending message:`, error.message);
  }
};

/**
 * Module B3 - Floating Bubble Logic
 * Sends a silent data payload to update the Android floating bubble state
 */
const updateFloatingBubble = async (vendorId, isActive, activeOrderCount = 0) => {
  if (!admin.apps.length) return;

  try {
    // Fetch the FCM token via the vendor's profile
    const vendor = await require('./prisma').prisma.vendor.findUnique({
      where: { id: vendorId },
      include: { profile: { select: { fcmToken: true } } }
    });
    
    const fcmToken = vendor?.profile?.fcmToken || vendor?.fcmToken;
    if (!fcmToken || fcmToken.startsWith('mock_')) return;

    await admin.messaging().send({
      token: fcmToken,
      data: {
        type: 'BUBBLE_UPDATE',
        bubble_active: isActive.toString(),
        badge_count: activeOrderCount.toString()
      },
      android: {
        priority: 'high'
      }
    });
    console.log(`[FCM] Bubble update sent for vendor ${vendorId}.`);
  } catch (error) {
    console.error(`[FCM] Bubble update error:`, error.message);
  }
};

/**
 * Convenience helper to send to a Vendor
 */
const sendToVendor = async (vendorId, payload) => {
  try {
    // FCM-only: there is no pushToken column on Profile. Selecting it threw
    // "Unknown field `pushToken` for select statement on model `Profile`" on EVERY
    // call, and the catch below swallowed it — so no vendor ever received a push
    // (KYC decisions, new orders, cancellations). Same bug broadcastToUsers already fixed.
    const vendor = await require('./prisma').prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { fcmToken: true, profile: { select: { fcmToken: true } } }
    });

    // Vendor row FIRST. The profile's token belongs to the CUSTOMER app — on a phone
    // running both with the same number they share one Profile, so preferring the
    // profile token delivered vendor pushes to the customer app (and vice versa).
    // The profile fallback only covers vendors registered before the split.
    const fcmToken = vendor?.fcmToken || vendor?.profile?.fcmToken;

    const isKyc = payload.type && payload.type.toUpperCase().startsWith('KYC');
    const channelId = isKyc ? 'kyc' : 'orders';

    if (fcmToken && admin.apps.length) {
      await sendPushNotification(
        fcmToken, 
        payload.title, 
        payload.body, 
        { ...payload, type: payload.type || 'NEW_ORDER', channelId }
      );
    }
  } catch (error) {
    console.error(`[FCM] Error sending to vendor ${vendorId}:`, error.message);
  }
};

/**
 * Convenience helper to send to a Customer
 */
const sendToCustomer = async (firebaseUid, payload) => {
  try {
    // FCM-only — see sendToVendor: selecting the nonexistent pushToken column threw
    // on every call, so no customer ever received an order-update push either.
    const profile = await require('./prisma').prisma.profile.findUnique({
      where: { firebaseUid },
      select: { fcmToken: true }
    });

    if (profile?.fcmToken && admin.apps.length) {
      await sendPushNotification(
        profile.fcmToken, 
        payload.title, 
        payload.body, 
        { ...payload, type: payload.type || 'order_update', channelId: 'default' }
      );
    }
  } catch (error) {
    console.error(`[FCM] Error sending to customer ${firebaseUid}:`, error.message);
  }
};

/**
 * Broadcast notification to a group of users
 * @param {string} targetAudience - 'VENDORS', 'CUSTOMERS', or 'ALL'
 * @param {object} payload - { title, body, data }
 */
const broadcastToUsers = async (targetAudience, payload) => {
  try {
    // FCM-only: there is no pushToken column in the Profile model (querying it
    // crashed every broadcast with Prisma "Unknown argument 'pushToken'"), and
    // both apps register native FCM device tokens.
    let fcmTokens = [];
    const prisma = require('./prisma').prisma;
    // Collect ids too, so the broadcast can be written to every recipient's inbox.
    // Without this an admin announcement existed only as a transient push: miss the
    // banner and it was gone, with no record anywhere.
    const recipients = [];

    if (targetAudience === 'VENDORS' || targetAudience === 'ALL') {
      // Read the VENDOR rows' tokens, not profiles-with-role-VENDOR: role drifts on a
      // dual-role profile, and the vendor app's token lives on the vendor row now.
      const vendors = await prisma.vendor.findMany({
        where: { fcmToken: { not: null } },
        select: { fcmToken: true, profileId: true }
      });
      vendors.forEach(v => {
        if (v.fcmToken) fcmTokens.push(v.fcmToken);
        if (v.profileId) recipients.push({ id: v.profileId, role: 'VENDOR' });
      });
    }

    if (targetAudience === 'CUSTOMERS' || targetAudience === 'ALL') {
      // Profiles that actually own a customer record — again the relation, not the
      // drift-prone role label.
      const customers = await prisma.profile.findMany({
        where: { customer: { isNot: null }, fcmToken: { not: null } },
        select: { id: true, fcmToken: true }
      });
      customers.forEach(c => {
        if (c.fcmToken) fcmTokens.push(c.fcmToken);
        recipients.push({ id: c.id, role: 'CUSTOMER' });
      });
    }

    // Inbox rows first — history must survive a failed/stale device token.
    if (recipients.length) {
      try {
        await prisma.notificationLog.createMany({
          data: recipients.map((r) => ({
            userId: r.id,
            role: r.role,
            title: payload.title,
            body: payload.body,
            type: payload.type || 'admin_broadcast',
            data: payload.data || {},
          })),
        });
      } catch (logErr) {
        console.warn('[BROADCAST] Inbox write failed (push still sent):', logErr.message);
      }
    }

    // Filter out mock tokens, short/null tokens
    fcmTokens = [...new Set(fcmTokens.filter(t => t && t.length > 20 && !t.startsWith('mock_')))];

    console.log(`[BROADCAST] FCM tokens found: ${fcmTokens.length}`);

    let successCount = 0;
    let failureCount = 0;

    // Send FCM Notifications
    if (fcmTokens.length > 0 && admin.apps.length) {
      const BATCH_SIZE = 500;
      for (let i = 0; i < fcmTokens.length; i += BATCH_SIZE) {
        const batchTokens = fcmTokens.slice(i, i + BATCH_SIZE);
        const message = {
          tokens: batchTokens,
          notification: { title: payload.title, body: payload.body },
          data: { ...payload.data, type: payload.type || 'admin_broadcast' },
          android: { priority: 'high' }
        };
        const response = await admin.messaging().sendEachForMulticast(message);
        successCount += response.successCount;
        failureCount += response.failureCount;
      }
    }

    console.log(`[FCM] Broadcast to ${targetAudience}: ${successCount} successes, ${failureCount} failures.`);
    return { success: successCount, failure: failureCount, fcmCount: fcmTokens.length };
  } catch (error) {
    console.error(`[FCM] Broadcast error:`, error.message);
    throw error;
  }
};

module.exports = {
  sendPushNotification,
  updateFloatingBubble,
  sendToVendor,
  sendToCustomer,
  broadcastToUsers
};
