const admin = require('firebase-admin');
const { setContext } = require('../lib/logContext');

// Demo footgun gate (see middleware/auth.js). Mock tokens / unverified decode
// are honored ONLY when DEV_BYPASS=on.
const DEV_BYPASS = process.env.DEV_BYPASS === 'on';

/**
 * Optional Authentication Middleware
 * Tries to verify the token if present, but does not fail if missing.
 */
const firebaseAuthOptional = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(); // Proceed without req.user
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    // DEV MOCK tokens — DEV_BYPASS only.
    if (DEV_BYPASS && idToken === 'mock-session-token-123') {
      req.user = {
        uid: 'mock-uid-123',
        phoneNumber: '+919999999999',
        email: 'dev@test.com'
      };
      return next();
    }
    if (DEV_BYPASS && idToken === 'mock-customer-token-123') {
      req.user = {
        uid: 'mock-uid-customer-123',
        phoneNumber: '+917777777777',
        email: 'customer@test.com'
      };
      return next();
    }

    if (admin.apps.length > 0) {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      req.user = decodedToken;
    } else if (DEV_BYPASS) {
      let decoded = null;
      try {
        if (idToken.includes('.')) {
          const payload = idToken.split('.')[1];
          decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
        }
      } catch (e) {}

      const uid = decoded?.user_id || decoded?.sub || idToken.substring(0, 10);
      req.user = {
        uid: uid,
        phoneNumber: decoded?.phone_number || 'unknown',
        email: decoded?.email,
        name: decoded?.name
      };
    }
    // else: Firebase not initialized and DEV_BYPASS=off → proceed as guest (optional auth).
    if (req.user && (req.user.uid || req.user.user_id || req.user.sub)) {
      setContext({ userId: req.user.uid || req.user.user_id || req.user.sub });
    }
    next();
  } catch (error) {
    // If token is invalid, we still treat as unauthenticated rather than failing
    console.warn('[AUTH-OPTIONAL] Invalid token provided, proceeding as guest');
    next();
  }
};

module.exports = firebaseAuthOptional;
