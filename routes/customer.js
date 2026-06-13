const express = require('express');
const router = express.Router();
const firebaseAuth = require('../middleware/auth');
const requireCustomer = require('../middleware/customer');
const { prisma, withRetry, getOrCreateCustomerProfile } = require('../lib/prisma');

/**
 * MODULE 4 — AGE VERIFICATION (DOB-based, no document upload)
 *
 * Rules:
 *  - 18+ users  → isVerified = true, expiresAt = 30 days from now
 *  - Under-18   → isVerified = false, underageAcknowledged = true recorded in verificationId
 *                 Returns 200 so the frontend soft-block can proceed
 *  - No ID document upload is required (DOB self-declaration only)
 */
router.post('/age-verify', firebaseAuth, async (req, res) => {
  try {
    const { birthDate, idType, underageAcknowledged } = req.body;
    const profile = await getOrCreateCustomerProfile(req.user);

    if (!birthDate) return res.status(400).json({ error: 'Birth date is required.' });

    const bday = new Date(birthDate);
    if (isNaN(bday.getTime())) {
      return res.status(400).json({ error: 'Invalid birth date format.' });
    }

    // Calculate age in years
    const ageMs   = Date.now() - bday.getTime();
    const ageYears = ageMs / (1000 * 60 * 60 * 24 * 365.25);
    const isAdult  = ageYears >= 18;

    // 30-day verification window (per MVP spec §12)
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS);

    const upsertData = {
      birthDate: bday,
      idType: idType || 'DOB_SELF_DECLARED',
      // Store underage acknowledgement flag in verificationId field
      verificationId: underageAcknowledged ? 'UNDERAGE_ACKNOWLEDGED' : null,
      isVerified: isAdult,
      verifiedAt: isAdult ? new Date() : null,
      expiresAt: expiresAt
    };

    console.log(`[AGE-VERIFY] Upserting for Customer: ${profile.customer.id}`, upsertData);

    const verification = await prisma.ageVerification.upsert({
      where: { customerId: profile.customer.id },
      update: upsertData,
      create: { customerId: profile.customer.id, ...upsertData },
    });

    console.log(`[AGE-VERIFY] Success! Verification Record:`, verification.id);

    // Always return 200 — frontend handles the soft-warning UX for under-18
    res.json({
      success: true,
      isAdult,
      underageAcknowledged: !!underageAcknowledged,
      verification,
    });
  } catch (error) {
    console.error('[AGE-VERIFY] Error:', error);
    res.status(500).json({ error: 'Verification failed', details: error.message });
  }
});

/**
 * MODULE 11 — ACCOUNT MANAGEMENT
 */

// Sync/Get Profile
router.get('/profile', firebaseAuth, async (req, res) => {
  try {
    // Self-Healing Profile Alignment
    let profile = await getOrCreateCustomerProfile(req.user);

    // Self-Healing block expiration for temporarily disabled accounts
    if (profile.profileStatus && profile.profileStatus.startsWith('DISABLED:')) {
      const disabledUntilStr = profile.profileStatus.split('DISABLED:')[1];
      const disabledUntil = new Date(disabledUntilStr);
      if (disabledUntil < new Date()) {
        console.log(`[PROFILE-SYNC] Temporary block expired. Restoring profile status for ${profile.id}`);
        profile = await prisma.profile.update({
          where: { id: profile.id },
          data: { profileStatus: 'APPROVED' }
        });
      }
    }

    // Re-fetch to include full address list
    const fullProfile = await prisma.profile.findUnique({
      where: { id: profile.id },
      include: { 
        customer: { 
          include: { 
            addresses: {
                orderBy: { createdAt: 'desc' }
            },
            ageVerification: true
          } 
        } 
      }
    });

    res.json({ success: true, profile: fullProfile });
  } catch (error) {
    console.error('[PROFILE-SYNC] Error:', error);
    res.status(500).json({ error: 'Failed to fetch customer profile' });
  }
});

router.put('/profile', firebaseAuth, requireCustomer, async (req, res) => {
  try {
    const { fullName, email, profilePicUrl, fcmToken, pushToken } = req.body;
    
    // Update Customer record
    const updated = await prisma.customer.update({
      where: { id: req.customer.id },
      data: { 
        fullName: fullName || undefined, 
        email: email || undefined, 
        profilePicUrl: profilePicUrl || undefined 
      }
    });

    // Sync FCM or Expo Push Token to Profile safely without setting the other to null
    const updateData = {};
    if (fcmToken !== undefined) {
      updateData.fcmToken = fcmToken;
    }
    if (pushToken !== undefined) {
      updateData.pushToken = pushToken;
    }
    
    // Fallback: If only a single active token was provided through a generic key, determine what it is
    const activeToken = fcmToken || pushToken;
    if (activeToken && Object.keys(updateData).length === 0) {
      const isExpo = activeToken.startsWith('ExponentPushToken[');
      if (isExpo) {
        updateData.pushToken = activeToken;
      } else {
        updateData.fcmToken = activeToken;
      }
    }

    if (Object.keys(updateData).length > 0) {
      await prisma.profile.update({
        where: { id: req.customer.profileId },
        data: updateData
      });
      console.log(`[CUSTOMER] Notification tokens updated for ${req.customer.id}:`, updateData);
    }
    res.json({ success: true, customer: updated });
  } catch (error) {
    console.error('[CUSTOMER-UPDATE] Failed to update customer profile:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Address Management
router.get('/address', firebaseAuth, requireCustomer, async (req, res) => {
  try {
    const addresses = await prisma.address.findMany({
      where: { customerId: req.customer.id },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, addresses, address: addresses[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch address' });
  }
});

router.post('/address', firebaseAuth, requireCustomer, async (req, res) => {
  try {
    const { 
      addressLine, addressLine1, addressLine2,
      city, state, postalCode,
      landmark, latitude, longitude, type,
      contactName, contactPhone 
    } = req.body;
    
    // Core address fields that always exist
    const coreData = {
      addressLine1: addressLine1 || addressLine || 'Default Address',
      addressLine2,
      city: city || 'Unknown',
      state: state || 'N/A',
      postalCode: postalCode || '000000',
      landmark,
      latitude,
      longitude,
      addressType: type || 'Home'
    };

    // Find existing address for this customer and this addressType to update, or create new
    const existingAddress = await prisma.address.findFirst({
      where: { 
        customerId: req.customer.id,
        addressType: type || 'Home'
      }
    });

    let address;
    try {
      if (existingAddress) {
        address = await prisma.address.update({
          where: { id: existingAddress.id },
          data: {
            ...coreData,
            contactName,
            contactPhone
          }
        });
      } else {
        address = await prisma.address.create({
          data: {
            customerId: req.customer.id,
            ...coreData,
            contactName,
            contactPhone
          }
        });
      }
      return res.json({ success: true, address, status: 'fully_synced' });
    } catch (prismaError) {
      console.warn('[PRISMA] Contact columns missing? Falling back to core save.', prismaError.message);
      
      if (existingAddress) {
        address = await prisma.address.update({
          where: { id: existingAddress.id },
          data: coreData
        });
      } else {
        address = await prisma.address.create({
          data: {
            customerId: req.customer.id,
            ...coreData
          }
        });
      }
      return res.json({ 
        success: true, 
        address, 
        status: 'partial_sync',
        warning: 'Contact details not saved.' 
      });
    }
  } catch (error) {
    console.error('[ADDRESS-SAVE] Critical Error:', error);
    res.status(500).json({ error: 'Failed to save address', details: error.message });
  }
});

router.put('/address/:id', firebaseAuth, requireCustomer, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const address = await prisma.address.update({
      where: { id, customerId: req.customer.id },
      data: updateData
    });
    res.json({ success: true, address });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update address' });
  }
});

/**
 * MODULE 10 — CUSTOMER SUPPORT
 */
router.get('/support/options', (req, res) => {
  res.json({
    success: true,
    whatsapp: {
      number: '+919063851105',
      message: 'Hi, I need help with my order.',
      options: [
        { label: 'Order Delayed', value: 'delay' },
        { label: 'Item Missing', value: 'missing' },
        { label: 'Payment Issue', value: 'payment' }
      ]
    }
  });
});

router.post('/support/escalate', firebaseAuth, requireCustomer, async (req, res) => {
  // Logic to flag for live chat or create a ticket
  res.json({ success: true, message: 'Your request has been escalated to a live agent.' });
});

module.exports = router;
