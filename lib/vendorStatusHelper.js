const { prisma } = require('./prisma');
const fcm = require('./fcm');
const { emitVendorStatusUpdate } = require('./socket');

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

    const activeOrdersCount = await prisma.order.count({
      where: {
        vendorId: vendorId,
        status: { in: ['preparing', 'ready_for_pickup', 'accepted'] }
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
