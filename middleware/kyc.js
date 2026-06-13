const { prisma, withRetry } = require('../lib/prisma');

const requireKyc = async (req, res, next) => {
  try {
    const { uid } = req.user; // uid from Firebase token
    
    // Check Profile
    const profile = await withRetry(() => prisma.profile.findUnique({
      where: { firebaseUid: uid },
      include: { vendor: true, rider: true }
    }));


    if (!profile) {
      return res.status(403).json({ error: 'Profile not found' });
    }

    // Global Status Enforcement
    const isSuspended = profile.profileStatus === 'SUSPENDED';
    const isDisabledTemp = profile.profileStatus && profile.profileStatus.startsWith('DISABLED:');

    if (isSuspended) {
      console.warn(`[KYC] Access Denied for UID ${uid}: Account permanently suspended`);
      return res.status(403).json({ 
        error: 'Account Suspended', 
        code: 'account_suspended', 
        reason: 'Your account has been permanently suspended due to policy violations.' 
      });
    }

    if (isDisabledTemp) {
      // Check if temporary block has expired on the fly!
      const disabledUntilStr = profile.profileStatus.split('DISABLED:')[1];
      const disabledUntil = new Date(disabledUntilStr);
      if (disabledUntil < new Date()) {
        console.log(`[KYC-MIDDLEWARE] Temporary block expired. Restoring profile status for ${profile.id}`);
        await prisma.profile.update({
          where: { id: profile.id },
          data: { profileStatus: 'APPROVED' }
        });
        profile.profileStatus = 'APPROVED';
      } else {
        console.warn(`[KYC] Access Denied for UID ${uid}: Account temporarily blocked until ${disabledUntilStr}`);
        return res.status(403).json({ 
          error: 'Account Temporarily Blocked', 
          code: 'account_disabled',
          status: profile.profileStatus
        });
      }
    }

    // Role specific KYC mapping
    let isApproved = false;
    let fallbackStatus = 'PENDING';

    const APPROVED_STATUSES = ['approved', 'active', 'ready'];

    if (profile.role === 'VENDOR' && profile.vendor) {
      fallbackStatus = profile.vendor.accountStatus;
      isApproved = APPROVED_STATUSES.includes(profile.vendor.accountStatus?.toLowerCase());
    } else if (profile.role === 'RIDER' && profile.rider) {
      fallbackStatus = profile.rider.accountStatus;
      isApproved = APPROVED_STATUSES.includes(profile.rider.accountStatus?.toLowerCase());
    }

    // Demo & Development Bypass: Auto-approve KYC for mock numbers or when running in local development
    const mockNumbers = [
      '+919999999999',
      '+917777777777',
      '+918888888888',
      '+911111111111',
      '+910000000000',
      '+919063851105'
    ];
    if (process.env.NODE_ENV !== 'production') {
      if (mockNumbers.includes(profile.phoneNumber)) {
        isApproved = true;
      }
    }

    // Reject if KYC not in an approved state
    if (!isApproved) {
      console.warn(`[KYC] Access Denied for UID ${uid}: Role=${profile.role}, Status=${fallbackStatus}`);
      return res.status(403).json({ error: 'KYC not approved', status: fallbackStatus });
    }

    req.profile = profile;
    next();
  } catch (error) {
    console.error('[KYC] Middleware Error:', error);
    res.status(500).json({ error: 'Failed to verify KYC status' });
  }
};

module.exports = requireKyc;
