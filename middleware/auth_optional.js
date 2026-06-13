const admin = require('firebase-admin');

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
    // DEV MOCK: Vendor Token
    if (idToken === 'mock-session-token-123') {
      req.user = {
        uid: 'mock-uid-123',
        phoneNumber: '+919999999999',
        email: 'dev@test.com'
      };
      return next();
    }

    // DEV MOCK: Customer Token
    if (idToken === 'mock-customer-token-123') {
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
    } else {
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
    next();
  } catch (error) {
    // If token is invalid, we still treat as unauthenticated rather than failing
    console.warn('[AUTH-OPTIONAL] Invalid token provided, proceeding as guest');
    next();
  }
};

module.exports = firebaseAuthOptional;
