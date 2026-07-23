const { prisma } = require('../lib/prisma');
const logger = require('../lib/logger');
const { orderSlaQueue } = require('../lib/bullmq');
const { emitOrderStatusUpdate, emitIncomingOrder } = require('../lib/socket');
const fcm = require('../lib/fcm');
const { checkAndTransitionVendorOffline } = require('../lib/vendorStatusHelper');
const { ACTIVE_ORDER_STATUSES } = require('../lib/orderStatus');

/**
 * Order Service for managing order lifecycle, status changes, and notifications.
 */
class OrderService {
  /**
   * Create order after payment verification
   */
  static async createOrderFromCart(cart, customerId, customerName, deliveryPreference, paymentMethod = null, paymentGatewayRef = null, deliveryFee = 0, options = {}) {
    if (!cart.vendorId) {
      console.error('[ORDER-SERVICE] CRITICAL: Attempted to create order with NO vendorId');
      throw new Error('CART_INVALID: Missing vendor identification');
    }

    // 1. Check Vendor Availability.
    // skipVendorAvailabilityCheck is set when the money is ALREADY collected (a
    // confirmed UPI payment): a paid order must be created even if the vendor just
    // went offline — the order is honored and the vendor handles it on return.
    if (!options.skipVendorAvailabilityCheck) {
      const vendor = await prisma.vendor.findUnique({ where: { id: cart.vendorId } });
      if (!vendor || vendor.onlineStatus !== 'online') {
        throw new Error('VENDOR_OFFLINE: Vendor is currently not accepting orders.');
      }
      // Reachability guard (see lib/vendorReachable.js): a stale 'online' vendor killed
      // their app and can't take this order. Flip them offline and refuse. NOT applied to
      // the skip path — a confirmed UPI payment is honored even if the vendor just dropped.
      const { isVendorReachable } = require('../lib/vendorReachable');
      if (!isVendorReachable(vendor)) {
        await prisma.vendor.update({ where: { id: vendor.id }, data: { onlineStatus: 'offline' } }).catch(() => {});
        try { require('../lib/socket').emitVendorStatusUpdate(vendor.id, false); } catch (_) {}
        throw new Error('VENDOR_OFFLINE: Vendor just went offline and is not accepting orders.');
      }

      const { checkVendorAvailability } = require('../lib/availability');
      const { isOpen, nextOpen } = checkVendorAvailability(vendor.operatingHours);
      if (vendor.onlineStatus !== 'online' && !isOpen) {
        throw new Error(`VENDOR_CLOSED: Vendor is currently closed. Reopening ${nextOpen || 'soon'}.`);
      }
    }

    // Pin to the address chosen at checkout when provided (options.addressId); otherwise
    // fall back to the customer's latest address.
    let activeAddress = null;
    if (options.addressId) {
      activeAddress = await prisma.address.findUnique({ where: { id: options.addressId } }).catch(() => null);
    }
    if (!activeAddress) {
      activeAddress = await prisma.address.findFirst({
        where: { customerId: customerId },
        orderBy: { createdAt: 'desc' }
      });
    }

    const addressSnapshot = activeAddress || { addressLine1: 'Default Address' };

    const order = await prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          vendorId: cart.vendorId,
          customerId: customerId,
          addressSnapshot: addressSnapshot,
          subtotal: Number(cart.subtotal || 0),
          addonCharges: Number(cart.totalAddonCharges || 0),
          deliveryFee: Number(deliveryFee),
          totalAmount: Number(cart.total || 0) + Number(deliveryFee),
          status: 'pending_vendor',
          deliveryPreference: deliveryPreference || 'standard',
          paymentMethod: paymentMethod,
          paymentGatewayRef: paymentGatewayRef,
          ageVerifiedCheckbox: cart.items.some(i => i.ageVerified),
          statusHistory: {
            create: {
              status: 'pending_vendor',
              changedBy: 'CUSTOMER'
            }
          },
          items: {
            create: cart.items.map(item => ({
              productId: item.productId,
              productName: item.name || 'Unknown Product',
              quantity: item.quantity,
              unitPrice: Number(item.unitPrice || item.price || 0),
              lineTotal: Number(item.total || 0),
              addonsSummary: {
                selectedAddons: item.options?.selectedAddons || [],
                customizations: item.options?.customizations || [],
                instructions: item.options?.instructions || null
              }
            }))
          }
        },
        include: {
          items: true
        }
      });

      // Log in SlaMetric table
      await tx.vendorSlaMetric.upsert({
        where: { vendorId: cart.vendorId },
        update: { totalOrders: { increment: 1 } },
        create: { vendorId: cart.vendorId, totalOrders: 1 }
      });

      // 2. Clear the cart
      await tx.cart.delete({ where: { id: cart.id } });

      return newOrder;
    });

    console.log('[ORDER-SERVICE] Order created:', { id: order.id, total: order.totalAmount });

    // suspicious order detection (> ₹50,000)
    const orderTotal = Number(order.totalAmount);
    if (orderTotal > 50000) {
      console.log(`[ORDER-SERVICE] Suspicious high-value order detected: ₹${orderTotal}. Flagging and cancelling.`);
      const cancelledOrder = await prisma.order.update({
        where: { id: order.id },
        data: { 
          status: 'CANCELLED',
          isFlagged: true,
          isFlaggedAdmin: true,
          flagReason: `High Value Order (₹${orderTotal})`,
          statusHistory: {
            create: {
              status: 'CANCELLED',
              changedBy: 'SYSTEM',
              notes: 'Auto-cancelled: High value suspicious order detected.'
            }
          }
        },
        include: {
          customer: {
            include: { profile: true }
          },
          items: true
        }
      });

      console.log(`[ORDER-SERVICE] Creating breach record for high-value order ${order.id}`);
      logger.warn('order.sla.breach', { event: 'order.sla.breach', orderId: order.id, vendorId: cart.vendorId, type: 'SUSPICIOUS_ORDER', orderTotal });
      try {
        await prisma.vendorBreach.create({
          data: {
            vendorId: cart.vendorId,
            orderId: order.id,
            type: 'SUSPICIOUS_ORDER',
            reason: `High value order detected (₹${orderTotal}). Automatic cancellation and flagging applied.`
          }
        });
      } catch (err) {
        console.error(`[ORDER-SERVICE] FAILED to create breach record: ${err.message}`);
      }

      // Emit real-time status update to client sockets:
      emitOrderStatusUpdate(order.id, 'CANCELLED', 'SYSTEM', cart.vendorId);

      // Send emoji-free push notification:
      if (cancelledOrder.customer?.profile?.firebaseUid) {
        try {
          await fcm.sendToCustomer(cancelledOrder.customer.profile.firebaseUid, {
            title: 'Order Cancelled',
            body: 'Order was automatically cancelled by the system due to security verification.',
            orderId: order.id
          });
        } catch (fcmErr) {
          console.error(`[ORDER-SERVICE] Failed to send customer push: ${fcmErr.message}`);
        }
      }

      // Send push notification to vendor:
      try {
        await fcm.sendToVendor(cart.vendorId, {
          title: 'Order Cancelled',
          body: 'Order was automatically cancelled by the system due to security verification.',
          orderId: order.id,
          type: 'SYSTEM_CANCELLATION'
        });
      } catch (fcmErr) {
        console.error(`[ORDER-SERVICE] Failed to send vendor push: ${fcmErr.message}`);
      }

      // Return early, bypassing vendor notifications, floating bubble updates, BullMQ SLA queueing, and Shadowfax delivery.
      return cancelledOrder;
    }

    // 3. Fire Notifications
    // 3. Enrich items with names for the socket event
    const allIds = new Set();
    const isUuid = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    
    order.items.forEach(i => {
      const summary = typeof i.addonsSummary === 'string' ? JSON.parse(i.addonsSummary) : i.addonsSummary;
      if (summary.selectedAddons) {
        summary.selectedAddons.forEach(a => {
          const id = typeof a === 'object' ? a.id : a;
          if (id && isUuid(id) && !(typeof a === 'object' && a.name)) allIds.add(id);
        });
      }
      if (summary.customizations) {
        summary.customizations.forEach(c => {
          if (c.selectedOptions) {
            c.selectedOptions.forEach(opt => {
              const id = typeof opt === 'object' ? opt.id : opt;
              if (id && isUuid(id) && !(typeof opt === 'object' && opt.name)) allIds.add(id);
            });
          }
        });
      }
    });

    const nameMap = new Map();
    if (allIds.size > 0) {
      const [addons, options] = await Promise.all([
        prisma.productAddon.findMany({ where: { id: { in: Array.from(allIds) } }, select: { id: true, name: true } }),
        prisma.customizationOption.findMany({ where: { id: { in: Array.from(allIds) } }, select: { id: true, name: true } })
      ]);
      addons.forEach(a => nameMap.set(a.id, a.name));
      options.forEach(o => nameMap.set(o.id, o.name));
    }

    const formattedOrder = {
      ...order,
      customerName: customerName,
      total: Number(order.totalAmount),
      items: order.items.map(i => {
        const details = [];
        const summary = typeof i.addonsSummary === 'string' ? JSON.parse(i.addonsSummary) : i.addonsSummary;
        if (summary.selectedAddons) {
          summary.selectedAddons.forEach(a => {
            const name = (typeof a === 'object' && a.name) ? a.name : nameMap.get(typeof a === 'object' ? a.id : a);
            const qty = (typeof a === 'object' && typeof a.quantity === 'number') ? a.quantity : 1;
            if (name && !isUuid(name)) {
              details.push(qty > 1 ? `${qty}x ${name}` : name);
            }
          });
        }
        if (summary.customizations) {
          summary.customizations.forEach(c => {
            if (c.selectedOptions) {
              c.selectedOptions.forEach(opt => {
                const name = (typeof opt === 'object' && opt.name) ? opt.name : nameMap.get(typeof opt === 'object' ? opt.id : opt);
                const qty = (typeof opt === 'object' && typeof opt.quantity === 'number') ? opt.quantity : 1;
                if (name && !isUuid(name)) {
                  details.push(qty > 1 ? `${qty}x ${name}` : name);
                }
              });
            }
          });
        }
        return { 
          qty: i.quantity, 
          name: i.productName,
          addons: details,
          instructions: summary.instructions || null
        };
      })
    };
    emitIncomingOrder(cart.vendorId, formattedOrder);
    
    emitOrderStatusUpdate(order.id, 'pending_vendor', 'CUSTOMER');
    
    // Update Floating Bubble
    const activeOrdersCount = await prisma.order.count({
      where: { vendorId: cart.vendorId, status: { in: ACTIVE_ORDER_STATUSES } }
    });
    fcm.updateFloatingBubble(cart.vendorId, true, activeOrdersCount);

    await fcm.sendToVendor(cart.vendorId, {
      title: 'New Order Received',
      body: `Order #${order.id.substring(0,8)} is awaiting your acceptance.`,
      orderId: order.id
    });

    // 4. Start BullMQ SLA Timer (5 minutes)
    await orderSlaQueue.add('vendorSlaTimeout', 
      { orderId: order.id, type: 'vendor_accept' }, 
      { delay: 5 * 60 * 1000 }
    );

    return order;
  }

  /**
   * Update order status and notify all parties
   */
  static async updateOrderStatus(orderId, newStatus, actorRole) {
    const orderToUpdate = await prisma.order.findUnique({ where: { id: orderId } });
    if (!orderToUpdate) throw new Error('Order not found');

    const terminalStatuses = ['CANCELLED', 'CANCELLED_BY_VENDOR', 'ORDER_CANCELLED'];
    if (terminalStatuses.includes(newStatus.toUpperCase())) {
      try {
        const deliveryService = require('../src/modules/delivery/delivery.service');
        await deliveryService.cancelDelivery(orderId, `Order cancelled by ${actorRole}`);
      } catch (sfxErr) {
        console.warn(`[ORDER-SERVICE] Failed to cancel SFX delivery for order ${orderId}:`, sfxErr.message);
      }
    }

    const order = await prisma.order.update({
      where: { id: orderId },
      data: { 
        status: newStatus,
        statusHistory: {
          create: {
            status: newStatus,
            changedBy: actorRole
          }
        },
        // Automatically track preparingAt and readyAt timestamps
        ...(newStatus === 'preparing' ? { preparingAt: new Date() } : {}),
        ...(newStatus === 'ready_for_pickup' ? { readyAt: new Date() } : {}),
        
        // Refund Logic: Trigger if cancelled and payment exists (Payment Agnostic)
        ...(terminalStatuses.includes(newStatus.toUpperCase()) && orderToUpdate.paymentGatewayRef ? {
          refundStatus: 'PENDING',
          refundAmount: orderToUpdate.totalAmount
        } : {})
      },
      include: { 
        customer: {
          include: { profile: true }
        }
      }
    });

    emitOrderStatusUpdate(orderId, newStatus, actorRole, order.vendorId);

    // Central journey event for every order status transition (accept, preparing,
    // ready, dispatched, delivered, cancelled) — queryable in Loki by orderId.
    logger.info('order.status_changed', {
      event: 'order.status_changed',
      orderId,
      vendorId: order.vendorId,
      previousStatus: orderToUpdate.status,
      newStatus,
      actorRole,
    });

    if (order.customer?.profile?.firebaseUid) {
      let title = `Order Update: ${newStatus}`;
      let body = `Your order status has changed to ${newStatus}.`;
      
      const cleanStatus = newStatus.toLowerCase();
      if (cleanStatus === 'accepted') {
        title = 'Order Accepted!';
        body = 'Your order has been accepted and is now being prepared.';
      } else if (cleanStatus === 'preparing') {
        title = 'Preparing your Order';
        body = 'The kitchen is busy preparing your delicious food!';
      } else if (cleanStatus === 'ready_for_pickup') {
        title = 'Order Ready!';
        body = 'Your order is ready for pickup or rider assignment.';
      } else if (cleanStatus === 'out_for_delivery' || cleanStatus === 'picked_up' || cleanStatus === 'dispatched') {
        title = 'Out for Delivery!';
        body = 'Great news! Your order is out for delivery with our rider.';
      } else if (cleanStatus === 'delivered') {
        title = 'Order Delivered!';
        body = 'Your order has been successfully delivered. Enjoy your meal!';
      } else if (cleanStatus === 'cancelled_by_vendor' || cleanStatus === 'cancelled') {
        title = 'Order Cancelled';
        body = 'We are sorry, your order was cancelled by the store.';
      }

      await fcm.sendToCustomer(order.customer.profile.firebaseUid, {
        title,
        body,
        orderId: order.id
      });
    }

    // Analytics and Offline Check for terminal states (case-insensitive)
    const upperStatus = newStatus.toUpperCase();
    if (['DELIVERED', 'CANCELLED', 'CANCELLED_BY_VENDOR', 'ORDER_CANCELLED'].includes(upperStatus)) {
      await checkAndTransitionVendorOffline(order.vendorId);
      
      if (upperStatus === 'DELIVERED') {
        // Create Vendor Earning Record
        try {
          const v = await prisma.vendor.findUnique({ where: { id: order.vendorId } });
          const orderTotal = Number(order.totalAmount);
          const rate = Number(v?.commissionRate || 5.0);
          const commissionAmt = (orderTotal * rate) / 100;
          const payout = orderTotal - commissionAmt;

          await prisma.vendorEarning.upsert({
            where: { orderId: orderId },
            update: {
              orderTotal: orderTotal,
              commissionRate: rate,
              commissionAmt: commissionAmt,
              vendorPayout: payout,
              earnedAt: new Date()
            },
            create: {
              vendorId: order.vendorId,
              orderId: orderId,
              orderTotal: orderTotal,
              commissionRate: rate,
              commissionAmt: commissionAmt,
              vendorPayout: payout,
              earnedAt: new Date()
            }
          });
          console.log(`[ORDER-SERVICE] Earning record created for order ${orderId}`);
        } catch (earningErr) {
          console.error(`[ORDER-SERVICE] Failed to create earning record: ${earningErr.message}`);
        }

        await prisma.analyticsEvent.create({
          data: {
            event: 'order_completed',
            orderId: orderId,
            customerId: order.customerId,
            firedAt: new Date()
          }
        });
      }
    }

    return order;
  }
}

module.exports = OrderService;
