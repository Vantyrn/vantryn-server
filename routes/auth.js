const express = require('express');
const router = express.Router();
const firebaseAuth = require('../middleware/auth');
const { prisma, withRetry } = require('../lib/prisma');

/**
 * Sync User Profile
 * Fetches the user from the DB or creates a new one if it doesn't exist
 */
router.post('/sync', firebaseAuth, async (req, res) => {
  try {
    const { uid, phoneNumber } = req.user;
    const { email } = req.body;
    
    // Handle cases where social login has no phone number
    const safePhone = phoneNumber || null;

    // Upsert the profile (create if doesn't exist, update if it does)
    const profile = await withRetry(() => prisma.profile.upsert({
      where: { firebaseUid: uid },
      update: { 
        phoneNumber: safePhone ? safePhone : undefined 
      }, // Keep phone updated
      create: {
        firebaseUid: uid,
        phoneNumber: safePhone || `none_${uid}`,  // safe placeholder, never null
        role: null,
        profileStatus: 'PENDING'
      },
      include: {
        vendor: true,
        rider: true
      }
    }));

    // If VENDOR profile exists and email is passed, keep vendor email updated
    if (profile.role === 'VENDOR' && profile.vendor) {
      const updateData = { phoneVerified: true };
      if (email) {
        updateData.email = email.trim().toLowerCase();
      }
      const updatedVendor = await prisma.vendor.update({
        where: { id: profile.vendor.id },
        data: updateData
      });
      profile.vendor = updatedVendor;
    }

    // SELF-HEALING: Determine correct profileStatus based on vendor/rider records
    let currentStatus = profile.profileStatus;
    
    if (profile.role === 'VENDOR' && profile.vendor) {
      const vStatus = profile.vendor.accountStatus;
      if (['ACTIVE', 'APPROVED'].includes(vStatus)) {
        currentStatus = 'ACTIVE';
      } else if (['UNDER_REVIEW', 'KYC_SUBMITTED'].includes(vStatus)) {
        currentStatus = 'UNDER_REVIEW';
      }
    } else if (profile.role === 'RIDER' && profile.rider) {
      const rStatus = profile.rider.accountStatus?.toUpperCase();
      if (['ACTIVE', 'APPROVED'].includes(rStatus)) {
        currentStatus = 'ACTIVE';
      } else if (['PENDING', 'UNDER_REVIEW'].includes(rStatus)) {
        currentStatus = 'UNDER_REVIEW';
      }
    }

    // Sync status if it changed (e.g. from PENDING to ACTIVE on relogin)
    if (currentStatus !== profile.profileStatus) {
      await prisma.profile.update({
        where: { id: profile.id },
        data: { profileStatus: currentStatus }
      });
    }

    console.log(`[AUTH-SYNC] Success! Profile ID: ${profile.id}, Role: ${profile.role}, Status: ${currentStatus}`);

    res.json({
      success: true,
      user: {
        uid: profile.firebaseUid,
        phoneNumber: profile.phoneNumber,
        role: profile.role,
        profileStatus: currentStatus,
        phoneVerified: profile.vendor ? profile.vendor.phoneVerified : false
      }
    });
  } catch (error) {
    const util = require('util');
    console.error('[AUTH] Sync Error:', error);
    res.status(500).json({ success: false, error: 'Database sync failed', details: error.message });
  }
});

/**
 * Update User Role
 */
router.post('/role', firebaseAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { role, email } = req.body;

    if (!['VENDOR', 'RIDER'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    console.log(`[AUTH] Updating role for ${uid} to ${role}`);

    // Update profile role
    const profile = await withRetry(() => prisma.profile.update({
      where: { firebaseUid: uid },
      data: { role }
    }));

    // Create a skeleton record in the corresponding table if it doesn't exist
    let vendorRecord = null;
    if (role === 'VENDOR') {
      vendorRecord = await withRetry(() => prisma.vendor.upsert({
        where: { profileId: profile.id },
        update: {
          phoneVerified: true,
          email: email ? email.trim().toLowerCase() : undefined
        },
        create: {
          profileId: profile.id,
          businessName: 'My Store', // Placeholder
          ownerName: 'Vendor Owner', // Placeholder
          businessAddress: 'Address Pending', // Placeholder
          phoneVerified: true, // Phone auth is FIRST
          email: email ? email.trim().toLowerCase() : null
        }
      }));
    } else if (role === 'RIDER') {
      await withRetry(() => prisma.rider.upsert({
        where: { profileId: profile.id },
        update: {},
        create: {
          profileId: profile.id,
          fullName: 'Rider Name' // Placeholder
        }
      }));
    }
    
    res.json({
      success: true,
      user: {
        uid: profile.firebaseUid,
        phoneNumber: profile.phoneNumber,
        role: profile.role,
        profileStatus: profile.profileStatus,
        phoneVerified: role === 'VENDOR' ? (vendorRecord?.phoneVerified ?? false) : false
      }
    });
  } catch (error) {
    console.error('[AUTH] Role Update Error:', error);
    res.status(500).json({ success: false, error: 'Failed to update role', details: error.message });
  }
});

/**
 * Mock Status Enforcement Test (Update profile status)
 */
router.post('/status-dev', firebaseAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { status } = req.body;

    const profile = await prisma.profile.update({
      where: { firebaseUid: uid },
      data: { profileStatus: status }
    });

    res.json({ success: true, status: profile.profileStatus });
  } catch (error) {
    console.error('[AUTH] Sync error:', error);
    res.status(500).json({ error: 'Sync failed', details: error.message });
  }
});

/**
 * One-time verification endpoint for post-approval vendor payout activation
 */
router.post('/verify-phone-payout', firebaseAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { phoneNumber } = req.body;
    
    // 1. Fetch Profile
    const profile = await prisma.profile.findUnique({
      where: { firebaseUid: uid },
      include: { vendor: true }
    });

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    if (profile.role !== 'VENDOR' || !profile.vendor) {
      return res.status(400).json({ error: 'Only vendor accounts can complete phone verification.' });
    }

    // 2. Perform Single Atomic Transaction to lock phone number verification
    const updatedVendor = await prisma.$transaction(async (tx) => {
      // Set phoneVerified to true and accountStatus to ACTIVE
      const v = await tx.vendor.update({
        where: { id: profile.vendor.id },
        data: { 
          phoneVerified: true,
          accountStatus: 'ACTIVE'
        }
      });

      // Keep Profile table synchronized and update phoneNumber if passed
      await tx.profile.update({
        where: { id: profile.id },
        data: { 
          profileStatus: 'READY',
          phoneNumber: phoneNumber ? phoneNumber : undefined
        }
      });

      return v;
    });

    console.log(`[AUTH] Phone payout verification successful for Vendor: ${profile.vendor.id}, Phone: ${phoneNumber || profile.phoneNumber}`);

    res.json({
      success: true,
      message: 'Phone number verified for payouts successfully.',
      phoneVerified: true,
      profileStatus: 'READY'
    });

  } catch (error) {
    console.error('[AUTH] verify-phone-payout error:', error);
    res.status(500).json({ error: 'Verification update failed', details: error.message });
  }
});

module.exports = router;
