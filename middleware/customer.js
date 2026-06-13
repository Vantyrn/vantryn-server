const { getOrCreateCustomerProfile } = require('../lib/prisma');

/**
 * Middleware to verify that the profile associated with the Firebase UID has a 'CUSTOMER' role.
 * Must be used after firebaseAuth middleware.
 * Self-heals by creating a profile if one doesn't exist.
 */
const requireCustomer = async (req, res, next) => {
  try {
    const { uid } = req.user;
    
    // Self-healing: Get or create the profile
    const profile = await getOrCreateCustomerProfile(req.user);

    if (!profile) {
      return res.status(403).json({ 
        error: 'Forbidden: Profile not found',
        message: 'Please login or register to continue.'
      });
    }

    // Attach profile and customer objects for downstream use
    req.profile = profile;
    req.customer = profile.customer;
    next();
  } catch (error) {
    console.error('[MIDDLEWARE] requireCustomer error:', error);
    res.status(500).json({ error: 'Internal server error during role verification' });
  }
};

module.exports = requireCustomer;
