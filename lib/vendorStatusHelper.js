const { prisma } = require('./prisma');
const fcm = require('./fcm');
const { emitVendorStatusUpdate } = require('./socket');
const { ACTIVE_ORDER_STATUSES } = require('./orderStatus');

/**
 * Checks if a vendor is in 'stop_new_orders' mode and has no remaining active orders.
 * If so, transitions them to 'offline' automatically.
 * Call this function whenever an order transitions to a terminal state (delivered, cancelled, etc.)
 */
async function checkAndTransitionVendorOffline(vendorId) {
  try {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor || vendor.onlineStatus !== 'stop_new_orders') {
      return; // Only care about vendors trying to go offline
    }

    // Must include in-flight DELIVERY statuses too, or a vendor goes offline the moment a
    // rider is assigned — while their order is still out there.
    const activeOrdersCount = await prisma.order.count({
      where: {
        vendorId: vendorId,
        status: { in: ACTIVE_ORDER_STATUSES }
      }
    });

    if (activeOrdersCount === 0) {
      console.log(`[VENDOR-STATUS] Vendor ${vendorId} has 0 active orders. Transitioning from stop_new_orders to offline.`);
      await prisma.vendor.update({ 
        where: { id: vendorId }, 
        data: { onlineStatus: 'offline' } 
      });
      await fcm.updateFloatingBubble(vendorId, false);
      emitVendorStatusUpdate(vendorId, false);
    }
  } catch (error) {
    console.error(`[VENDOR-STATUS] Error checking offline transition for vendor ${vendorId}:`, error.message);
  }
}

module.exports = {
  checkAndTransitionVendorOffline
};
