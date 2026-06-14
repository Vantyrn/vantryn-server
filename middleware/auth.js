const admin = require('firebase-admin');
const { setContext } = require('../lib/logContext');

// Demo footgun gate: mock auth tokens are honored ONLY when DEV_BYPASS=on.
// In the pilot/staging build (DEV_BYPASS=off) they are rejected like any other
// invalid token, so real Firebase verification is the only path. (Footgun #7.)
const DEV_BYPASS = process.env.DEV_BYPASS === 'on';

// Attach the resolved user to the request AND the log-correlation context so
// every downstream log line carries userId/role.
function attachUser(req, user, role) {
  req.user = user;
  if (user && user.uid) setContext({ userId: user.uid, role });
}

const firebaseAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    // DEV MOCK: Vendor Token (Supports dynamic phone numbers) — DEV_BYPASS only.
    if (DEV_BYPASS && idToken.startsWith('mock-session-token-')) {
      const phone = '+' + idToken.replace('mock-session-token-', '');
      attachUser(req, {
        uid: `mock-uid-${phone.replace(/[^0-9]/g, '')}`,
        phoneNumber: phone,
        email: 'dev@test.com'
      }, 'vendor');
      return next();
    }

    // DEV MOCK: Customer Token — DEV_BYPASS only.
    if (DEV_BYPASS && idToken === 'mock-customer-token-123') {
      attachUser(req, {
        uid: 'mock-uid-customer-123',
        phoneNumber: '+917777777777',
        email: 'customer@test.com'
      }, 'customer');
      return next();
    }

    // REAL AUTH: If admin is initialized, we try to verify
    if (admin.apps.length > 0) {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      attachUser(req, {
        ...decodedToken,
        phoneNumber: decodedToken.phone_number || req.headers['x-mock-phone'],
        uid: decodedToken.uid || decodedToken.user_id || decodedToken.sub
      });
      return next();
    }

    // FALLBACK: decode token WITHOUT verifying — DEV_BYPASS only. In the pilot
    // build (DEV_BYPASS=off) a request reaching here means Firebase wasn't
    // initialized; reject rather than trust an unverified token.
    if (!DEV_BYPASS) {
      console.error('[AUTH] Firebase not initialized and DEV_BYPASS=off — rejecting unverifiable token.');
      return res.status(401).json({ error: 'Unauthorized: auth unavailable' });
    }
    console.warn('[BACKEND] Running in MOCK AUTH fallback mode (DEV_BYPASS=on)');

    let decoded = null;
    try {
      if (idToken.includes('.')) {
        const payload = idToken.split('.')[1];
        decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
      }
    } catch (e) {
      console.warn('[AUTH] Failed to decode JWT payload in mock mode');
    }

    const uid = decoded?.user_id || decoded?.sub || idToken.substring(0, 10);
    const phone = decoded?.phone_number || req.headers['x-mock-phone'] || `+1000${uid.replace(/[^0-9]/g, '').substring(0, 6)}`;
    
    attachUser(req, {
      uid: uid,
      phoneNumber: phone,
      name: decoded?.name || 'Mock User',
      email: decoded?.email
    });
    next();

  } catch (error) {
    console.error('Error verifying Firebase token:', error);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

module.exports = firebaseAuth;
