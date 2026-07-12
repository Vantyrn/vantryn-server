const admin = require('firebase-admin');
const axios = require('axios');

/**
 * Sends a push notification via Expo Push API
 */
const sendExpoPushNotification = async (pushToken, title, body, dataPayload = {}) => {
  if (!pushToken) return;

  try {
    const response = await axios.post('https://exp.host/--/api/v2/push/send', {
      to: pushToken,
      sound: 'default',
      title: title,
      body: body,
      data: dataPayload,
      channelId: dataPayload.channelId || 'default',
    }, {
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      }
    });
    console.log(`[EXPO-PUSH] Notification sent successfully to ${pushToken}:`, response.data);
  } catch (error) {
    console.error(`[EXPO-PUSH] Error sending message:`, error.response?.data || error.message);
  }
};

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
    const vendor = await require('./prisma').prisma.vendor.findUnique({
      where: { id: vendorId },
      include: { profile: { select: { fcmToken: true, pushToken: true } } }
    });
    
    const fcmToken = vendor?.profile?.fcmToken || vendor?.fcmToken;
    const pushToken = vendor?.profile?.pushToken || vendor?.pushToken;

    const isKyc = payload.type && payload.type.toUpperCase().startsWith('KYC');
    const channelId = isKyc ? 'kyc' : 'orders';

    if (pushToken) {
      await sendExpoPushNotification(
        pushToken,
        payload.title,
        payload.body,
        { ...payload, type: payload.type || 'NEW_ORDER', channelId }
      );
    }
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
    const profile = await require('./prisma').prisma.profile.findUnique({
      where: { firebaseUid },
      select: { fcmToken: true, pushToken: true }
    });
    
    if (profile?.pushToken) {
      await sendExpoPushNotification(
        profile.pushToken,
        payload.title,
        payload.body,
        { ...payload, type: payload.type || 'order_update', channelId: 'default' }
      );
    }
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

    if (targetAudience === 'VENDORS' || targetAudience === 'ALL') {
      const vendors = await prisma.profile.findMany({
        where: { role: 'VENDOR', fcmToken: { not: null } },
        select: { fcmToken: true }
      });
      vendors.forEach(v => { if (v.fcmToken) fcmTokens.push(v.fcmToken); });
    }

    if (targetAudience === 'CUSTOMERS' || targetAudience === 'ALL') {
      const customers = await prisma.profile.findMany({
        where: { role: 'CUSTOMER', fcmToken: { not: null } },
        select: { fcmToken: true }
      });
      customers.forEach(c => { if (c.fcmToken) fcmTokens.push(c.fcmToken); });
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
