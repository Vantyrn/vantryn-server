const express = require('express');
const router = express.Router();
const { prisma } = require('../lib/prisma');
const { emitAccountStatusUpdate, emitProductStatusUpdate } = require('../lib/socket');

// Admin authentication middleware
// Validates the X-Admin-Key header against ADMIN_SECRET env var
const requireAdmin = (req, res, next) => {
  const adminSecret = process.env.ADMIN_SECRET;
  const providedKey = req.headers['x-admin-key'];

  // If no ADMIN_SECRET is set in env, allow access in dev (with warning)
  if (!adminSecret) {
    console.warn('[ADMIN] WARNING: ADMIN_SECRET not set. Admin routes are OPEN. Set ADMIN_SECRET in production.');
    return next();
  }

  if (!providedKey || providedKey !== adminSecret) {
    return res.status(403).json({ error: 'Forbidden: Invalid admin credentials.' });
  }

  next();
};

/**
 * GET /api/admin/vendors/pending
 * List all vendors waiting for KYC approval
 */
router.get('/vendors/pending', requireAdmin, async (req, res) => {
  try {
    const vendors = await prisma.vendor.findMany({
      where: {
        accountStatus: {
          in: ['KYC_SUBMITTED', 'UNDER_REVIEW', 'PENDING']
        }
      },
      include: {
        kyc: true,
        bankDetails: true
      }
    });
    res.json(vendors);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch pending vendors' });
  }
});

/**
 * PUT /api/admin/vendors/:id/approve
 * Approve a vendor account
 */
router.put('/vendors/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const vendorData = await prisma.vendor.findUnique({ where: { id } });
    if (!vendorData) return res.status(404).json({ error: 'Vendor not found' });

    // No Shadowfax store registration: the HL Marketplace model has no per-vendor store code.
    // Outlet onboarding is a one-time account-level activity; pickup coords go per-order.
    const updatedVendor = await prisma.vendor.update({
      where: { id },
      data: { accountStatus: 'APPROVED' }
    });

    // Update VendorKyc record status
    await prisma.vendorKyc.updateMany({
      where: { vendorId: id, status: 'submitted' },
      data: { status: 'approved', reviewedAt: new Date() }
    }).catch(e => console.warn('VendorKyc status update failed:', e.message));

    // Sync profile status if it exists
    if (updatedVendor.profileId) {
      await prisma.profile.update({
        where: { id: updatedVendor.profileId },
        data: { profileStatus: 'APPROVED' }
      }).catch(e => console.warn('Profile status sync failed:', e.message));
    }

    // Trigger real-time update
    emitAccountStatusUpdate(updatedVendor.id, 'APPROVED');

    // Send push notification
    try {
      const fcm = require('../lib/fcm');
      await fcm.sendToVendor(updatedVendor.id, {
        title: 'KYC Approved',
        body: 'Your business profile has been verified. Welcome to Vantyrn!',
        type: 'KYC_APPROVED'
      });
    } catch (err) {
      console.warn('Failed to send KYC approval notification:', err.message);
    }

    res.json({ success: true, message: 'Vendor approved successfully', vendor: updatedVendor });
  } catch (error) {
    res.status(500).json({ error: 'Approval failed', details: error.message });
  }
});

/**
 * PUT /api/admin/vendors/:id/reject
 * Reject a vendor account
 */
router.put('/vendors/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    const vendor = await prisma.vendor.update({
      where: { id },
      data: { accountStatus: 'REJECTED' }
    });

    // Update VendorKyc record status
    await prisma.vendorKyc.updateMany({
      where: { vendorId: id, status: 'submitted' },
      data: { status: 'rejected', reviewedAt: new Date() }
    }).catch(e => console.warn('VendorKyc status update failed:', e.message));

    // Sync profile status if it exists
    if (vendor.profileId) {
      await prisma.profile.update({
        where: { id: vendor.profileId },
        data: { profileStatus: 'REJECTED' }
      }).catch(e => console.warn('Profile status sync failed:', e.message));
    }

    // Trigger real-time update
    emitAccountStatusUpdate(vendor.id, 'REJECTED');

    // Send push notification for rejection
    try {
      const fcm = require('../lib/fcm');
      await fcm.sendToVendor(vendor.id, {
        title: 'KYC Rejected',
        body: `Your business profile verification was rejected. Reason: ${reason || 'Invalid documents.'}`,
        type: 'KYC_REJECTED'
      });
    } catch (err) {
      console.warn('Failed to send KYC rejection notification:', err.message);
    }

    res.json({ success: true, message: 'Vendor rejected', reason });
  } catch (error) {
    res.status(500).json({ error: 'Rejection failed' });
  }
});

/**
 * PRODUCT MANAGEMENT (ADMIN)
 */

// List all products pending review
router.get('/products/pending', requireAdmin, async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { reviewStatus: 'pending_review' },
      include: { 
        addOns: true, 
        images: true,
        vendor: true,
        customizationGroups: {
          include: { options: true }
        }
      }
    });
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch pending products' });
  }
});

// Approve/Reject a product
router.put('/products/:id/review', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // APPROVED, REJECTED
    
    const product = await prisma.product.update({
      where: { id },
      data: { 
        reviewStatus: status,
        isActive: status === 'APPROVED' // Auto-activate if approved
      }
    });

    emitProductStatusUpdate(product.vendorId, id, status);

    res.json({ success: true, product });
  } catch (error) {
    res.status(500).json({ error: 'Product review update failed' });
  }
});

// Admin direct edit of a product's customization
router.put('/products/:id/customization', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { customizationGroups } = req.body;

    await prisma.$transaction(async (tx) => {
      await tx.customizationGroup.deleteMany({ where: { productId: id } });
      if (Array.isArray(customizationGroups) && customizationGroups.length > 0) {
        await tx.product.update({
          where: { id },
          data: {
            customizationGroups: {
              create: customizationGroups.map((group, gIdx) => ({
                name: group.name,
                isRequired: group.isRequired === true,
                selectionType: group.selectionType || 'SINGLE',
                maxSelections: group.maxSelections || null,
                displayOrder: group.displayOrder ?? gIdx,
                options: {
                  create: (group.options || []).map((opt, oIdx) => ({
                    name: opt.name,
                    priceModifier: parseFloat(opt.priceModifier) || 0,
                    isAvailable: opt.isAvailable !== false,
                    displayOrder: opt.displayOrder ?? oIdx,
                    allowQuantity: !!opt.allowQuantity,
                    freeLimit: parseInt(opt.freeLimit) || 0
                  }))
                }
              }))
            }
          }
        });
      }
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Admin product update failed' });
  }
});

// Admin broadcast notification to users
router.post('/broadcast-notification', requireAdmin, async (req, res) => {
  try {
    const { audience, title, message, dataPayload } = req.body;
    
    // Validate audience
    if (!['VENDORS', 'CUSTOMERS', 'ALL'].includes(audience)) {
      return res.status(400).json({ error: 'Invalid audience. Must be VENDORS, CUSTOMERS, or ALL' });
    }

    if (!title || !message) {
      return res.status(400).json({ error: 'Title and message are required' });
    }

    // Calculate total targeted users (those with registered tokens)
    let totalTargeted = 0;
    if (audience === 'VENDORS' || audience === 'ALL') {
      const vendorCount = await prisma.profile.count({
        where: {
          role: 'VENDOR',
          OR: [
            { fcmToken: { not: null } },
            { pushToken: { not: null } }
          ]
        }
      });
      totalTargeted += vendorCount;
    }
    if (audience === 'CUSTOMERS' || audience === 'ALL') {
      const customerCount = await prisma.profile.count({
        where: {
          role: 'CUSTOMER',
          OR: [
            { fcmToken: { not: null } },
            { pushToken: { not: null } }
          ]
        }
      });
      totalTargeted += customerCount;
    }

    if (totalTargeted === 0) {
      return res.status(200).json({
        success: false,
        message: `No active, registered devices found for target audience: ${audience}. Notifications cannot be sent.`
      });
    }

    const fcm = require('../lib/fcm');
    // Use uppercase ADMIN_BROADCAST to match client-side notification handler type check
    const result = await fcm.broadcastToUsers(audience, {
      title,
      body: message,
      type: 'ADMIN_BROADCAST',
      data: { ...(dataPayload || {}), type: 'ADMIN_BROADCAST', channelId: 'admin' }
    });

    res.json({
      success: true,
      message: `Broadcast sent to ${result.success}/${result.success + result.failure} devices (${result.fcmCount} via FCM, ${result.expoCount} via Expo)`,
      result
    });
  } catch (error) {
    console.error('[ADMIN] Broadcast error:', error);
    res.status(500).json({ error: 'Failed to send broadcast notification' });
  }
});

/**
 * POST /api/admin/customer/:id/suspend
 * Suspend a customer account forever
 */
router.post('/customer/:id/suspend', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params; // customer ID
    
    // Find customer's profile
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: { profile: true }
    });

    if (!customer || !customer.profileId) {
      return res.status(404).json({ error: 'Customer profile not found' });
    }

    const updatedProfile = await prisma.profile.update({
      where: { id: customer.profileId },
      data: { profileStatus: 'SUSPENDED' }
    });

    try {
      emitAccountStatusUpdate(customer.id, 'SUSPENDED');
    } catch (_) {}

    res.json({ success: true, message: 'Customer suspended forever', profile: updatedProfile });
  } catch (error) {
    res.status(500).json({ error: 'Suspension failed', details: error.message });
  }
});

/**
 * POST /api/admin/customer/:id/disable
 * Disable a customer account temporarily for a specific number of hours
 */
router.post('/customer/:id/disable', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { hours } = req.body;
    
    if (!hours || isNaN(hours) || Number(hours) <= 0) {
      return res.status(400).json({ error: 'Valid temporary duration (hours) is required' });
    }

    const customer = await prisma.customer.findUnique({
      where: { id },
      include: { profile: true }
    });

    if (!customer || !customer.profileId) {
      return res.status(404).json({ error: 'Customer profile not found' });
    }

    const disabledUntil = new Date(Date.now() + Number(hours) * 60 * 60 * 1000).toISOString();
    const statusString = `DISABLED:${disabledUntil}`;

    const updatedProfile = await prisma.profile.update({
      where: { id: customer.profileId },
      data: { profileStatus: statusString }
    });

    try {
      emitAccountStatusUpdate(customer.id, statusString);
    } catch (_) {}

    res.json({ 
      success: true, 
      message: `Customer disabled for ${hours} hours`, 
      disabledUntil,
      profile: updatedProfile 
    });
  } catch (error) {
    res.status(500).json({ error: 'Disabling failed', details: error.message });
  }
});

/**
 * POST /api/admin/customer/:id/enable
 * Enable a suspended/disabled customer account back to APPROVED/ACTIVE
 */
router.post('/customer/:id/enable', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: { profile: true }
    });

    if (!customer || !customer.profileId) {
      return res.status(404).json({ error: 'Customer profile not found' });
    }

    const updatedProfile = await prisma.profile.update({
      where: { id: customer.profileId },
      data: { profileStatus: 'APPROVED' }
    });

    try {
      emitAccountStatusUpdate(customer.id, 'APPROVED');
    } catch (_) {}

    res.json({ success: true, message: 'Customer account enabled successfully', profile: updatedProfile });
  } catch (error) {
    res.status(500).json({ error: 'Enabling failed', details: error.message });
  }
});

/**
 * POST /api/admin/vendor/:id/suspend
 * Suspend a vendor account forever
 */
router.post('/vendor/:id/suspend', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params; // vendor ID
    const { reason } = req.body;
    
    // Find vendor's profile
    const vendor = await prisma.vendor.findUnique({
      where: { id },
      include: { profile: true }
    });

    if (!vendor || !vendor.profileId) {
      return res.status(404).json({ error: 'Vendor profile not found' });
    }

    const updatedProfile = await prisma.profile.update({
      where: { id: vendor.profileId },
      data: { profileStatus: 'SUSPENDED' }
    });

    // Update vendor accountStatus too
    await prisma.vendor.update({
      where: { id },
      data: { accountStatus: 'SUSPENDED' }
    }).catch(e => console.warn('[ADMIN] Vendor accountStatus update failed:', e.message));

    // Emit real-time update
    try { emitAccountStatusUpdate(vendor.id, 'SUSPENDED'); } catch (_) {}

    // Send FCM push notification to inform vendor
    try {
      const fcm = require('../lib/fcm');
      await fcm.sendToVendor(vendor.id, {
        title: 'Account Suspended',
        body: reason
          ? `Your vendor account has been suspended. Reason: ${reason}`
          : 'Your vendor account has been permanently suspended. Please contact support.',
        type: 'KYC_STATUS_UPDATED',
        channelId: 'kyc'
      });
    } catch (notifErr) {
      console.warn('[ADMIN] Suspend notification failed (non-fatal):', notifErr.message);
    }

    res.json({ success: true, message: 'Vendor suspended forever', profile: updatedProfile });
  } catch (error) {
    res.status(500).json({ error: 'Suspension failed', details: error.message });
  }
});

/**
 * POST /api/admin/vendor/:id/disable
 * Disable a vendor account temporarily for a specific number of hours
 */
router.post('/vendor/:id/disable', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { hours, reason } = req.body;
    
    if (!hours || isNaN(hours) || Number(hours) <= 0) {
      return res.status(400).json({ error: 'Valid temporary duration (hours) is required' });
    }

    const vendor = await prisma.vendor.findUnique({
      where: { id },
      include: { profile: true }
    });

    if (!vendor || !vendor.profileId) {
      return res.status(404).json({ error: 'Vendor profile not found' });
    }

    const disabledUntil = new Date(Date.now() + Number(hours) * 60 * 60 * 1000).toISOString();
    const statusString = `DISABLED:${disabledUntil}`;

    const updatedProfile = await prisma.profile.update({
      where: { id: vendor.profileId },
      data: { profileStatus: statusString }
    });

    // Emit real-time update
    try { emitAccountStatusUpdate(vendor.id, statusString); } catch (_) {}

    // Send FCM push notification
    try {
      const fcm = require('../lib/fcm');
      await fcm.sendToVendor(vendor.id, {
        title: 'Account Temporarily Disabled',
        body: reason
          ? `Your account has been temporarily disabled for ${hours} hours. Reason: ${reason}`
          : `Your account has been temporarily disabled for ${hours} hours. Contact support for details.`,
        type: 'KYC_STATUS_UPDATED',
        channelId: 'kyc'
      });
    } catch (notifErr) {
      console.warn('[ADMIN] Disable notification failed (non-fatal):', notifErr.message);
    }

    res.json({ 
      success: true, 
      message: `Vendor disabled for ${hours} hours`, 
      disabledUntil,
      profile: updatedProfile 
    });
  } catch (error) {
    res.status(500).json({ error: 'Disabling failed', details: error.message });
  }
});

/**
 * POST /api/admin/vendor/:id/enable
 * Enable a suspended/disabled vendor account back to APPROVED/ACTIVE
 */
router.post('/vendor/:id/enable', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const vendor = await prisma.vendor.findUnique({
      where: { id },
      include: { profile: true }
    });

    if (!vendor || !vendor.profileId) {
      return res.status(404).json({ error: 'Vendor profile not found' });
    }

    const updatedProfile = await prisma.profile.update({
      where: { id: vendor.profileId },
      data: { profileStatus: 'APPROVED' }
    });

    // Restore vendor accountStatus to APPROVED
    await prisma.vendor.update({
      where: { id },
      data: { accountStatus: 'APPROVED' }
    }).catch(e => console.warn('[ADMIN] Vendor accountStatus restore failed:', e.message));

    // Emit real-time update
    try { emitAccountStatusUpdate(vendor.id, 'APPROVED'); } catch (_) {}

    // Send FCM push notification to inform vendor
    try {
      const fcm = require('../lib/fcm');
      await fcm.sendToVendor(vendor.id, {
        title: 'Account Restored',
        body: 'Your vendor account has been reactivated. You can now log in and manage your store.',
        type: 'KYC_APPROVED',
        channelId: 'kyc'
      });
    } catch (notifErr) {
      console.warn('[ADMIN] Enable notification failed (non-fatal):', notifErr.message);
    }

    res.json({ success: true, message: 'Vendor account enabled successfully', profile: updatedProfile });
  } catch (error) {
    res.status(500).json({ error: 'Enabling failed', details: error.message });
  }
});

module.exports = router;
