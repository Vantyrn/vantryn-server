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

    // UNIQUENESS GUARD: a phone and an email each map to exactly ONE vendor. Owning the
    // phone (proved by OTP) lets a vendor resume their own account, but the email must
    // belong to that SAME vendor — and vice-versa. Reject mismatches with a clear 409
    // BEFORE any adoption/upsert mutates state. The @unique constraints on
    // profiles.phone_number and vendors.email still backstop races.
    // Treat missing OR blank/whitespace email as "no email" so a phone-only vendor is never
    // caught by the collision check. Only a real, non-empty email is matched against
    // vendors.email — empty ones are never "already registered".
    const cleanEmail = email && email.trim() ? email.trim().toLowerCase() : null;
    const emailVendor = cleanEmail
      ? await withRetry(() => prisma.vendor.findFirst({ where: { email: cleanEmail } }))
      : null;
    const phoneOwner = safePhone
      ? await withRetry(() => prisma.profile.findFirst({ where: { phoneNumber: safePhone }, include: { vendor: true } }))
      : null;
    const phoneVendor = phoneOwner?.vendor || null;

    // Email is taken by a vendor that isn't the one this phone belongs to.
    if (emailVendor && (!phoneVendor || phoneVendor.id !== emailVendor.id)) {
      return res.status(409).json({ success: false, code: 'identity_conflict',
        error: 'This email is already registered to another vendor. Please contact support.' });
    }
    // This phone's vendor already exists with a different email.
    if (!emailVendor && cleanEmail && phoneVendor?.email && phoneVendor.email !== cleanEmail) {
      return res.status(409).json({ success: false, code: 'identity_conflict',
        error: 'This phone number is already registered to another vendor with a different email. Please contact support.' });
    }

    // IDENTITY ADOPTION: if a profile already exists for this phone under a DIFFERENT
    // Firebase UID (admin-created vendor, a prior session, or an app reinstall), relink
    // it to this UID. Phone-OTP proves ownership, so this is safe — and it prevents the
    // phone_number unique-constraint crash on create. It also means an already-approved
    // vendor logging in resumes their existing (ACTIVE) account instead of re-registering.
    if (safePhone) {
      const existingByPhone = await withRetry(() => prisma.profile.findFirst({
        where: { phoneNumber: safePhone, NOT: { firebaseUid: uid } }
      }));
      if (existingByPhone) {
        console.log(`[AUTH-SYNC] Adopting existing profile ${existingByPhone.id} (phone match) to UID ${uid}`);
        await withRetry(() => prisma.profile.update({
          where: { id: existingByPhone.id },
          data: { firebaseUid: uid }
        }));
      }
    }

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

    // This is the POST-approval payout step, so it may only CONFIRM an activation an
    // admin already granted — it must never grant one. It previously set
    // accountStatus:'ACTIVE' for any caller holding a vendor profile, and
    // middleware/kyc.js treats ACTIVE as approved, so an unreviewed vendor could
    // self-approve with a single request and start taking real orders.
    const alreadyApproved = ['APPROVED', 'ACTIVE'].includes(profile.vendor.accountStatus);

    // 2. Perform Single Atomic Transaction to lock phone number verification
    const updatedVendor = await prisma.$transaction(async (tx) => {
      const v = await tx.vendor.update({
        where: { id: profile.vendor.id },
        data: {
          phoneVerified: true,
          ...(alreadyApproved ? { accountStatus: 'ACTIVE' } : {})
        }
      });

      // Keep Profile table synchronized and update phoneNumber if passed
      await tx.profile.update({
        where: { id: profile.id },
        data: {
          ...(alreadyApproved ? { profileStatus: 'READY' } : {}),
          phoneNumber: phoneNumber ? phoneNumber : undefined
        }
      });

      return v;
    });

    console.log(`[AUTH] Phone payout verification successful for Vendor: ${profile.vendor.id}, Phone: ${phoneNumber || profile.phoneNumber}`);

    // Report the REAL status. Hardcoding 'READY' told an unapproved vendor's app it
    // was approved, and the app writes this straight into its auth store — it would
    // route them to the dashboard while every API call still 403'd.
    res.json({
      success: true,
      message: 'Phone number verified for payouts successfully.',
      phoneVerified: true,
      profileStatus: alreadyApproved ? 'READY' : (profile.profileStatus || 'UNDER_REVIEW')
    });

  } catch (error) {
    console.error('[AUTH] verify-phone-payout error:', error);
    res.status(500).json({ error: 'Verification update failed', details: error.message });
  }
});

module.exports = router;
