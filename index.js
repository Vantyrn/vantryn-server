// Env precedence: backend-local .env (canonical per SETUP_CREDENTIALS.md) wins,
// then the legacy monorepo-root files fill any gaps. The backend-local file is
// loaded first with override so it is authoritative for this service.
const _path = require('path');
require('dotenv').config({ path: _path.resolve(__dirname, '.env') });
require('dotenv').config({ path: _path.resolve(__dirname, '../.env.server'), override: false });
require('dotenv').config({ path: _path.resolve(__dirname, '../.env'), override: false });

// Central observability (workflow §4.5) — initialize error tracking as early as
// possible, then bring up the structured logger + request correlation.
const { initSentry, captureException } = require('./lib/sentry');
initSentry();
const logger = require('./lib/logger');
const requestContext = require('./middleware/requestContext');

// Loud boot-time env assertions — refuse to run insecurely (footgun #7).
require('./lib/checkEnv')();

const express = require('express'); // Ping for redeploy
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
app.set('etag', false); // Disable ETags to prevent React Native 304 caching bugs
const server = http.createServer(app);

// REQUEST CORRELATION + STRUCTURED LOGGING (highest priority — opens the
// AsyncLocalStorage scope so every downstream log carries requestId/userId/orderId).
app.use(requestContext);

const PORT = process.env.PORT || 3000;

// ==========================================
// STAGE 1: IMMEDIATE BINDING
// ==========================================
// We start listening IMMEDIATELY to pass Railway's health check.
// Heavy routes and services will load in the background.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [STAGE 1] Server running on http://0.0.0.0:${PORT}`);
  console.log(`🌐 [HEALTH] Health check available at /health`);
});

// ==========================================
// STAGE 2: MIDDLEWARE & CONFIG
// ==========================================
// (Request logging + correlation is handled by requestContext, mounted above.)

// URL Rewrite Middleware for push-token compat with older/mismatched frontend versions
app.use((req, res, next) => {
  if (req.url === '/vendor/push-token') {
    console.log(`[URL-REWRITE] Rewriting ${req.url} to /api/vendor/push-token`);
    req.url = '/api/vendor/push-token';
  }
  next();
});

app.use(helmet({ contentSecurityPolicy: false }));

// Timeout Middleware (30 seconds)
app.use((req, res, next) => {
  req.setTimeout(30000, () => {
    let err = new Error('Request Timeout');
    err.status = 408;
    next(err);
  });
  res.setTimeout(30000, () => {
    let err = new Error('Service Unavailable - Timeout');
    err.status = 503;
    next(err);
  });
  next();
});

// Enhanced CORS for Expo/Mobile
app.use(cors({
  origin: '*', // For production, replace with specific origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '5mb', extended: true }));

console.log('🚀 [STAGE 2] Basic middleware initialized.');

// Health Check (Both root and /api/health)
const healthHandler = (req, res) => res.status(200).json({ 
  status: 'live', 
  timestamp: new Date().toISOString(),
  env: process.env.NODE_ENV,
  uptime: process.uptime()
});

app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// ==========================================
// STAGE 2.5: FIREBASE ADMIN INIT
// ==========================================
try {
  const admin = require('firebase-admin');
  if (admin.apps.length === 0) {
    // Accept EITHER the single-JSON var OR the three split vars (SETUP_CREDENTIALS.md
    // documents both). Previously only FIREBASE_SERVICE_ACCOUNT was checked, so a
    // project configured with split vars silently fell back to MOCK auth (footgun #7).
    const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT;
    let credentialSource = null;

    if (serviceAccountVar) {
      try {
        credentialSource = JSON.parse(serviceAccountVar);
      } catch (parseError) {
        console.error('❌ [FIREBASE] Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:', parseError.message);
      }
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      credentialSource = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Env files store the key with literal "\n" — convert back to real newlines.
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      };
    }

    if (credentialSource) {
      try {
        admin.initializeApp({ credential: admin.credential.cert(credentialSource) });
        logger.info('firebase.init.success', { projectId: credentialSource.projectId || credentialSource.project_id });
        console.log('✅ [FIREBASE] Admin SDK initialized successfully.');
      } catch (initError) {
        logger.error('firebase.init.failed', { errMessage: initError.message });
        console.error('❌ [FIREBASE] initializeApp failed:', initError.message);
      }
    } else {
      logger.warn('firebase.init.missing_credentials');
      console.warn('⚠️ [FIREBASE] No service-account credentials (FIREBASE_SERVICE_ACCOUNT or FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY). Auth will run in mock/fallback mode.');
    }
  }
} catch (fbError) {
  console.error('❌ [FIREBASE] Initialization error:', fbError.message);
}

// ==========================================
// STAGE 3: HEAVY INITIALIZATION (Background)
// ==========================================
(async () => {
  try {
    console.log('📦 [STAGE 3] Loading heavy modules...');
    
    // 1. Socket.io
    const { initSocket } = require('./lib/socket');
    initSocket(server);
    console.log('✅ [STAGE 3] Socket.io initialized.');

    // 2. Database Pre-flight
    const { prisma } = require('./lib/prisma');
    console.log('🔍 [STAGE 3] Testing Database Connection...');
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ [STAGE 3] Database Connection Successful.');

    // 3. Routes
    console.log('🛣️ [STAGE 3] Loading routes...');
    const browsingRoutes = require('./routes/browsing');
    const customerRoutes = require('./routes/customer');
    const vendorRoutes = require('./routes/vendor');
    const orderRoutes = require('./routes/orders');
    const authRoutes = require('./routes/auth');
    const cartRoutes = require('./routes/cart');
    const paymentRoutes = require('./routes/payments');
    const storageRoutes = require('./routes/storage');
    const shadowfaxRoutes = require('./src/modules/delivery/shadowfax/shadowfax.routes');
    const feedbackRoutes = require('./routes/feedback');
    const complaintRoutes = require('./routes/complaints');

    app.use('/api/auth', authRoutes);
    app.use('/api/browsing', browsingRoutes);
    app.use('/api/customer', customerRoutes);
    app.use('/api/vendor', vendorRoutes);
    app.use('/api/orders', orderRoutes);
    app.use('/api/cart', cartRoutes);
    app.use('/api/payments', paymentRoutes);
    app.use('/api/storage', storageRoutes);
    app.use('/api/delivery/shadowfax', shadowfaxRoutes);
    app.use('/api/feedback', feedbackRoutes);
    app.use('/api/customer/complaints', complaintRoutes);
    app.use('/api/admin', require('./routes/admin'));
    app.use('/api/sandbox', require('./routes/sandbox'));
    app.use('/api/telemetry', require('./routes/telemetry'));

    // Stage 3 Diagnostic health
    app.get('/api/health/status', (req, res) => {
      res.json({
        stage3: true,
        db: 'connected',
        timestamp: new Date().toISOString()
      });
    });

    // 404 Handler (Phase 1)
    app.use((req, res) => {
      logger.warn('route.not_found', { method: req.method, url: req.originalUrl });
      res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.originalUrl} does not exist`,
        path: req.originalUrl
      });
    });

    // Global Error Handler (Phase 1) — logs with full correlation + ships to GlitchTip.
    app.use((err, req, res, next) => {
      const status = err.status || 500;
      logger.error('request.error', {
        errMessage: err.message,
        stack: err.stack,
        code: err.code,
        url: req.originalUrl,
        method: req.method,
        statusCode: status,
      });
      if (status >= 500) captureException(err, { url: req.originalUrl, method: req.method });

      res.status(status).json({
        error: 'Internal Server Error',
        message: err.message || 'An unexpected error occurred',
        code: err.code || 'UNKNOWN_ERROR'
      });
    });

    console.log('✅ [STAGE 3] Routes and Error Handlers loaded.');

  } catch (err) {
    console.error('❌ [CRITICAL] Stage 3 Initialization Failure:');
    console.error('   Error Name:', err.name);
    console.error('   Error Message:', err.message);
    if (err.stack) console.error('   Stack Trace:', err.stack);
    
    // We don't exit(1) here because we want the health check to stay alive 
    // so we can debug via logs.
  }
})();

// ==========================================
// GRACEFUL SHUTDOWN & GLOBAL ERROR HANDLERS
// ==========================================
const shutdown = async (signal) => {
  console.log(`\n🛑 [SHUTDOWN] Received ${signal}. Closing gracefully...`);
  server.close(async () => {
    console.log('✅ [SHUTDOWN] HTTP server closed.');
    try {
      const { prisma } = require('./lib/prisma');
      if (prisma) await prisma.$disconnect();
      console.log('✅ [SHUTDOWN] Prisma disconnected.');
      
      const { connection } = require('./lib/redis');
      if (connection) {
        connection.disconnect();
        console.log('✅ [SHUTDOWN] Redis disconnected.');
      }
      process.exit(0);
    } catch (err) {
      console.error('❌ [SHUTDOWN] Error during cleanup:', err);
      process.exit(1);
    }
  });
  
  // Force kill if it takes too long (10s)
  setTimeout(() => {
    console.error('❌ [SHUTDOWN] Forcefully terminating after 10s.');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('process.uncaughtException', { errMessage: err.message, stack: err.stack });
  captureException(err, { fatal: true, kind: 'uncaughtException' });
  shutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('process.unhandledRejection', { errMessage: err.message, stack: err.stack });
  captureException(err, { kind: 'unhandledRejection' });
});
