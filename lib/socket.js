const { Server } = require('socket.io');
const { prisma } = require('./prisma');
const admin = require('firebase-admin');

let io;

/**
 * Socket Authentication Middleware
 */
const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
    
    // We allow unauthenticated connections for customer namespace (e.g. browsing vendors without logging in)
    // but we will enforce auth when trying to join specific protected rooms.
    if (!token) {
      socket.user = null;
      return next();
    }
    
    // DEV MOCK: Vendor Token (Supports dynamic phone numbers)
    if (token.startsWith('mock-session-token-')) {
      const phone = '+' + token.replace('mock-session-token-', '');
      socket.user = { 
        uid: `mock-uid-${phone.replace(/[^0-9]/g, '')}`, 
        phoneNumber: phone, 
        email: 'dev@test.com' 
      };
      return next();
    }
    
    // DEV MOCK: Customer Token
    if (token === 'mock-customer-token-123') {
      socket.user = { uid: 'mock-uid-customer-123', phoneNumber: '+917777777777', email: 'customer@test.com' };
      return next();
    }
    
    // If admin app isn't initialized yet, we skip token verification
    if (admin.apps.length > 0) {
      const decodedToken = await admin.auth().verifyIdToken(token);
      socket.user = decodedToken;
    } else {
      socket.user = { uid: 'mock_uid_due_to_missing_admin' };
    }
    
    next();
  } catch (error) {
    console.warn(`[SOCKET] Auth token validation failed: ${error.message}`);
    // Still allow connection, but flag as unauthenticated
    socket.user = null;
    next();
  }
};

// ── Auto-offline-on-app-close ──────────────────────────────────────────────
// DISABLED BY DEFAULT. A backgrounded vendor app (with the floating bubble up) is
// still ONLINE, but Android throttles its socket in the background so the server sees
// a "disconnect" within ~30–45s — which previously flipped a perfectly-online vendor
// OFFLINE while the bubble still showed online. Since the socket can't tell
// "backgrounded-but-alive" from "killed", we no longer auto-offline on disconnect:
// the vendor stays online until they explicitly go offline (the bubble model).
// Re-enable only with a proper foreground-service heartbeat by setting
// VENDOR_AUTO_OFFLINE_ON_DISCONNECT=on (grace then applies).
const VENDOR_OFFLINE_GRACE_MS = 5 * 60 * 1000;
const pendingVendorOffline = new Map(); // vendorId -> timeout handle

function cancelVendorAutoOffline(vendorId) {
  const t = pendingVendorOffline.get(vendorId);
  if (t) {
    clearTimeout(t);
    pendingVendorOffline.delete(vendorId);
  }
}

function scheduleVendorAutoOffline(vendorId, vendorNs) {
  // Off unless explicitly enabled (see note above) — keeps backgrounded vendors online.
  if (process.env.VENDOR_AUTO_OFFLINE_ON_DISCONNECT !== 'on') return;
  cancelVendorAutoOffline(vendorId); // collapse duplicate disconnects into one timer
  const handle = setTimeout(async () => {
    pendingVendorOffline.delete(vendorId);
    try {
      // If ANY socket is still in this vendor's room, they reconnected → do nothing.
      const room = vendorNs.adapter.rooms.get(`vendor_${vendorId}`);
      if (room && room.size > 0) return;

      // Only flip vendors who are currently 'online' (leave 'stop_new_orders' /
      // already-offline untouched so we don't fight an in-progress manual transition).
      const vendor = await prisma.vendor.findUnique({
        where: { id: vendorId },
        select: { onlineStatus: true },
      });
      if (!vendor || vendor.onlineStatus !== 'online') return;

      await prisma.vendor.update({ where: { id: vendorId }, data: { onlineStatus: 'offline' } });
      emitVendorStatusUpdate(vendorId, false);
      console.log(`[SOCKET] Vendor ${vendorId} auto-set OFFLINE (app closed without going offline).`);
    } catch (err) {
      console.warn(`[SOCKET] Auto-offline failed for vendor ${vendorId}: ${err.message}`);
    }
  }, VENDOR_OFFLINE_GRACE_MS);
  pendingVendorOffline.set(vendorId, handle);
}

/**
 * Initialize Socket.io
 */
const initSocket = (server) => {
  // Enforce global singleton
  if (global.__io) {
    io = global.__io;
    return io;
  }

  io = new Server(server, {
    transports: ['websocket'], // ONLY WEBSOCKET - Prevents HTTP 502 polling storms
    pingTimeout: 30000,
    pingInterval: 15000,
    connectTimeout: 45000,
    allowEIO3: true,
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true
    }
  });

  global.__io = io;

  // Namespaces
  const customerNs = io.of('/customer');
  const vendorNs = io.of('/vendor');
  const adminNs = io.of('/admin');

  customerNs.use(authenticateSocket);
  vendorNs.use(authenticateSocket);
  adminNs.use(authenticateSocket);

  // Customer connections
  customerNs.on('connection', (socket) => {
    console.log(`[SOCKET] Customer connected: ${socket.id} (Auth: ${!!socket.user})`);
    
    socket.on('disconnect', (reason) => {
      console.log(`[SOCKET] Customer disconnected: ${socket.id}, Reason: ${reason}`);
      socket.rooms.forEach(room => socket.leave(room)); // Cleanup
    });
    
    socket.on('join_order_room', (orderId) => {
      if (!socket.user) {
         console.warn(`[SOCKET] Unauthenticated user tried to join order ${orderId}`);
         // Strict mode: Uncomment below to reject
         // return socket.emit('error', { message: 'Authentication required' });
      }
      socket.join(`order_${orderId}`);
      console.log(`[SOCKET] Customer joined order room: ${orderId}`);
    });
  });

  // Vendor connections
  vendorNs.on('connection', (socket) => {
    console.log(`[SOCKET] Vendor connected: ${socket.id} (Auth: ${!!socket.user})`);

    socket.on('disconnect', (reason) => {
      // Auto-offline-on-app-close: if a vendor's app is force-closed (swiped away) while
      // ONLINE, its socket drops and never rejoins. We can't run JS in the killed app, so
      // the SERVER flips them offline after a grace window — otherwise they'd keep appearing
      // online and receiving orders they can't see. A genuine reconnect (background→foreground
      // or a brief network blip) re-joins the room and cancels the pending offline.
      const vId = socket.vendorId;
      socket.rooms.forEach(room => socket.leave(room)); // Cleanup
      if (vId) scheduleVendorAutoOffline(vId, vendorNs);
    });

    socket.on('join_vendor_room', (vendorId) => {
      // Prevent Room Spoofing: only an authenticated socket may join a vendor room.
      // IMPORTANT: do NOT socket.disconnect() here — the client re-emits join_vendor_room
      // on every (re)connect, so disconnecting an unauthenticated socket causes an endless
      // connect→disconnect→reconnect storm. Just skip the join; the socket stays connected
      // and will join successfully once it presents a valid token.
      if (!socket.user) {
        console.warn(`[SOCKET] join_vendor_room skipped for vendor_${vendorId}: socket has no verified user (missing/invalid token).`);
        return;
      }
      socket.join(`vendor_${vendorId}`);
      socket.vendorId = vendorId;          // remember for disconnect handling
      cancelVendorAutoOffline(vendorId);   // a (re)connect means they're back → don't flip offline
      // A live socket is proof of life too — stamp the heartbeat so reachability stays fresh
      // even between the app's 15s profile polls.
      prisma.vendor.update({ where: { id: vendorId }, data: { bubbleLastSeenAt: new Date() } })
        .catch(() => {});
      console.log(`[SOCKET] Vendor joined room: vendor_${vendorId}`);
    });
  });

  // Admin connections
  adminNs.on('connection', (socket) => {
    if (!socket.user) {
      return socket.disconnect(true);
    }
    socket.join('admin_global');
  });

  return io;
};

/**
 * Emit Location Update.
 * The customer sees the rider's live location for the WHOLE delivery. The vendor sees it
 * ONLY until pickup — so callers pass `vendorId` only while the order is pre-pickup; after
 * pickup they pass null and the vendor receives status updates but no more coordinates.
 * `rider` (optional) carries { name, phone, id } so clients can show rider identity.
 */
const emitLocationUpdate = (orderId, lat, lng, pickupEta = null, dropEta = null, vendorId = null, rider = null) => {
  if (!io) return;
  const payload = { orderId, lat, lng, pickupEta, dropEta, rider };
  io.of('/customer').to(`order_${orderId}`).emit('rider_location_update', payload);
  io.of('/admin').to('admin_global').emit('rider_location_update', payload);
  if (vendorId) {
    io.of('/vendor').to(`vendor_${vendorId}`).emit('rider_location_update', payload);
  }
};

/**
 * Emit Order Status Change. `rider` (optional) lets the customer show who is delivering.
 */
// Customer-facing push copy per status. The socket emit above only reaches a customer
// whose app is OPEN and joined to the order room; this push reaches them when the app is
// backgrounded or closed, and tapping it opens the live tracker (type: 'ORDER_STATUS').
// Keyed lowercase; 'pending_vendor' (placement) is intentionally omitted — the
// payment-success push already says "order placed", so this avoids a duplicate.
const CUSTOMER_STATUS_PUSH = {
  accepted:            ['Order Accepted', 'The restaurant accepted your order and is getting started.'],
  preparing:           ['Preparing your order', 'Your food is being prepared.'],
  ready_for_pickup:    ['Order ready', 'Your order is packed and waiting for the rider.'],
  rider_assigned:      ['Rider assigned', 'A delivery partner is on the way to pick up your order.'],
  picked_up:           ['Out for delivery', 'Your order is on its way!'],
  out_for_delivery:    ['Out for delivery', 'Your order is on its way!'],
  arrived_at_customer: ['Rider arriving', 'Your rider is almost there.'],
  delivered:           ['Order delivered', 'Enjoy your meal! Tap to rate your order.'],
  delivery_failed:     ['Delivery issue', 'We could not complete your delivery. Support will reach out.'],
  cancelled_by_vendor: ['Order cancelled', 'Unfortunately the restaurant could not fulfil your order.'],
};

const pushCustomerStatus = async (orderId, status) => {
  const entry = CUSTOMER_STATUS_PUSH[String(status || '').toLowerCase()];
  if (!entry) return; // not a milestone worth a notification
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { customer: { select: { profile: { select: { firebaseUid: true } } } } },
    });
    const uid = order?.customer?.profile?.firebaseUid;
    if (!uid) return;
    const [title, body] = entry;
    await require('./fcm').sendToCustomer(uid, {
      title, body,
      type: 'ORDER_STATUS', // customer app routes this to /orders/track/<orderId>
      orderId,
    });
  } catch (e) {
    console.warn(`[SOCKET] Customer status push failed for order ${orderId}: ${e.message}`);
  }
};

const emitOrderStatusUpdate = (orderId, status, actor, vendorId = null, rider = null) => {
  if (!io) return;
  const payload = { orderId, status, updatedBy: actor, rider };
  io.of('/customer').to(`order_${orderId}`).emit('order_status_update', payload);
  io.of('/admin').to('admin_global').emit('order_status_update', payload);
  if (vendorId) {
    io.of('/vendor').to(`vendor_${vendorId}`).emit('order_status_update', payload);
  }
  // Fire-and-forget: never block/await a socket emit on a push round-trip.
  pushCustomerStatus(orderId, status);
};

/**
 * Emit Incoming Order to Vendor
 */
const emitIncomingOrder = (vendorId, orderData) => {
  if (!io) return;
  io.of('/vendor').to(`vendor_${vendorId}`).emit('new_incoming_order', orderData);
  io.of('/admin').to('admin_global').emit('new_order_created', orderData);
};

/**
 * Emit Vendor Status Update to all customers
 */
const emitVendorStatusUpdate = (vendorId, isOnline) => {
  if (!io) return;
  io.of('/customer').emit('vendor_status_update', { vendorId, isOnline });
};

/**
 * Emit Product Status Update to Vendor
 */
const emitProductStatusUpdate = (vendorId, productId, status) => {
  if (!io) return;
  io.of('/vendor').to(`vendor_${vendorId}`).emit('product_status_update', { productId, status });
};

/**
 * Emit Account Status Update to Vendor/Rider
 */
const emitAccountStatusUpdate = (userId, status) => {
  if (!io) return;
  io.of('/vendor').to(`vendor_${userId}`).emit('account_status_update', { status });
  io.of('/rider').to(`rider_${userId}`).emit('account_status_update', { status });
};

module.exports = {
  initSocket,
  emitLocationUpdate,
  emitOrderStatusUpdate,
  emitIncomingOrder,
  emitVendorStatusUpdate,
  emitProductStatusUpdate,
  emitAccountStatusUpdate,
  getIo: () => io
};
