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
      socket.rooms.forEach(room => socket.leave(room)); // Cleanup
    });

    socket.on('join_vendor_room', (vendorId) => {
      // Prevent Room Spoofing: Validate vendorId belongs to authenticated user
      // Note: In production, you would do a DB lookup here to ensure socket.user.uid == vendor.profile.firebaseUid
      if (!socket.user) {
        console.warn(`[SOCKET] SPOOF ATTEMPT: Unauthenticated socket tried to join vendor_${vendorId}`);
        return socket.disconnect(true);
      }
      socket.join(`vendor_${vendorId}`);
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
 * Emit Location Update
 */
const emitLocationUpdate = (orderId, lat, lng, pickupEta = null, dropEta = null, vendorId = null) => {
  if (!io) return;
  io.of('/customer').to(`order_${orderId}`).emit('rider_location_update', { lat, lng, pickupEta, dropEta });
  io.of('/admin').to('admin_global').emit('rider_location_update', { orderId, lat, lng, pickupEta, dropEta });
  if (vendorId) {
    io.of('/vendor').to(`vendor_${vendorId}`).emit('rider_location_update', { orderId, lat, lng, pickupEta, dropEta });
  }
};

/**
 * Emit Order Status Change
 */
const emitOrderStatusUpdate = (orderId, status, actor, vendorId = null) => {
  if (!io) return;
  io.of('/customer').to(`order_${orderId}`).emit('order_status_update', { orderId, status, updatedBy: actor });
  io.of('/admin').to('admin_global').emit('order_status_update', { orderId, status, updatedBy: actor });
  if (vendorId) {
    io.of('/vendor').to(`vendor_${vendorId}`).emit('order_status_update', { orderId, status, updatedBy: actor });
  }
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
