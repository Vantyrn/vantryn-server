const express = require('express');
const router = express.Router();

// DIAGNOSTIC: Log all requests hitting the vendor router
router.use((req, res, next) => {
  console.log(`📡 [VENDOR-ROUTER] ${req.method} ${req.originalUrl}`);
  next();
});
const firebaseAuth = require('../middleware/auth');
const requireKyc = require('../middleware/kyc');
const { prisma, withRetry } = require('../lib/prisma');
const { ACTIVE_ORDER_STATUSES, isTerminalStatus, isCancellableStatus } = require('../lib/orderStatus');

const fcm = require('../lib/fcm');
const { orderSlaQueue } = require('../lib/bullmq');
const { emitOrderStatusUpdate, emitVendorStatusUpdate } = require('../lib/socket');
const { getPresignedUploadUrl } = require('../lib/storage');
const { checkAndTransitionVendorOffline } = require('../lib/vendorStatusHelper');
const { claimPushToken, releasePushToken } = require('../lib/pushToken');

// Menu categories are PER-VENDOR (Category.vendorId, and the listing filters
// vendorId = mine OR null), but the database still carries a GLOBAL unique index on
// name alone (categories_name_key). So the first vendor to use "Desserts" locked that
// name for everyone: another vendor's lookup is scoped to own+global and misses the
// row, the create then collides, and product creation died on a raw P2002.
//
// The real fix is making the index (vendor_id, name); until that lands this degrades to
// a clear 409 instead of a 500, and afterwards the P2002 branch only catches a genuine
// same-vendor race and self-heals. Reusing the other vendor's row is NOT an option —
// it is invisible to this vendor, so their product would land in a category they can
// neither see nor edit.
const resolveCategoryByName = async (name, vendorId) => {
  const scoped = { name, OR: [{ vendorId }, { vendorId: null }] };
  const existing = await prisma.category.findFirst({ where: scoped });
  if (existing) return existing;
  try {
    return await prisma.category.create({ data: { name, vendorId } });
  } catch (e) {
    if (e.code !== 'P2002') throw e;
    const raced = await prisma.category.findFirst({ where: scoped });
    if (raced) return raced;
    throw Object.assign(
      new Error(`The category name "${name}" is already in use by another store. Please pick a different name.`),
      { status: 409, code: 'CATEGORY_NAME_TAKEN' }
    );
  }
};


// DIAGNOSTIC: Check if this file is actually loaded
router.get('/health-check', (req, res) => {
  res.json({ 
    status: 'active', 
    timestamp: '2026-05-16T08:00:00Z',
    file: 'routes/vendor.js' 
  });
});

// Vendor logout — the server side of signing out, which did not exist before.
// Logging out was purely client-side (Firebase signOut + clearing AsyncStorage), so the
// server never learned about it and two things went wrong:
//   1. the device's FCM token stayed attached to the profile, so the next order for that
//      vendor pushed "New order received" to whoever was logged in on that phone next;
//   2. onlineStatus stayed 'online', so a store nobody was watching kept appearing open
//      to customers and accepting orders.
// NOTE: this is deliberately tied to an explicit logout, NOT to socket disconnect —
// auto-offline on disconnect is off on purpose (see lib/socket.js) because backgrounding
// the app was falsely closing live stores.
router.post('/logout', firebaseAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const profile = await prisma.profile.findUnique({
      where: { firebaseUid: uid },
      include: { vendor: { select: { id: true, onlineStatus: true } } },
    });

    await releasePushToken(uid);

    if (profile?.vendor && profile.vendor.onlineStatus !== 'offline') {
      await prisma.vendor.update({
        where: { id: profile.vendor.id },
        data: { onlineStatus: 'offline' },
      });
      // Tell customers the store just closed so it disappears from browsing immediately.
      try { emitVendorStatusUpdate(profile.vendor.id, false); } catch (_) {}
    }

    res.json({ success: true });
  } catch (error) {
    // Never block a logout on server cleanup — the client signs out regardless.
    console.warn('[VENDOR] Logout cleanup failed:', error.message);
    res.json({ success: true, cleaned: false });
  }
});

// Save vendor push/FCM notification tokens
// Accepts both Expo pushToken and native FCM fcmToken
router.post('/push-token', firebaseAuth, async (req, res) => {
  const { pushToken, fcmToken } = req.body;
  const uid = req.user.uid;

  if (!pushToken && !fcmToken) {
    return res.status(400).json({ error: 'At least one of pushToken or fcmToken is required' });
  }

  try {
    // The Profile model/DB only has `fcmToken` (native FCM is the push delivery path).
    // The Expo `pushToken` has no column, so we don't persist it (writing it caused a
    // Prisma "Unknown argument pushToken" 500). Fall back to the Expo token only if no
    // native FCM token was provided, so we still store *something* usable.
    const tokenToStore = fcmToken || pushToken;
    // claimPushToken, not a plain update: the token must belong to exactly one profile,
    // or a push for the previous account lands on whoever is logged in now.
    await claimPushToken(uid, tokenToStore);
    console.log(`[PUSH-TOKEN] Saved token for UID ${uid}: fcmToken=${!!tokenToStore}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[PUSH-TOKEN] Failed to save tokens:', error);
    res.status(500).json({ error: 'Failed to save push token' });
  }
});

// ==========================================
// HIGH PRIORITY: Taxonomy & Static Routes
// ==========================================

// IMPORTANT: Static routes must come BEFORE parameterized routes (:id)
router.get('/categories', firebaseAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({ 
      where: { firebaseUid: req.user.uid }, 
      include: { vendor: true } 
    });

    const vendorId = profile?.vendor?.id || null;

    // Build OR conditions without nulls (Prisma rejects null entries in OR)
    const orConditions = [{ vendorId: null }]; // System categories always included
    if (vendorId) orConditions.push({ vendorId });

    const categories = await prisma.category.findMany({
      where: { OR: orConditions },
      orderBy: { displayOrder: 'asc' }
    });

    console.log(`[DEBUG] Categories fetched: ${categories.length} items for vendor ${vendorId}`);
    res.json({ success: true, categories });
  } catch (error) {
    console.error('[VENDOR] Fetch Categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories', details: error.message });
  }
});

router.post('/categories', firebaseAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { firebaseUid: req.user.uid }, include: { vendor: true } });
    const { name, description } = req.body;
    const category = await resolveCategoryByName(name, profile.vendor.id);
    if (description && !category.description) {
      await prisma.category.update({ where: { id: category.id }, data: { description } }).catch(() => {});
    }
    res.json({ success: true, category });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create category' });
  }
});

router.get('/products/templates', firebaseAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { firebaseUid: req.user.uid }, include: { vendor: true } });
    const vendorId = profile?.vendor?.id;

    const templates = await prisma.productTemplate.findMany({
      orderBy: { createdAt: 'desc' }
    });

    if (vendorId) {
      // Get all template IDs already used by this vendor
      const usedTemplateIds = await prisma.product.findMany({
        where: { vendorId, templateId: { not: null } },
        select: { templateId: true }
      }).then(products => products.map(p => p.templateId));

      const filteredTemplates = templates.filter(t => !usedTemplateIds.includes(t.id));
      return res.json({ success: true, templates: filteredTemplates });
    }

    res.json({ success: true, templates });
  } catch (error) {
    console.error('[VENDOR-API] Templates fetch error:', error);
    res.status(500).json({ error: 'Failed fetching templates', details: error.message });
  }
});

// GET /api/vendor/products/byo-assigned
// Returns the admin-assigned BYO template for this vendor (read-only)
router.get('/products/byo-assigned', firebaseAuth, async (req, res) => {
  try {
    const profile = await prisma.profile.findUnique({
      where: { firebaseUid: req.user.uid },
      include: { vendor: true }
    });
    if (!profile?.vendor) return res.json({ success: true, template: null });

    const assignment = await prisma.vendor_assigned_templates.findFirst({
      where: { vendor_id: profile.vendor.id },
      include: {
        byo_templates: {
          include: {
            byo_template_groups: {
              orderBy: { display_order: 'asc' },
              include: { byo_template_options: { orderBy: { display_order: 'asc' } } }
            }
          }
        }
      }
    });

    if (!assignment) return res.json({ success: true, template: null });

    // Check if vendor already has a product created with this template
    const usedProduct = await prisma.product.findFirst({
      where: { 
        vendorId: profile.vendor.id,
        templateId: assignment.template_id
      }
    });

    if (usedProduct) {
      console.log(`[BYO] Template ${assignment.template_id} already used for product ${usedProduct.id}. Hiding from selection.`);
      return res.json({ success: true, template: null });
    }

    res.json({ success: true, template: assignment.byo_templates });
  } catch (error) {
    console.error('[BYO] Assigned template fetch error:', error);
    res.status(500).json({ error: 'Failed fetching BYO template', details: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// VENDOR-AUTHORED BYO TEMPLATES — vendors create their own reusable BYO
// templates. They start 'pending_review' and become usable to build products
// only once an admin approves them (status 'approved' AND is_active).
// ──────────────────────────────────────────────────────────────────────────

const BYO_TPL_INCLUDE = {
  byo_template_groups: {
    orderBy: { display_order: 'asc' },
    include: { byo_template_options: { orderBy: { display_order: 'asc' } } }
  }
};

// Normalize incoming groups[] (+ options) into a Prisma nested-create payload.
function buildByoGroupsCreate(groups) {
  return (Array.isArray(groups) ? groups : [])
    .filter(g => g && g.name && g.name.trim())
    .map((g, gi) => ({
      name: g.name.trim(),
      selection_type: g.selection_type || 'SINGLE',
      is_required: g.is_required === true || g.is_required === 'true',
      max_limit: g.max_limit ? parseInt(g.max_limit) : null,
      free_threshold: parseInt(g.free_threshold) || 0,
      extra_price: parseFloat(g.extra_price) || 0,
      display_order: g.display_order ?? gi,
      byo_template_options: {
        create: (Array.isArray(g.options) ? g.options : [])
          .filter(o => o && o.name && o.name.trim())
          .map((o, oi) => ({
            name: o.name.trim(),
            price_modifier: parseFloat(o.price_modifier) || 0,
            is_available: o.is_available !== false,
            display_order: o.display_order ?? oi,
          }))
      }
    }));
}

async function getVendorOr403(req, res) {
  const profile = await prisma.profile.findUnique({
    where: { firebaseUid: req.user.uid },
    include: { vendor: true }
  });
  if (!profile?.vendor) {
    res.status(403).json({ error: 'Vendor profile not found' });
    return null;
  }
  return profile.vendor;
}

// GET /api/vendor/byo-templates/usable — templates this vendor may build products
// from: admin-assigned (approved) + own approved & active. STATIC route → must be
// declared before the parameterized '/byo-templates/:id' routes.
router.get('/byo-templates/usable', firebaseAuth, async (req, res) => {
  try {
    const vendor = await getVendorOr403(req, res);
    if (!vendor) return;

    const [assignments, ownApproved] = await Promise.all([
      prisma.vendor_assigned_templates.findMany({
        where: { vendor_id: vendor.id },
        include: { byo_templates: { include: BYO_TPL_INCLUDE } }
      }),
      prisma.byo_templates.findMany({
        where: { vendor_id: vendor.id, status: 'approved', is_active: true },
        include: BYO_TPL_INCLUDE,
        orderBy: { created_at: 'desc' }
      })
    ]);

    const assigned = assignments
      .map(a => a.byo_templates)
      .filter(t => t && t.is_active && t.status === 'approved');

    const byId = new Map();
    [...assigned, ...ownApproved].forEach(t => { if (t) byId.set(t.id, t); });

    res.json({ success: true, templates: Array.from(byId.values()) });
  } catch (error) {
    console.error('[BYO] usable templates error:', error);
    res.status(500).json({ error: 'Failed fetching usable templates', details: error.message });
  }
});

// GET /api/vendor/byo-templates — this vendor's OWN authored templates (all statuses)
router.get('/byo-templates', firebaseAuth, async (req, res) => {
  try {
    const vendor = await getVendorOr403(req, res);
    if (!vendor) return;
    const templates = await prisma.byo_templates.findMany({
      where: { vendor_id: vendor.id },
      include: BYO_TPL_INCLUDE,
      orderBy: { created_at: 'desc' }
    });
    res.json({ success: true, templates });
  } catch (error) {
    console.error('[BYO] list own templates error:', error);
    res.status(500).json({ error: 'Failed fetching templates', details: error.message });
  }
});

// POST /api/vendor/byo-templates — create a vendor-authored template (pending review)
router.post('/byo-templates', firebaseAuth, async (req, res) => {
  try {
    const vendor = await getVendorOr403(req, res);
    if (!vendor) return;
    const { name, category, description, groups } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Template name is required' });

    const template = await prisma.byo_templates.create({
      data: {
        name: name.trim(),
        category: category || null,
        description: description || null,
        vendor_id: vendor.id,
        status: 'pending_review',
        is_active: true,
        byo_template_groups: { create: buildByoGroupsCreate(groups) }
      },
      include: BYO_TPL_INCLUDE
    });
    res.json({ success: true, template });
  } catch (error) {
    console.error('[BYO] create template error:', error);
    res.status(500).json({ error: 'Failed creating template', details: error.message });
  }
});

// PUT /api/vendor/byo-templates/:id — edit own template; any edit resets it to pending review
router.put('/byo-templates/:id', firebaseAuth, async (req, res) => {
  try {
    const vendor = await getVendorOr403(req, res);
    if (!vendor) return;
    const { id } = req.params;
    const existing = await prisma.byo_templates.findUnique({ where: { id } });
    if (!existing || existing.vendor_id !== vendor.id) {
      return res.status(404).json({ error: 'Template not found' });
    }
    const { name, category, description, groups } = req.body;

    await prisma.byo_template_groups.deleteMany({ where: { template_id: id } });
    const template = await prisma.byo_templates.update({
      where: { id },
      data: {
        ...(name && { name: name.trim() }),
        ...(category !== undefined && { category: category || null }),
        ...(description !== undefined && { description: description || null }),
        status: 'pending_review',
        rejection_reason: null,
        byo_template_groups: { create: buildByoGroupsCreate(groups) }
      },
      include: BYO_TPL_INCLUDE
    });
    res.json({ success: true, template });
  } catch (error) {
    console.error('[BYO] update template error:', error);
    res.status(500).json({ error: 'Failed updating template', details: error.message });
  }
});

// DELETE /api/vendor/byo-templates/:id — delete own template
router.delete('/byo-templates/:id', firebaseAuth, async (req, res) => {
  try {
    const vendor = await getVendorOr403(req, res);
    if (!vendor) return;
    const { id } = req.params;
    const existing = await prisma.byo_templates.findUnique({ where: { id } });
    if (!existing || existing.vendor_id !== vendor.id) {
      return res.status(404).json({ error: 'Template not found' });
    }
    await prisma.byo_templates.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error('[BYO] delete template error:', error);
    res.status(500).json({ error: 'Failed deleting template', details: error.message });
  }
});

// ==========================================
// HELPER: Check if current time is within vendor's operating hours
// operatingHours is stored as JSON: { Monday: { isClosed, open: "09:00", close: "22:00" }, ... }
// ==========================================
function checkVendorOperatingHours(operatingHours) {
  if (!operatingHours) return true; // Default open if not configured
  try {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const now = new Date();
    const dayName = days[now.getDay()];
    const todayHours = operatingHours[dayName];

    if (!todayHours || todayHours.isClosed) return false; // Closed today

    const [openH, openM] = todayHours.open.split(':').map(Number);
    const [closeH, closeM] = todayHours.close.split(':').map(Number);
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const openMins = openH * 60 + openM;
    const closeMins = closeH * 60 + closeM;

    // Handle overnight shifts (e.g., 22:00 – 02:00)
    if (closeMins < openMins) {
      return currentMins >= openMins || currentMins <= closeMins;
    }
    return currentMins >= openMins && currentMins <= closeMins;
  } catch {
    return true; // Err on side of caution
  }
}


// ==========================================
// MODULE A1: KYC Submission (Vendor)
// ==========================================
router.post('/kyc', firebaseAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    // NOTE: the food/FSSAI license (isfcscUrl) is intentionally NOT persisted — the
    // vendor_kyc table has no column for it yet. The image still lands in R2 at
    // kyc/<vendorId>/isfcsc.jpg. Add an `isfcsc_url` column (canonical schema) to store it.
    const { govIdType, govIdUrl, businessProofType, businessProofUrl, panUrl, addressProofUrl } = req.body;

    console.log(`[VENDOR] KYC Submission attempt for UID: ${uid}`);
    console.log('[VENDOR] Payload:', JSON.stringify(req.body, null, 2));

    const profile = await withRetry(() => prisma.profile.findUnique({ where: { firebaseUid: uid }, include: { vendor: true } }));
    
    if (!profile) {
      console.error(`[VENDOR] KYC Error: Profile not found for UID ${uid}`);
      return res.status(404).json({ error: 'Profile not found' });
    }
    
    if (!profile.vendor) {
      console.error(`[VENDOR] KYC Error: Vendor record missing for profile ${profile.id}`);
      return res.status(404).json({ error: 'Vendor record not initialized' });
    }

    // Handle initial submission
    // Upsert KYC record (Only one record per vendor)
    let kycRecord;
    const existingKyc = await prisma.vendorKyc.findFirst({ where: { vendorId: profile.vendor.id } });
    
    if (existingKyc) {
      kycRecord = await withRetry(() => prisma.vendorKyc.update({
        where: { id: existingKyc.id },
        data: {
          govIdType: govIdType || undefined,
          govIdUrl: govIdUrl || undefined,
          businessProofType: businessProofType || undefined,
          businessProofUrl: businessProofUrl || undefined,
          panUrl: panUrl || undefined,
          addressProofUrl: addressProofUrl || undefined,
          status: 'submitted', // Reset status on re-submission
          submittedAt: new Date()
        }
      }));
      console.log(`[VENDOR] KYC record updated: ${kycRecord.id}`);
    } else {
      kycRecord = await withRetry(() => prisma.vendorKyc.create({
        data: {
          vendorId: profile.vendor.id,
          govIdType: govIdType || 'Government ID', 
          govIdUrl, 
          businessProofType: businessProofType || 'Business Proof', 
          businessProofUrl, 
          panUrl,
          addressProofUrl,
          status: 'submitted'
        }
      }));
      console.log(`[VENDOR] KYC record created: ${kycRecord.id}`);
    }
    
    // Status remains default (kyc_submitted) or could be explicitly set to under_review
    await withRetry(() => prisma.$transaction([
      prisma.vendor.update({
        where: { id: profile.vendor.id },
        data: { accountStatus: 'KYC_SUBMITTED' }
      }),
      prisma.profile.update({
        where: { id: profile.id },
        data: { profileStatus: 'UNDER_REVIEW' }
      })
    ]));

    res.json({ 
      success: true, 
      message: 'KYC submitted successfully. Your account is now under review by our admin team.', 
      kycId: kycRecord.id 
    });
  } catch (error) {
    console.error('[VENDOR] KYC Critical Error:', error);
    res.status(500).json({ 
      error: 'Internal Server Error', 
      details: error.message,
      code: error.code // Prisma error codes are useful
    });
  }
});

// ==========================================
// MODULE B1: Vendor Profile
// ==========================================
// Helper to safely add cache-buster to URL
const addCacheBuster = (url) => {
  if (!url || typeof url !== 'string' || url.includes('via.placeholder.com')) return url;
  // Strip existing cache buster if any
  const baseUrl = url.split('?')[0];
  return `${baseUrl}?t=${Date.now()}`;
};

// Helper to strip cache-buster before saving
const stripCacheBuster = (url) => {
  if (!url || typeof url !== 'string') return url;
  return url.split('?')[0];
};

router.get('/profile', firebaseAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    let profile = await withRetry(() => prisma.profile.findUnique({ 
      where: { firebaseUid: uid }, 
      include: { 
        vendor: { 
          include: { 
            bankDetails: true, complianceFlags: true
          } 
        } 
      } 
    }));
    
    if (!profile) {
      console.warn(`[VENDOR] Self-healing: Profile not found for UID ${uid}, creating it now`);
      const phone = req.user.phoneNumber || null;
      // Adopt an existing profile with the same phone (different UID) instead of
      // creating a duplicate — phone_number is unique. (Phone-OTP proves ownership.)
      if (phone) {
        const existingByPhone = await withRetry(() => prisma.profile.findFirst({
          where: { phoneNumber: phone, NOT: { firebaseUid: uid } }
        }));
        if (existingByPhone) {
          console.warn(`[VENDOR] Adopting existing profile ${existingByPhone.id} (phone match) to UID ${uid}`);
          await withRetry(() => prisma.profile.update({
            where: { id: existingByPhone.id },
            data: { firebaseUid: uid }
          }));
        }
      }
      // Create only if still missing after adoption.
      const exists = await withRetry(() => prisma.profile.findUnique({ where: { firebaseUid: uid } }));
      if (!exists) {
        await withRetry(() => prisma.profile.create({
          data: {
            firebaseUid: uid,
            phoneNumber: phone || `none_${uid.substring(0, 10)}`,
            role: 'VENDOR',
            profileStatus: 'PENDING'
          }
        }));
      }
      profile = await withRetry(() => prisma.profile.findUnique({
        where: { firebaseUid: uid },
        include: { vendor: { include: { bankDetails: true, complianceFlags: true } } }
      }));
    }

    // SELF-HEALING: If vendor record is missing, create it now
    if (!profile.vendor) {
      console.warn(`[VENDOR] Self-healing: Initializing missing vendor record for profile ${profile.id}`);
      await withRetry(() => prisma.vendor.create({
        data: {
          profileId: profile.id,
          businessName: 'My Store',
          ownerName: 'Vendor Owner',
          businessAddress: 'Address Pending',
          email: req.user.email || null
        }
      }));
      // Re-fetch with the new vendor record
      const updatedProfile = await withRetry(() => prisma.profile.findUnique({ 
        where: { id: profile.id }, 
        include: { vendor: { include: { bankDetails: true, complianceFlags: true } } } 
      }));
      
      if (updatedProfile) {
        // Continue with the fresh profile
        var finalProfile = updatedProfile;
      } else {
        return res.status(500).json({ error: 'Failed to initialize vendor record on retry' });
      }
    } else {
      var finalProfile = profile;
    }

    // Sync missing vendor email if logged in via Google Auth
    if (finalProfile.vendor && !finalProfile.vendor.email && req.user.email) {
      console.log(`[VENDOR] Syncing vendor email to ${req.user.email}`);
      await prisma.vendor.update({
        where: { id: finalProfile.vendor.id },
        data: { email: req.user.email }
      });
      finalProfile.vendor.email = req.user.email;
    }

    // A vendor authenticated via phone OTP has, by definition, a verified phone. Self-heal
    // the flag (set false on the self-healed vendor record) when the authenticated phone
    // matches the registered one — otherwise an approved OTP vendor gets bounced to the
    // redundant one-time re-verification screen instead of landing on the dashboard.
    if (
      finalProfile.vendor &&
      !finalProfile.vendor.phoneVerified &&
      req.user.phoneNumber &&
      finalProfile.phoneNumber === req.user.phoneNumber
    ) {
      console.log(`[VENDOR] Marking phone verified (OTP-authenticated) for vendor ${finalProfile.vendor.id}`);
      await prisma.vendor.update({
        where: { id: finalProfile.vendor.id },
        data: { phoneVerified: true }
      });
      finalProfile.vendor.phoneVerified = true;
    }

    // AUTO-ADOPT PHONE FROM OTHER PROFILES WITH THE SAME EMAIL
    const userEmail = req.user.email;
    if (userEmail && (!finalProfile.phoneNumber || finalProfile.phoneNumber.startsWith('none_'))) {
      const otherVendor = await prisma.vendor.findFirst({
        where: {
          email: userEmail,
          profile: {
            phoneNumber: {
              not: null,
              not: { startsWith: 'none_' }
            }
          }
        },
        include: { profile: true }
      });

      if (otherVendor && otherVendor.profile?.phoneNumber) {
        const matchingPhone = otherVendor.profile.phoneNumber;
        console.log(`[VENDOR-PROFILE] Found existing phone number ${matchingPhone} under same email ${userEmail}. Merging phone!`);

        // Check and release duplicate phone profile
        const duplicateProfile = await prisma.profile.findFirst({
          where: { phoneNumber: matchingPhone, NOT: { id: finalProfile.id } }
        });

        if (duplicateProfile) {
          await prisma.profile.update({
            where: { id: duplicateProfile.id },
            data: { phoneNumber: `old_${duplicateProfile.id.substring(0, 10)}` }
          });
        }

        // Set it on the current profile
        const mergedProfile = await prisma.profile.update({
          where: { id: finalProfile.id },
          data: { phoneNumber: matchingPhone },
          include: { 
            vendor: { 
              include: { 
                bankDetails: true, complianceFlags: true
              } 
            } 
          }
        });
        finalProfile = mergedProfile;
      }
    }

    // The vendor's authoritative status comes from accountStatus. This is what the vendor
    // app must see — NOT the raw shared profileStatus, which reflects the CUSTOMER identity
    // for a number that is both a vendor and a customer (allowed). vendorMappedStatus is
    // reported as this endpoint's profileStatus below.
    const { profileStatusForAccount } = require('../lib/vendorStatus');
    let vendorMappedStatus = finalProfile.vendor
      ? profileStatusForAccount(finalProfile.vendor.accountStatus, finalProfile.profileStatus)
      : finalProfile.profileStatus;

    // Persist to the shared Profile.profileStatus ONLY for a vendor-only profile — writing
    // it for a dual-role user would clobber their customer status. (An unregistered
    // vendor whose stale profileStatus said ACTIVE previously walked onto the dashboard;
    // reporting vendorMappedStatus below fixes that regardless of what's persisted.)
    if (finalProfile.role === 'VENDOR' && finalProfile.vendor && vendorMappedStatus !== finalProfile.profileStatus) {
      console.log(`[VENDOR-PROFILE] Syncing status from ${finalProfile.profileStatus} to ${vendorMappedStatus}`);
      const updatedProfile = await prisma.profile.update({
        where: { id: finalProfile.id },
        data: { profileStatus: vendorMappedStatus },
        include: { vendor: { include: { bankDetails: true, complianceFlags: true } } }
      });
      finalProfile = updatedProfile;
    }

    // Self-Healing block expiration for temporarily disabled accounts
    if (finalProfile.profileStatus && finalProfile.profileStatus.startsWith('DISABLED:')) {
      const disabledUntilStr = finalProfile.profileStatus.split('DISABLED:')[1];
      const disabledUntil = new Date(disabledUntilStr);
      if (disabledUntil < new Date()) {
        console.log(`[VENDOR-PROFILE] Temporary block expired. Restoring profile status for ${finalProfile.id}`);
        const restoredProfile = await prisma.profile.update({
          where: { id: finalProfile.id },
          data: { profileStatus: 'APPROVED' }
        });
        finalProfile.profileStatus = 'APPROVED';
      }
    }

    const v = finalProfile.vendor;

    // Heartbeat: this endpoint is polled every ~15s while the vendor app's JS is alive,
    // so every fetch is proof of life. Stamp it (fire-and-forget) so the reachability
    // check can tell a genuinely-present vendor from one whose app was killed while
    // 'online'. Only meaningful while online, but harmless to always stamp.
    prisma.vendor.update({ where: { id: v.id }, data: { bubbleLastSeenAt: new Date() } })
      .catch((e) => console.warn('[VENDOR] heartbeat stamp failed:', e.message));

    // Transform to match frontend expectations
    const vendorResponse = {
      id: v.id,
      businessName: v.businessName,
      ownerName: v.ownerName,
      description: v.storeDescription,
      category: v.businessCategory,
      phone: finalProfile.phoneNumber,
      email: v.email,
      deliveryRadius: parseFloat(v.deliveryRadius) || 0,
      logo: addCacheBuster(v.logoUrl) || 'https://via.placeholder.com/150',
      banner: addCacheBuster(v.bannerUrl) || 'https://via.placeholder.com/800x200',
      profilePic: addCacheBuster(v.profilePicUrl) || 'https://via.placeholder.com/150',
      operatingHours: v.operatingHours || 'Not configured',
      kycStatus: v.accountStatus,
      // The VENDOR's status (from accountStatus), not the shared field — so a dual
      // vendor+customer number is judged by its vendor approval, not its customer status.
      profileStatus: vendorMappedStatus,
      phoneVerified: v.phoneVerified,
      // Authoritative online/offline so the app reflects a server-side auto-offline
      // (e.g. the store was force-closed while online) on the next launch.
      onlineStatus: v.onlineStatus || 'offline',
      commissionModel: v.commissionModel,
      location: {
        address: v.businessAddress,
        latitude: parseFloat(v.latitude) || 0,
        longitude: parseFloat(v.longitude) || 0,
      },
      bankDetails: v.bankDetails ? {
        bankName: v.bankDetails.bankName,
        accountNumber: v.bankDetails.accountNumber,
        ifscCode: v.bankDetails.ifscCode,
        holderName: v.bankDetails.accountHolder,
      } : {
        bankName: 'Not set',
        accountNumber: '****',
      },
      complianceFlags: v.complianceFlags.map(f => f.reason) || []
    };

    console.log(`[VENDOR-API] Profile fetch for UID: ${uid}, Status: ${v.accountStatus}, ProfileStatus: ${finalProfile.profileStatus}`);
    res.json({ success: true, vendor: vendorResponse });

  } catch (error) {
    console.error('[VENDOR-PROFILE] Failed to get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile', details: error.message });
  }
});

// Original register route doubles as profile update
router.put('/profile', firebaseAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { 
      businessName, ownerName, phone, address, category, description, location, 
      operatingHours, bankData, fcmToken, pushToken, email, deliveryRadius, logo, banner, profilePic,
      commissionModel
    } = req.body;

    let profile = await withRetry(() => prisma.profile.findUnique({ where: { firebaseUid: uid }, include: { vendor: true } }));
    if (!profile) {
       console.warn(`[VENDOR] Self-healing: Profile not found for UID ${uid}, creating it now in PUT`);
       profile = await withRetry(() => prisma.profile.create({
         data: {
           firebaseUid: uid,
           phoneNumber: req.user.phoneNumber || `none_${uid.substring(0, 10)}`,
           role: 'VENDOR',
           profileStatus: 'PENDING'
         },
         include: { vendor: true }
       }));
    }

    // SELF-HEALING: If vendor record is missing (due to a previous timeout), create it now
    let vendor = profile.vendor;
    if (!vendor) {
      console.warn(`[VENDOR] Self-healing: Creating missing vendor record for profile ${profile.id}`);
      vendor = await withRetry(() => prisma.vendor.create({
        data: {
          profileId: profile.id,
          businessName: businessName || 'New Vendor',
          ownerName: ownerName || 'Pending Registration',
          businessAddress: address || 'Pending',
          phoneVerified: false
        }
      }));
    }

    const parsedLocation = typeof location === 'string' ? JSON.parse(location) : location;
    const parsedHours = typeof operatingHours === 'string' ? JSON.parse(operatingHours) : operatingHours;

    const updateData = {
      businessName: businessName || undefined,
      ownerName: ownerName || undefined,
      businessAddress: address || undefined,
      businessCategory: category || undefined,
      storeDescription: description || undefined,
      latitude: parsedLocation?.latitude || undefined,
      longitude: parsedLocation?.longitude || undefined,
      operatingHours: parsedHours || undefined,
      deliveryRadius: deliveryRadius ? parseFloat(deliveryRadius) : undefined,
      logoUrl: logo ? stripCacheBuster(logo) : undefined,
      bannerUrl: banner ? stripCacheBuster(banner) : undefined,
      profilePicUrl: profilePic ? stripCacheBuster(profilePic) : undefined,
      commissionModel: undefined // Handled separately below
    };

    let phoneUpdated = false;
    if (phone && phone !== profile.phoneNumber) {
      // Check if another profile already uses this phone number
      const duplicatePhone = await prisma.profile.findFirst({
        where: { 
          phoneNumber: phone,
          NOT: { id: profile.id }
        }
      });
      if (duplicatePhone) {
        return res.status(400).json({ error: 'This phone number is already registered under another account.' });
      }
      
      updateData.phoneVerified = false; // Reset phoneVerified if number changes
      phoneUpdated = true;
    }

    if (email && email !== vendor.email) {
      updateData.email = email;
    }

    if (commissionModel) {
      if (vendor.commissionModel && vendor.commissionModel !== commissionModel) {
        return res.status(403).json({ error: 'Commission model cannot be changed. Please contact admin for assistance.' });
      }
      updateData.commissionModel = commissionModel;
    }

    // Proceed to update the vendor
    vendor = await withRetry(() => prisma.vendor.update({
      where: { id: vendor.id },
      data: updateData
    }));

    let updatedProfile = profile;
    if (phoneUpdated) {
      // Keep Profile table's phoneNumber and firebaseUid in sync
      updatedProfile = await withRetry(() => prisma.profile.update({
        where: { id: profile.id },
        data: { phoneNumber: phone }
      }));
    }
    
    // Sync to VendorOperatingHour table for relational queries
    if (parsedHours && typeof parsedHours === 'object') {
      const dayMap = { 'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3, 'Thursday': 4, 'Friday': 5, 'Saturday': 6 };
      
      try {
        await prisma.$transaction([
          prisma.vendorOperatingHour.deleteMany({ where: { vendorId: vendor.id } }),
          prisma.vendorOperatingHour.createMany({
            data: Object.entries(parsedHours).map(([day, config]) => ({
              vendorId: vendor.id,
              dayOfWeek: dayMap[day] ?? 0,
              openTime: config.open || '09:00',
              closeTime: config.close || '22:00',
              isClosed: config.isClosed || false
            }))
          })
        ]);
        console.log(`[VENDOR] Synced operating hours for vendor ${vendor.id}`);
      } catch (syncError) {
        console.error('[VENDOR] Failed to sync operating hours table:', syncError.message);
      }
    }


    // Update Profile FCM token (no pushToken column exists — writing it is a
    // Prisma "Unknown argument" crash; Expo tokens are intentionally dropped)
    if (fcmToken) {
      await withRetry(() => claimPushToken(profile.firebaseUid, fcmToken));
    }

    if (bankData && bankData.accountNumber) {
      await withRetry(() => prisma.vendorBankDetails.upsert({
        where: { vendorId: vendor.id },
        update: {
          accountHolder: bankData.holderName, bankName: bankData.bankName, accountNumber: bankData.accountNumber,
          ifscCode: bankData.ifscCode, upiId: bankData.upiId || null,
        },
        create: {
          vendorId: vendor.id, accountHolder: bankData.holderName, bankName: bankData.bankName,
          accountNumber: bankData.accountNumber, ifscCode: bankData.ifscCode, upiId: bankData.upiId || null,
        }
      }));
    }
    // Re-fetch to get complete updated record
    const updatedV = await prisma.vendor.findUnique({ 
      where: { id: vendor.id }, 
      include: { bankDetails: true, complianceFlags: true } 
    });

    const vendorResponse = {
      id: updatedV.id,
      businessName: updatedV.businessName,
      ownerName: updatedV.ownerName,
      description: updatedV.storeDescription,
      category: updatedV.businessCategory,
      phone: updatedProfile.phoneNumber,
      email: updatedV.email,
      deliveryRadius: parseFloat(updatedV.deliveryRadius) || 0,
      logo: updatedV.logoUrl ? `${updatedV.logoUrl}?t=${Date.now()}` : 'https://via.placeholder.com/150',
      banner: updatedV.bannerUrl ? `${updatedV.bannerUrl}?t=${Date.now()}` : 'https://via.placeholder.com/800x200',
      profilePic: updatedV.profilePicUrl ? `${updatedV.profilePicUrl}?t=${Date.now()}` : 'https://via.placeholder.com/150',
      operatingHours: updatedV.operatingHours || 'Not configured',
      kycStatus: updatedV.accountStatus,
      profileStatus: profile.profileStatus,
      phoneVerified: updatedV.phoneVerified,
      commissionModel: updatedV.commissionModel,
      bankDetails: updatedV.bankDetails || null,
      location: { latitude: Number(updatedV.latitude || 0), longitude: Number(updatedV.longitude || 0) }
    };

    res.json({ success: true, vendor: vendorResponse });
  } catch (error) {
    console.error('[VENDOR] Profile update error:', error);
    res.status(500).json({ error: 'Failed', details: error.message });
  }
});


// ==========================================
// MODULE B2 & B3: Vendor Status Toggle
// ==========================================
router.put('/status/toggle', firebaseAuth, requireKyc, async (req, res) => {
  try {
    const { uid } = req.user;
    const { isOnline, dismissBubble } = req.body;

    const profile = req.profile; // reuse profile+vendor already loaded by requireKyc
    if (!profile?.vendor) {
        console.error(`[VENDOR] Status toggle failed: Vendor not found for UID ${uid}`);
        return res.status(404).json({ error: 'Vendor profile not found' });
    }
    const vendorId = profile.vendor.id;
    console.log(`[VENDOR] Toggling status for ${profile.vendor.businessName} (${vendorId}) to ${isOnline ? 'ONLINE' : 'OFFLINE'}`);

    const activeOrdersCount = await prisma.order.count({
      where: { vendorId, status: { in: ACTIVE_ORDER_STATUSES } }
    });

    if (dismissBubble) {
      if (isOnline === false) {
        const status = 'offline';
        await prisma.vendor.update({ where: { id: vendorId }, data: { onlineStatus: status } });
        await fcm.updateFloatingBubble(vendorId, false);
        emitVendorStatusUpdate(vendorId, false);
        return res.json({ success: true, status });
      } else {
        const status = 'online';
        // Stamp the heartbeat on going online so the vendor is immediately reachable
        // (not treated as stale until their first profile poll ~15s later).
        await prisma.vendor.update({ where: { id: vendorId }, data: { onlineStatus: status, bubbleLastSeenAt: new Date() } });
        await fcm.updateFloatingBubble(vendorId, true, activeOrdersCount);
        emitVendorStatusUpdate(vendorId, true);
        return res.json({ success: true, status });
      }
    }

    if (!isOnline && activeOrdersCount > 0) {
      const status = 'stop_new_orders';
      await prisma.vendor.update({ where: { id: vendorId }, data: { onlineStatus: status } });
      await fcm.updateFloatingBubble(vendorId, false);
      emitVendorStatusUpdate(vendorId, false);
      return res.json({ 
        success: true, 
        status, 
        message: 'You will stop receiving new orders. Complete current orders to go offline.' 
      });
    }

    const newStatus = isOnline ? 'online' : 'offline';
    await prisma.vendor.update({
      where: { id: vendorId },
      data: { onlineStatus: newStatus, ...(isOnline ? { bubbleLastSeenAt: new Date() } : {}) },
    });
    await fcm.updateFloatingBubble(vendorId, isOnline, activeOrdersCount);
    emitVendorStatusUpdate(vendorId, isOnline);

    res.json({ success: true, status: newStatus });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});


// Accept Order
router.put('/orders/:id/accept', firebaseAuth, requireKyc, async (req, res) => {
  try {
    const { id } = req.params;
    const profile = req.profile; // reuse profile+vendor already loaded by requireKyc
    
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order || order.vendorId !== profile.vendor.id) return res.status(404).json({ error: 'Order not found' });

    if (!['pending_vendor', 'pending_vendor_response'].includes(order.status)) {
      return res.status(400).json({ error: 'Order already processed' });
    }

    const OrderService = require('../services/orderService');
    await OrderService.updateOrderStatus(id, 'accepted', 'VENDOR');

    // Update SLA Metric for successful acceptance
    await prisma.vendorSlaMetric.upsert({
      where: { vendorId: profile.vendor.id },
      update: { acceptedWithinSla: { increment: 1 } },
      create: { vendorId: profile.vendor.id, totalOrders: 1, acceptedWithinSla: 1 }
    });

    // Schedule 15-second auto-transition to "Preparing Order"
    await orderSlaQueue.add('autoPrepare', { orderId: id, type: 'auto_prepare' }, { delay: 15 * 1000 });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error accepting order' });
  }
});

// Reject Order with logic
router.put('/orders/:id/reject', firebaseAuth, requireKyc, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, otherNotes } = req.body;
    const profile = req.profile; // reuse profile+vendor already loaded by requireKyc

    if (!reason) return res.status(400).json({ error: 'Rejection reason is required' });
    if (reason === 'other' && !otherNotes) return res.status(400).json({ error: 'Notes required when reason is "other"' });

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order || order.vendorId !== profile.vendor.id) return res.status(404).json({ error: 'Order not found' });
    
    // Allow cancellation only before the rider takes the parcel (Shadowfax bills 100% after pickup).
    if (!isCancellableStatus(order.status)) {
      return res.status(400).json({
        error: `Order cannot be cancelled. Current status: ${order.status}`,
        code: 'ORDER_PROCESSED'
      });
    }

    // Check if the vendor is within operating hours (read from their stored schedule)
    const isWithinOperatingHours = checkVendorOperatingHours(profile.vendor.operatingHours);

    if (isWithinOperatingHours) {
      // During operating hours — vendor should use "Contact Support" instead of rejecting
      return res.status(403).json({ 
        error: 'Cannot reject orders during operating hours. Use Contact Support instead.',
        code: 'WITHIN_OPERATING_HOURS'
      });
    }

    const OrderService = require('../services/orderService');
    await OrderService.updateOrderStatus(id, 'cancelled_by_vendor', 'VENDOR');

    // Record WHY on VendorOrderAction — the model that actually has these fields.
    // This used to write cancellationReason/cancellationNote onto Order, which has
    // neither, so Prisma threw "Unknown argument" AFTER the order and its Shadowfax
    // delivery had already been cancelled: the vendor saw "Error rejecting order",
    // the reason was lost, and the auto-offline check below never ran.
    // The app sends display strings ('Store closed', 'Other: <text>'), the column is
    // an enum, so map them; anything unrecognised is OTHER with the text kept as the note.
    const rawReason = String(reason || '').trim();
    const REJECT_REASON_ENUM = {
      'store closed': 'STORE_CLOSED',
      'kitchen closed': 'KITCHEN_CLOSED',
      'item(s) unavailable': 'ITEMS_UNAVAILABLE',
      'unable to fulfill order': 'UNABLE_TO_FULFILL',
      'staff unavailable': 'STAFF_UNAVAILABLE',
      'technical issue': 'TECHNICAL_ISSUE',
    };
    const VALID_REASONS = Object.values(REJECT_REASON_ENUM).concat('OTHER');
    const rejectionReason =
      REJECT_REASON_ENUM[rawReason.toLowerCase()] ||
      (VALID_REASONS.includes(rawReason.toUpperCase()) ? rawReason.toUpperCase() : 'OTHER');

    // Non-fatal: the order is already cancelled, so failing to write the audit row
    // must not hand the vendor a 500 for an action that actually succeeded.
    await prisma.vendorOrderAction.create({
      data: {
        orderId: id,
        vendorId: profile.vendor.id,
        action: 'REJECT',
        rejectionReason,
        rejectionNote: otherNotes || (rejectionReason === 'OTHER' ? rawReason || null : null),
        newStatus: 'cancelled_by_vendor',
      }
    }).catch((e) => console.warn('[VENDOR] Could not record rejection reason:', e.message));

    // Check if vendor should automatically go offline
    await checkAndTransitionVendorOffline(profile.vendor.id);

    res.json({ success: true });
  } catch (error) {
    console.error('[VENDOR] Reject order error:', error);
    res.status(500).json({ error: 'Error rejecting order' });
  }
});

// Contact Support
router.put('/orders/:id/contact-support', firebaseAuth, requireKyc, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const profile = req.profile; // reuse profile+vendor already loaded by requireKyc
    if (!profile?.vendor) return res.status(404).json({ error: 'Vendor not found' });

    // 1. Create Support Request Record (User explicitly asked where it was stored)
    await prisma.vendorSupportRequest.create({
      data: {
        vendorId: profile.vendor.id,
        orderId: id,
        issueType: reason || 'General Support',
        message: `Support requested by vendor for order ${id}`
      }
    });

    // 2. Flag Order
    await prisma.order.update({
      where: { id },
      data: { 
        status: 'pending_vendor_response',
        isFlagged: true,
        flagReason: reason || 'Support requested by vendor'
      }
    });

    // Start SLA timeout (increased to 5 for support)
    try {
      await orderSlaQueue.add('supportTimeout', { orderId: id, type: 'vendor_support' }, { delay: 5 * 60 * 1000 });
    } catch (qErr) {
      console.warn('[VENDOR] Failed to add supportTimeout to queue:', qErr.message);
    }
    
    // Broadcast to admin socket
    const io = require('../lib/socket').getIo();
    if (io) io.of('/admin').to('admin_global').emit('vendor_support_request', { 
      orderId: id,
      vendorName: profile.vendor.businessName,
      reason: reason || 'No specific reason'
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[VENDOR] Support request error:', error);
    res.status(500).json({ error: 'Error processing support request' });
  }
});

router.post('/orders/:id/notify-customer', firebaseAuth, requireKyc, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, message } = req.body;

    const order = await prisma.order.findUnique({
      where: { id },
      include: { customer: { include: { profile: true } } }
    });

    if (!order || !order.customer?.profile?.firebaseUid) {
      return res.status(404).json({ error: 'Customer not found or not registered for notifications' });
    }

    // This endpoint had NO guards at all: any KYC-approved vendor could push an arbitrary
    // title/body to any customer for any order id they knew.
    if (!req.profile?.vendor || order.vendorId !== req.profile.vendor.id) {
      return res.status(403).json({ error: 'This order does not belong to your store.' });
    }

    // And a finished order must not generate customer updates. An order auto-cancelled for
    // an SLA breach still offered "Food Ready" from history, and the customer was told
    // their food was ready for an order that no longer existed.
    if (isTerminalStatus(order.status)) {
      return res.status(409).json({
        error: `This order is ${String(order.status).replace(/_/g, ' ')} — the customer can no longer be notified about it.`,
        code: 'ORDER_NOT_ACTIVE',
      });
    }

    const fcm = require('../lib/fcm');
    await fcm.sendToCustomer(order.customer.profile.firebaseUid, {
      title: title || 'Message from Restaurant',
      body: message,
      type: 'manual_update',
      orderId: id
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[VENDOR] Manual notification error:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// Helper to format orders with item details for vendor (Async with fallback for UUIDs)
const formatOrdersForVendorAsync = async (orders) => {
  const isUuid = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const allIds = new Set();
  
  // 1. Collect all IDs that need resolution
  orders.forEach(o => {
    o.items.forEach(i => {
      if (i.addonsSummary) {
        const summary = typeof i.addonsSummary === 'string' ? JSON.parse(i.addonsSummary) : i.addonsSummary;
        if (summary.selectedAddons) {
          summary.selectedAddons.forEach(a => {
            const id = typeof a === 'object' ? a.id : a;
            if (id && isUuid(id) && !(typeof a === 'object' && a.name)) allIds.add(id);
          });
        }
        if (summary.customizations) {
          summary.customizations.forEach(c => {
            if (c.selectedOptions) {
              c.selectedOptions.forEach(opt => {
                const id = typeof opt === 'object' ? opt.id : opt;
                if (id && isUuid(id) && !(typeof opt === 'object' && opt.name)) allIds.add(id);
              });
            }
          });
        }
      }
    });
  });

  // 2. Fetch names from DB
  const nameMap = new Map();
  if (allIds.size > 0) {
    const [addons, options] = await Promise.all([
      prisma.productAddon.findMany({ where: { id: { in: Array.from(allIds) } }, select: { id: true, name: true } }),
      prisma.customizationOption.findMany({ where: { id: { in: Array.from(allIds) } }, select: { id: true, name: true } })
    ]);
    addons.forEach(a => nameMap.set(a.id, a.name));
    options.forEach(o => nameMap.set(o.id, o.name));
  }

  // 3. Format orders
  return orders.map(o => ({
    ...o,
    customerName: o.customer?.fullName || 'Customer',
    customer: o.customer ? {
      fullName: o.customer.fullName,
      phone: o.customer.profile?.phoneNumber || ''
    } : null,
    rider: o.rider ? {
      fullName: o.rider.fullName,
      phone: o.rider.profile?.phoneNumber || ''
    } : null,
    total: parseFloat(o.totalAmount),
    items: o.items.map(i => {
      const details = [];
      let instructions = null;
      
      if (i.addonsSummary) {
        const summary = typeof i.addonsSummary === 'string' ? JSON.parse(i.addonsSummary) : i.addonsSummary;
        instructions = summary.instructions || null;
        
        if (summary.selectedAddons && Array.isArray(summary.selectedAddons)) {
          summary.selectedAddons.forEach(a => {
            const name = (typeof a === 'object' && a.name) ? a.name : nameMap.get(typeof a === 'object' ? a.id : a);
            const qty = (typeof a === 'object' && typeof a.quantity === 'number') ? a.quantity : 1;
            if (name && !isUuid(name)) {
              details.push(qty > 1 ? `${qty}x ${name}` : name);
            }
          });
        }
        
        if (summary.customizations && Array.isArray(summary.customizations)) {
          summary.customizations.forEach(group => {
            if (group.selectedOptions && Array.isArray(group.selectedOptions)) {
              group.selectedOptions.forEach(opt => {
                const name = (typeof opt === 'object' && opt.name) ? opt.name : nameMap.get(typeof opt === 'object' ? opt.id : opt);
                const qty = (typeof opt === 'object' && typeof opt.quantity === 'number') ? opt.quantity : 1;
                if (name && !isUuid(name)) {
                  details.push(qty > 1 ? `${qty}x ${name}` : name);
                }
              });
            }
          });
        }
      }

      return { 
        qty: i.quantity, 
        name: i.productName,
        addons: details, 
        instructions: instructions,
        isCustomized: details.length > 0
      };
    })
  }));
};

// Get Vendor Orders (Active & History)
router.get('/orders', firebaseAuth, requireKyc, async (req, res) => {
  try {
    const profile = req.profile; // reuse profile+vendor already loaded by requireKyc
    if (!profile?.vendor) return res.status(404).json({ error: 'Vendor not found' });

    const orders = await prisma.order.findMany({
      where: { vendorId: profile.vendor.id },
      include: { 
        items: true,
        customer: { select: { fullName: true, profile: { select: { phoneNumber: true } } } },
        rider: { select: { fullName: true, profile: { select: { phoneNumber: true } } } },
        statusHistory: { orderBy: { changedAt: 'asc' } }
      },
      orderBy: { createdAt: 'desc' }
    });

    // SELF-HEALING: Cleanup any pending_vendor orders that have already timed out (1 min)
    const now = new Date();
    const expiredOrders = orders.filter(o => 
      (o.status === 'pending_vendor' || o.status === 'Awaiting Vendor Acceptance') && 
      (now - new Date(o.createdAt)) > 5 * 60 * 1000
    );

    if (expiredOrders.length > 0) {
      console.log(`[VENDOR-API] Self-healing: Found ${expiredOrders.length} expired pending orders. Cancelling.`);
      const expiredIds = expiredOrders.map(o => o.id);
      
      await prisma.order.updateMany({
        where: { id: { in: expiredIds } },
        data: { 
          status: 'CANCELLED',
          isFlaggedAdmin: true,
          flagReason: 'SLA Timeout (Cleanup on Fetch)'
        }
      });

      // Log breaches for these (if not already logged)
      for (const o of expiredOrders) {
        // Check if breach record already exists
        const existingBreach = await prisma.vendorBreach.findFirst({
          where: { orderId: o.id, type: 'SLA_TIMEOUT' }
        });

        if (!existingBreach) {
          console.log(`[VENDOR-API] Self-healing breach for order: ${o.id}, vendor: ${profile.vendor.id}`);
          try {
            const breach = await prisma.vendorBreach.create({
              data: {
                vendorId: profile.vendor.id,
                orderId: o.id,
                type: 'SLA_TIMEOUT',
                reason: 'SLA Timeout (System cleanup on fetch)'
              }
            });
            console.log(`[VENDOR-API] Breach record created successfully: ${breach.id}`);
          } catch (err) {
            console.error(`[VENDOR-API] FAILED to create breach record: ${err.message}`);
          }

          await prisma.vendorSlaMetric.upsert({
            where: { vendorId: profile.vendor.id },
            update: { breachedOrders: { increment: 1 } },
            create: { vendorId: profile.vendor.id, totalOrders: 1, breachedOrders: 1 }
          });
        }
      }

      const freshOrders = await prisma.order.findMany({
        where: { vendorId: profile.vendor.id },
        include: { 
          items: true,
          customer: { select: { fullName: true, profile: { select: { phoneNumber: true } } } },
          rider: { select: { fullName: true, profile: { select: { phoneNumber: true } } } },
          statusHistory: { orderBy: { changedAt: 'asc' } }
        },
        orderBy: { createdAt: 'desc' }
      });
      
      const formatted = await formatOrdersForVendorAsync(freshOrders);

      return res.json({
        active: formatted.filter(o => ACTIVE_ORDER_STATUSES.includes(o.status)),
        history: formatted.filter(o => !ACTIVE_ORDER_STATUSES.includes(o.status))
      });
    }

    // Format for frontend
    const formattedOrders = await formatOrdersForVendorAsync(orders);

    // Active = awaiting the vendor OR out for delivery. History = terminal.
    const active = formattedOrders.filter(o => ACTIVE_ORDER_STATUSES.includes(o.status));
    const history = formattedOrders.filter(o => !ACTIVE_ORDER_STATUSES.includes(o.status));

    res.json({ success: true, active, history });
  } catch (error) {
    console.error('[VENDOR] Fetch orders CRITICAL error:', error);
    res.status(500).json({ error: 'Failed to fetch orders', details: error.message });
  }
});

// ==========================================
// Vendor delivery tracking (seed for the order-detail screen)
// ==========================================
// Sockets only reach clients already listening; a screen opened after the rider was assigned
// must seed from here. Rider LOCATION is returned only until pickup — after that the vendor
// sees status only (same rule the socket layer enforces in lib/socket.js).
router.get('/orders/:id/tracking', firebaseAuth, requireKyc, async (req, res) => {
  try {
    const { id } = req.params;
    const profile = req.profile; // profile+vendor already loaded by requireKyc
    if (!profile?.vendor) return res.status(404).json({ error: 'Vendor not found' });

    const order = await prisma.order.findUnique({ where: { id }, select: { vendorId: true, status: true } });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.vendorId !== profile.vendor.id) return res.status(403).json({ error: 'Not your order' });

    const { getSfxTracking } = require('../lib/sfxTracking');
    const sfxMapper = require('../src/modules/delivery/shadowfax/shadowfax.mapper');
    const { sfxStatus, rider, riderLocation } = await getSfxTracking(id);

    const prePickup = sfxMapper.isPrePickupOrderStatus(order.status);
    res.json({
      success: true,
      status: order.status,
      sfxStatus,
      rider,                                        // identity stays visible after pickup
      riderLocation: prePickup ? riderLocation : null, // coordinates cut off at pickup
      prePickup
    });
  } catch (error) {
    console.error('[VENDOR-TRACKING] Failed:', error.message);
    res.status(500).json({ error: 'Failed to fetch tracking info' });
  }
});

// ==========================================
// MODULE B5: Order Status Updates
// ==========================================
router.put('/orders/:id/status', firebaseAuth, requireKyc, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // accepted, preparing, ready_for_pickup
    if (!['accepted', 'preparing', 'ready_for_pickup'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const OrderService = require('../services/orderService');
    const order = await OrderService.updateOrderStatus(id, status, 'VENDOR');

    // Notify Shadowfax if ready
    if (status === 'ready_for_pickup') {
      try {
        const deliveryService = require('../src/modules/delivery/delivery.service');
        await deliveryService.onVendorReadyForPickup(id);
      } catch (sfxErr) {
        console.warn(`[VENDOR-API] Failed to notify SFX of ready status for order ${id}:`, sfxErr.message);
      }
    }

    // Handle Delay Tracking (> 10 mins)
    if (status === 'ready_for_pickup' && order.preparingAt && order.readyAt) {
      const durationMs = order.readyAt.getTime() - order.preparingAt.getTime();
      const durationMins = durationMs / (1000 * 60);
      
      if (durationMins > 1) {
        console.log(`[VENDOR-API] Order ${id} preparation delayed: ${durationMins.toFixed(1)} mins`);
        
        // Flag the order
        await prisma.order.update({
          where: { id },
          data: { 
            isFlagged: true,
            isFlaggedAdmin: true,
            flagReason: `Delayed Preparation: ${durationMins.toFixed(1)} mins`
          }
        });

        // Log to VendorBreach
        await prisma.vendorBreach.create({
          data: {
            vendorId: order.vendorId,
            orderId: id,
            type: 'PREPARATION_DELAY',
            reason: `Order took ${durationMins.toFixed(1)} mins to prepare (Target: 1 min)`
          }
        });
      }
    }

    res.json({ success: true, order });
  } catch (error) {
    console.error('[VENDOR] Status update error:', error);
    res.status(500).json({ error: 'Status update failed' });
  }
});

// ==========================================
// MODULE B6 & B7: Product Management & Taxonomy
// ==========================================


router.get('/products', firebaseAuth, async (req, res) => {
  try {
    const profile = await withRetry(() => prisma.profile.findUnique({ 
      where: { firebaseUid: req.user.uid }, 
      include: { vendor: true } 
    }));
    
    if (!profile?.vendor) return res.status(404).json({ error: 'Vendor not found' });

    const products = await withRetry(() => prisma.product.findMany({
      where: { vendorId: profile.vendor.id },
      include: { 
        addOns: true, 
        images: true,
        categories: true,
        customizationGroups: {
          include: { 
            options: {
              include: { 
                // We'll potentially include linked product info if needed
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    }));

    // B7: Vendor add-ons pricing config (mock hardcoded admin-set values for now)
    const config = { freeAddonUnitLimit: 3, perUnitCharge: 2.50 };

    const formattedProducts = products.map(p => ({
      ...p, 
      image: p.images && p.images.length > 0 ? addCacheBuster(p.images[0].url) : null,
      price: p.basePrice ? Number(p.basePrice) : 0, 
      type: p.productType, 
      category: p.categories.length > 0 ? p.categories[0].name : 'Uncategorized',
      allCategories: p.categories.map(c => c.name),
      isAvailable: p.isActive, 
      addOns: (p.addOns || []).map(a => ({ 
        ...a, 
        price: a.price ? Number(a.price) : 0,
        freeLimit: a.freeLimit || 0
      })),
      isCustomizable: p.isCustomizable,
      customizationType: p.customizationType,
      customizationGroups: (p.customizationGroups || []).map(g => ({
        ...g,
        options: (g.options || []).map(o => ({
          ...o,
          priceModifier: Number(o.priceModifier || 0),
          allowQuantity: !!o.allowQuantity,
          freeLimit: o.freeLimit || 0,
          conflicts: o.conflicts || null,
          isAvailable: o.isAvailable !== false,
          displayOrder: o.displayOrder || 0
        }))
      }))
    }));

    res.json({ success: true, products: formattedProducts });
  } catch (error) {
    console.error('[VENDOR-PRODUCTS] Failed to fetch products error:', error);
    res.status(500).json({ error: 'Failed to fetch products', details: error.message });
  }
});

router.post('/products', firebaseAuth, requireKyc, async (req, res) => {
  try {
    const profile = req.profile; // reuse profile+vendor already loaded by requireKyc

    if (!profile || !profile.vendor) {
      return res.status(403).json({ error: 'Vendor profile not found or initialized' });
    }

    const { 
      name, description, category, type, price, isRestricted, isAvailable, 
      addOns, image, images,
      isCustomizable, customizationType, customizationGroups,
      templateId 
    } = req.body;

    // Resolve categories (IDs or Names)
    const categoryInputs = Array.isArray(category) ? category : [category].filter(Boolean);
    const resolvedCategoryIds = [];
    const isUuid = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

    for (const catInput of categoryInputs) {
      if (isUuid(catInput)) {
        resolvedCategoryIds.push(catInput);
      } else {
        // Try to find by name
        const cat = await resolveCategoryByName(catInput, profile.vendor.id);
        resolvedCategoryIds.push(cat.id);
      }
    }

    // Fetch the primary category name for the string field (for grouping in UI)
    const primaryCat = await prisma.category.findUnique({ where: { id: resolvedCategoryIds[0] } });
    const categoryName = primaryCat?.name || 'Uncategorized';

    // Structural changes (Add-ons, Customizations, Restricted, or NEW Type) require REVIEW.
    const STANDARD_TYPES = ['veg', 'non-veg', 'vegan', 'egg'];
    const typeClean = (type || '').toLowerCase().trim();
    const isNewType = typeClean && !STANDARD_TYPES.includes(typeClean);
    
    // Explicitly filter for non-empty addons/customizations
    const validAddons = (Array.isArray(addOns) ? addOns : []).filter(a => a && a.name && a.name.trim());
    const hasAddons = validAddons.length > 0;
    
    const validGroups = (Array.isArray(customizationGroups) ? customizationGroups : []).filter(g => g && g.name && g.name.trim() && Array.isArray(g.options) && g.options.length > 0);
    const hasCustomization = validGroups.length > 0;
    
    const isRestrictedActive = isRestricted === 'true' || isRestricted === true;
    
    console.log('[DEBUG-REVIEW] Evaluating POST /products:', {
      name,
      receivedType: type,
      typeClean,
      isNewType,
      hasAddons,
      hasCustomization,
      isRestrictedActive,
      receivedRestricted: isRestricted,
      receivedAddons: addOns,
      receivedGroups: customizationGroups
    });

    // --- START REVIEW EVALUATION ---
    // Pilot policy: EVERY new product requires admin approval before it goes live —
    // not just structurally-complex ones. It stays pending_review (and inactive) until
    // an admin approves it. The structural checks below only refine the displayed reason.
    let finalStatus = 'pending_review';
    let finalReason = 'New product — awaiting admin approval';

    if (hasAddons) {
      finalReason = 'Add-ons detected';
    } else if (hasCustomization) {
      finalReason = 'Customization groups/options detected';
    } else if (isRestrictedActive) {
      finalReason = 'Age restriction enabled';
    } else if (isNewType) {
      finalReason = `Custom product type: ${type}`;
    }

    console.log(`[VENDOR-API] Review Evaluation for "${name}":`, { 
      status: finalStatus, 
      reason: finalReason,
      isNewType,
      typeClean
    });
    // --- END SMART REVIEW EVALUATION ---

    const productPayload = {
      vendorId: profile.vendor.id, 
      name, 
      description, 
      productType: type, 
      basePrice: parseFloat(price) || 0,
      category: categoryName,
      isRestricted: isRestrictedActive,
      isActive: finalStatus === 'APPROVED' && (isAvailable === true || isAvailable === 'true'),
      reviewStatus: finalStatus,
      isCustomizable: isCustomizable === 'true' || isCustomizable === true,
      customizationType: customizationType || 'NORMAL',
      templateId: templateId || null,
      categories: {
        connect: resolvedCategoryIds.map(id => ({ id }))
      }
    };

    if (addOns && Array.isArray(addOns) && addOns.length > 0) {
      productPayload.addOns = { 
        create: addOns.map(addon => ({ 
          name: addon.name, 
          price: parseFloat(addon.price) || 0,
          freeLimit: parseInt(addon.freeLimit) || 0,
          isActive: true 
        })) 
      };
    }

    if (image || (images && images.length > 0)) {
      const imageList = (images ? images : [image]).map(url => stripCacheBuster(url));
      productPayload.images = {
        create: imageList.filter(img => !!img).map((url, index) => ({
          url,
          sortOrder: index
        }))
      };
    }

    if (customizationGroups && Array.isArray(customizationGroups)) {
      productPayload.customizationGroups = {
        create: customizationGroups.map((group, gIdx) => ({
          name: group.name,
          isRequired: group.isRequired === 'true' || group.isRequired === true,
          selectionType: group.selectionType || 'SINGLE',
          maxSelections: group.maxSelections ? parseInt(group.maxSelections) : null,
          displayOrder: group.displayOrder ?? gIdx,
          options: {
            create: (Array.isArray(group.options) ? group.options : []).map((opt, oIdx) => ({
              name: opt.name,
              priceModifier: parseFloat(opt.priceModifier) || 0,
              isAvailable: opt.isAvailable !== false,
              displayOrder: opt.displayOrder ?? oIdx,
              allowQuantity: !!opt.allowQuantity,
              freeLimit: parseInt(opt.freeLimit) || 0,
              conflicts: opt.conflicts || null,
              linkedProductId: opt.linkedProductId || null
            }))
          }
        }))
      };
    }

    console.log('[DEBUG] Saving Product with Payload:', JSON.stringify(productPayload, null, 2));
    const product = await prisma.product.create({ 
      data: productPayload, 
      include: { 
        addOns: true, 
        images: true,
        categories: true,
        customizationGroups: {
          include: { options: true }
        }
      } 
    });

    res.json({ 
      success: true, 
      product, 
      reviewReason: finalReason,
      debug: {
        hasAddons,
        hasCustomization,
        isRestrictedActive,
        isNewType,
        finalStatus,
        receivedType: type,
        typeClean
      }
    });
  } catch (error) {
    console.error('[VENDOR] Add Product error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    res.status(500).json({ error: 'Failed to add product', details: error.message });
  }
});


router.put('/products/:id', firebaseAuth, requireKyc, async (req, res) => {
    try {
      const { id } = req.params;
      console.log(`[VENDOR-API] PUT /products/${id} attempt...`);
      const { 
        name, description, category, type, isRestricted, isAvailable, price, 
        image, images, addOns,
        isCustomizable, customizationType, customizationGroups,
        templateId
      } = req.body;
      const profile = req.profile; // reuse profile+vendor already loaded by requireKyc
      
      const product = await prisma.product.findFirst({ where: { id, vendorId: profile.vendor.id } });
      if (!product) return res.status(404).json({ error: 'Product not found' });

      // Build update data with correct mapping
      const updateData = {};
      if (name !== undefined) updateData.name = name;
      if (description !== undefined) updateData.description = description;
      // Resolve categories if provided
      if (category !== undefined) {
        const categoryInputs = Array.isArray(category) ? category : [category].filter(Boolean);
        const resolvedCategoryIds = [];
        const isUuid = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

        for (const catInput of categoryInputs) {
          if (isUuid(catInput)) {
            resolvedCategoryIds.push(catInput);
          } else {
            const cat = await resolveCategoryByName(catInput, profile.vendor.id);
            resolvedCategoryIds.push(cat.id);
          }
        }
        updateData.category = resolvedCategoryIds[0] || 'Uncategorized';
        updateData.categories = {
          set: resolvedCategoryIds.map(id => ({ id }))
        };
      }
  
      if (type !== undefined) updateData.productType = type;
      if (isRestricted !== undefined) updateData.isRestricted = isRestricted === 'true' || isRestricted === true;
      if (isAvailable !== undefined) updateData.isActive = isAvailable === 'true' || isAvailable === true;
      if (price !== undefined) updateData.basePrice = parseFloat(price) || 0;
      if (isCustomizable !== undefined) updateData.isCustomizable = isCustomizable === 'true' || isCustomizable === true;
      if (customizationType !== undefined) updateData.customizationType = customizationType;
      if (templateId !== undefined) updateData.templateId = templateId || null;
  
      // Check for Review-Triggering Changes
      // User allows updates to: Name, Price, Existing Categories, Description
      // Review is triggered by: NEW addons, NEW customization options/groups, NEW product type
      let reviewTriggered = false;

      // 1. Fetch original product with relations for comparison
      const originalProduct = await prisma.product.findUnique({
        where: { id },
        include: { addOns: true, customizationGroups: { include: { options: true } } }
      });

      // 2. Check for new add-ons
      if (addOns !== undefined) {
        const existingAddonNames = new Set(originalProduct.addOns.map(a => a.name.toLowerCase()));
        const hasNewAddon = (Array.isArray(addOns) ? addOns : []).some(a => !existingAddonNames.has(a.name.toLowerCase()));
        if (hasNewAddon) reviewTriggered = true;
      }

      // 3. Check for structural customization changes
      if (customizationGroups !== undefined && !reviewTriggered) {
        const existingGroupNames = new Set(originalProduct.customizationGroups.map(g => g.name.toLowerCase()));
        const incomingGroups = Array.isArray(customizationGroups) ? customizationGroups : [];
        
        if (incomingGroups.length > originalProduct.customizationGroups.length) {
          reviewTriggered = true;
        } else {
          for (const group of incomingGroups) {
            if (!existingGroupNames.has(group.name.toLowerCase())) {
              reviewTriggered = true;
              break;
            }
            // Check for new options within existing group
            const oldGroup = originalProduct.customizationGroups.find(g => g.name.toLowerCase() === group.name.toLowerCase());
            if (oldGroup) {
              const existingOptionNames = new Set(oldGroup.options.map(o => o.name.toLowerCase()));
              const hasNewOption = (Array.isArray(group.options) ? group.options : []).some(o => !existingOptionNames.has(o.name.toLowerCase()));
              if (hasNewOption) {
                reviewTriggered = true;
                break;
              }
            }
          }
        }
      }

      // 4. Check for type change (Case-insensitive)
      // Standard types are instant. ONLY NEW/CUSTOM types trigger review.
      const STANDARD_TYPES = ['veg', 'non-veg', 'vegan', 'egg'];
      const isCurrentlyStandard = STANDARD_TYPES.includes((originalProduct.productType || '').toLowerCase());
      const isNewTypeSelected = type && !STANDARD_TYPES.includes(type.toLowerCase());
      const isTypeChanged = type && (type || '').toLowerCase() !== (originalProduct.productType || '').toLowerCase();

      if (isTypeChanged && isNewTypeSelected) {
        console.log(`[VENDOR-API] NEW Type change detected: ${originalProduct.productType} -> ${type}. Triggering review.`);
        reviewTriggered = true;
      } else if (isTypeChanged) {
        console.log(`[VENDOR-API] Basic Type change (Standard): ${originalProduct.productType} -> ${type}. Instant approval.`);
      }

      // 5. Check for Restricted toggle
      if (isRestricted === true && originalProduct.isRestricted !== true) {
        console.log(`[VENDOR-API] Age Restricted enabled. Triggering review.`);
        reviewTriggered = true;
      }

      if (reviewTriggered) {
        console.log(`[VENDOR-API] Product update for "${originalProduct.name}" (${id}) requires review. Status: pending_review`);
        updateData.reviewStatus = 'pending_review';
        updateData.isActive = false; // Force hide from customer view
      } else {
        console.log(`[VENDOR-API] Product update for "${originalProduct.name}" (${id}) approved instantly (basic info/standard type change).`);
      }

      // Use a transaction to ensure updates are atomic
      const updatedProduct = await prisma.$transaction(async (tx) => {
        // Prepare nested updates for the main product update call
        const nestedData = { ...updateData };

        // 1. Handle Images
        if (image !== undefined || images !== undefined) {
          const imageList = (images ? images : (image ? [image] : [])).map(url => stripCacheBuster(url));
          nestedData.images = {
            deleteMany: {},
            create: imageList.filter(img => !!img).map((url, index) => ({
              url,
              sortOrder: index
            }))
          };
        }

        // 2. Handle Add-ons
        if (addOns !== undefined) {
          nestedData.addOns = {
            deleteMany: {},
            create: (Array.isArray(addOns) ? addOns : []).map(a => ({
              name: a.name,
              price: parseFloat(a.price) || 0,
              freeLimit: parseInt(a.freeLimit) || 0,
              isActive: true
            }))
          };
        }

        // 3. Handle Customization Groups
        if (customizationGroups !== undefined) {
          nestedData.customizationGroups = {
            deleteMany: {},
            create: (Array.isArray(customizationGroups) ? customizationGroups : []).map((group, gIdx) => ({
              name: group.name,
              isRequired: group.isRequired === 'true' || group.isRequired === true,
              selectionType: group.selectionType || 'SINGLE',
              maxSelections: group.maxSelections ? parseInt(group.maxSelections) : null,
              displayOrder: group.displayOrder ?? gIdx,
              options: {
                create: (Array.isArray(group.options) ? group.options : []).map((opt, oIdx) => ({
                  name: opt.name,
                  priceModifier: parseFloat(opt.priceModifier) || 0,
                  isAvailable: opt.isAvailable !== false,
                  displayOrder: opt.displayOrder ?? oIdx,
                  allowQuantity: !!opt.allowQuantity,
                  freeLimit: parseInt(opt.freeLimit) || 0,
                  conflicts: opt.conflicts || null,
                  linkedProductId: opt.linkedProductId || null
                }))
              }
            }))
          };
        }

        // Final Atomic Update
        return await tx.product.update({
          where: { id },
          data: nestedData,
          include: { 
            addOns: true, 
            images: true,
            categories: true,
            customizationGroups: {
              include: { options: true }
            }
          }
        });
      }, {
        timeout: 20000 // Increase timeout to 20 seconds for complex BYO updates
      });

      res.json({ 
        success: true, 
        reviewTriggered,
        product: {
          ...updatedProduct,
          image: updatedProduct.images && updatedProduct.images.length > 0 ? addCacheBuster(updatedProduct.images[0].url) : null,
          price: Number(updatedProduct.basePrice || 0),
          type: updatedProduct.productType,
          isAvailable: updatedProduct.isActive,
          addOns: (updatedProduct.addOns || []).map(a => ({ 
            ...a, 
            price: Number(a.price || 0),
            freeLimit: a.freeLimit || 0
          })),
          isCustomizable: updatedProduct.isCustomizable,
          customizationType: updatedProduct.customizationType,
          customizationGroups: (updatedProduct.customizationGroups || []).map(g => ({
            ...g,
            options: (g.options || []).map(o => ({
              ...o,
              priceModifier: Number(o.priceModifier || 0),
              allowQuantity: !!o.allowQuantity,
              freeLimit: o.freeLimit || 0,
              conflicts: o.conflicts || null,
              isAvailable: o.isAvailable !== false,
              displayOrder: o.displayOrder || 0
            }))
          }))
        }
      });
    } catch (error) {
      console.error('[VENDOR] Update Product error:', error);
      if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
      res.status(500).json({ error: 'Failed to update product', details: error.message });
    }
});

// DEV ONLY: Admin approval simulation
// DEV-ONLY guard. Both endpoints below let the CALLER name any vendor/product id and
// flip its approval state, with no ownership and no admin check — mounted unconditionally
// they let any logged-in user approve any vendor and bypass KYC review entirely. Gated on
// the existing DEV_BYPASS flag, which lib/checkEnv.js refuses to boot with in production.
const devOnly = (req, res, next) => {
  if (process.env.DEV_BYPASS !== 'on') return res.status(404).json({ error: 'Not found' });
  next();
};

router.put('/products/:id/approve-dev', devOnly, firebaseAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // approved, rejected, etc.
    const { emitProductStatusUpdate } = require('../lib/socket');

    const product = await prisma.product.update({
      where: { id },
      data: { reviewStatus: status || 'APPROVED' }
    });

    emitProductStatusUpdate(product.vendorId, id, status || 'APPROVED');
    res.json({ success: true, product });
  } catch (error) {
    res.status(500).json({ error: 'Dev approval failed', details: error.message });
  }
});


// DEV ONLY: Admin approval simulation for vendor account
router.put('/admin-simulate/approve-vendor/:id', devOnly, firebaseAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // approved, rejected, suspended, etc.
    const { emitAccountStatusUpdate } = require('../lib/socket');

    const vendorData = await prisma.vendor.findUnique({ where: { id } });
    if (!vendorData) return res.status(404).json({ error: 'Vendor not found' });

    // No Shadowfax store registration — HL Marketplace has no per-vendor store code.
    const vendor = await prisma.vendor.update({
      where: { id },
      data: { accountStatus: status || 'APPROVED' }
    });

    // Also update Profile status for consistency
    if (vendor.profileId) {
      await prisma.profile.update({
        where: { id: vendor.profileId },
        data: { profileStatus: (status || 'APPROVED').toUpperCase() }
      });
    }

    emitAccountStatusUpdate(vendor.id, status || 'APPROVED');

    // Trigger push notification to vendor for KYC status updates (Approved/Rejected)
    try {
      const fcm = require('../lib/fcm');
      const currentStatus = (status || 'APPROVED').toUpperCase();
      const isApproved = currentStatus === 'APPROVED' || currentStatus === 'ACTIVE';
      const isRejected = currentStatus === 'REJECTED' || currentStatus === 'DISABLED';
      
      if (isApproved || isRejected) {
        await fcm.sendToVendor(vendor.id, {
          title: isApproved ? 'KYC Approved' : 'KYC Rejected',
          body: isApproved 
            ? 'Your store registration has been approved. You are now ready to receive orders!' 
            : 'Your KYC documents could not be verified. Please review and re-submit your documents.',
          type: 'KYC_STATUS_UPDATE',
        });
        console.log(`[FCM] KYC status change notification sent to vendor ${vendor.id} (${currentStatus})`);
      }
    } catch (fcmErr) {
      console.warn('[FCM] Failed to send KYC push notification:', fcmErr.message);
    }

    res.json({ success: true, vendor });
  } catch (error) {
    res.status(500).json({ error: 'Dev approval failed', details: error.message });
  }
});


router.delete('/products/:id', firebaseAuth, requireKyc, async (req, res) => {
  try {
    const profile = req.profile; // reuse profile+vendor already loaded by requireKyc
    await prisma.product.deleteMany({ where: { id: req.params.id, vendorId: profile.vendor.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// ==========================================
// MODULE B8: Earnings
// ==========================================
router.get('/earnings', firebaseAuth, requireKyc, async (req, res) => {
  try {
    const { period } = req.query; // daily, weekly, monthly
    const profile = req.profile; // reuse profile+vendor already loaded by requireKyc
    
    // 1. Overall Aggregates
    const earnings = await prisma.vendorEarning.aggregate({
      _sum: { orderTotal: true, commissionAmt: true, vendorPayout: true },
      _count: { orderId: true },
      where: { vendorId: profile.vendor.id }
    });

    // 2. Trend Data (Grouped by Date)
    // We'll fetch last 7 days or all depending on period
    const earningsList = await prisma.vendorEarning.findMany({
      where: { vendorId: profile.vendor.id },
      orderBy: { earnedAt: 'asc' },
      take: 30 // Get last 30 entries for breakdown
    });

    // Group by date for chart (simple implementation)
    const groupedData = {};
    earningsList.forEach(e => {
      const dateObj = e.earnedAt ? new Date(e.earnedAt) : new Date();
      const date = dateObj.toISOString().split('T')[0];
      if (!groupedData[date]) {
        groupedData[date] = { gross: 0, net: 0, count: 0 };
      }
      groupedData[date].gross += Number(e.orderTotal || 0);
      groupedData[date].net += Number(e.vendorPayout || 0);
      groupedData[date].count += 1;
    });

    const sortedDates = Object.keys(groupedData).sort();
    const chartLabels = sortedDates.slice(-7).map(d => d.split('-').slice(1).join('/')); // MM/DD
    const chartPoints = sortedDates.slice(-7).map(d => groupedData[d].gross);

    const breakdown = sortedDates.reverse().map(date => ({
      date,
      count: groupedData[date].count,
      gross: groupedData[date].gross,
      net: groupedData[date].net
    }));

    res.json({
      success: true,
      revenue: parseFloat(earnings._sum.orderTotal || 0),
      commission: parseFloat(earnings._sum.commissionAmt || 0),
      net: parseFloat(earnings._sum.vendorPayout || 0),
      orderCount: earnings._count.orderId || 0,
      chartData: { 
        labels: chartLabels.length > 0 ? chartLabels : ['-'], 
        datasets: [{ data: chartPoints.length > 0 ? chartPoints : [0] }] 
      },
      breakdown: breakdown
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

// ==========================================
// MODULE B9: Storage & Uploads
// ==========================================
router.post('/storage/upload-url', firebaseAuth, async (req, res) => {
  try {
    const { fileName, contentType } = req.body;
    if (!fileName || !contentType) return res.status(400).json({ error: 'fileName and contentType required' });

    const data = await getPresignedUploadUrl(fileName, contentType);
    res.json({ success: true, ...data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// Update display order of customization groups
router.put('/products/:id/customization/sort', firebaseAuth, requireKyc, async (req, res) => {
  try {
    const { id } = req.params;
    const { groupOrders } = req.body; // Array of { id, displayOrder }
    
    if (!Array.isArray(groupOrders)) return res.status(400).json({ error: 'groupOrders must be an array' });

    await prisma.$transaction(
      groupOrders.map(item => 
        prisma.customizationGroup.update({
          where: { id: item.id, productId: id },
          data: { displayOrder: item.displayOrder }
        })
      )
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update sort order' });
  }
});

// GET /reviews — list all feedback for this vendor
router.get('/reviews', firebaseAuth, async (req, res) => {
  try {
    const { uid } = req.user;
    const profile = await withRetry(() => prisma.profile.findUnique({
      where: { firebaseUid: uid },
      include: { vendor: true }
    }));

    if (!profile?.vendor) return res.status(404).json({ error: 'Vendor not found' });

    // DIAGNOSTIC: Log available models to identify if 'feedback' is missing or renamed
    console.log('[VENDOR] Available Models:', Object.keys(prisma).filter(k => !k.startsWith('_') && !k.startsWith('$')));

    console.log(`[VENDOR] Fetching reviews for vendor: ${profile.vendor.id}`);

    const reviews = await withRetry(() => prisma.feedback.findMany({
      where: { 
        order: { vendorId: profile.vendor.id }
      },
      include: {
        customer: {
          select: { fullName: true }
        },
        order: {
          select: { id: true, createdAt: true }
        }
      },
      orderBy: { submittedAt: 'desc' }
    }));

    res.json({ success: true, reviews });
  } catch (error) {
    console.error('[VENDOR] Reviews Error:', error.message || error);
    res.status(500).json({ error: 'Failed to fetch reviews', details: error.message });
  }
});

module.exports = router;
