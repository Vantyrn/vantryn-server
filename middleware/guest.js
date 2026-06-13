const { prisma } = require('../lib/prisma');
const { v4: uuidv4 } = require('uuid');

/**
 * Middleware to handle Guest Sessions.
 * If user is not authenticated, it checks for a guest ID.
 * If no guest ID is provided, it creates one (optional, or via dedicated endpoint).
 */
const guestSession = async (req, res, next) => {
  const guestId = req.headers['x-guest-id'];

  if (!guestId) {
    // If no guest ID, the frontend should ideally call /api/auth/guest first
    // but we can generate one if it's a browsing request.
    const newGuestId = `guest_${uuidv4()}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    try {
      await prisma.guestSession.create({
        data: {
          guestId: newGuestId,
          expiresAt
        }
      });
      
      req.guestId = newGuestId;
      res.setHeader('x-guest-id', newGuestId);
      return next();
    } catch (error) {
      console.error('[GUEST] Failed to create guest session:', error);
      return res.status(500).json({ error: 'Failed to initialize guest session', details: error.message });
    }
  }

  try {
    const session = await prisma.guestSession.findUnique({
      where: { guestId }
    });

    const isMissing = !session;
    const isExpired = session && new Date() > session.expiresAt;

    if (isMissing || isExpired) {
      console.log(`[GUEST] ${isMissing ? 'Missing' : 'Expired'} session for ID: ${guestId}. Regenerating...`);
      // Re-use logic for new session creation
      const newGuestId = `guest_${uuidv4()}`;
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      await prisma.guestSession.create({
        data: { guestId: newGuestId, expiresAt }
      });
      
      req.guestId = newGuestId;
      res.setHeader('x-guest-id', newGuestId);
      return next();
    }

    req.guestId = guestId;
    next();
  } catch (error) {
    console.error('[GUEST] Verification Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = guestSession;
