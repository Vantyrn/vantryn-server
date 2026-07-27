const express = require('express');
const router = express.Router();
const firebaseAuth = require('../middleware/auth');
const { prisma } = require('../lib/prisma');

/**
 * Notification inbox — shared by BOTH apps.
 *
 * Deliberately role-agnostic: rows are keyed by Profile.id, which every signed-in
 * user has regardless of role, so one set of endpoints serves the vendor and the
 * customer app. Everything is scoped to the caller's own profile; there is no way
 * to read or mutate someone else's notifications.
 */

/** Resolve the caller's profile id from the verified Firebase token. */
async function callerProfileId(req) {
  const profile = await prisma.profile.findUnique({
    where: { firebaseUid: req.user.uid },
    select: { id: true },
  });
  return profile?.id || null;
}

/**
 * Which role's inbox is being asked for.
 *
 * REQUIRED for correctness, not a nicety: one phone using the same number for both
 * apps resolves to ONE Profile, and notification_logs is keyed by profile id. Without
 * this filter each app listed the other's notifications — a vendor saw "Out for
 * delivery" and "Order delivered" for orders they were fulfilling, twice over.
 * Rows are already scoped to the caller's own profile, so this only narrows what they
 * can already see; it is a filter, not an authorisation boundary.
 */
function callerRole(req) {
  const raw = String(req.query.role || req.body?.role || '').toUpperCase();
  return raw === 'VENDOR' || raw === 'CUSTOMER' ? raw : null;
}

// GET /api/notifications?limit=50 — newest first, plus the unread count for the badge.
router.get('/', firebaseAuth, async (req, res) => {
  try {
    const profileId = await callerProfileId(req);
    if (!profileId) return res.json({ success: true, notifications: [], unreadCount: 0 });

    // Cap the page size: an inbox is a recent-activity list, not an archive, and an
    // unbounded query here is a trivial way to hurt the database.
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

    // No role given (older app build) -> everything, i.e. the previous behaviour.
    const role = callerRole(req);
    const scope = role ? { userId: profileId, role } : { userId: profileId };

    const [notifications, unreadCount] = await Promise.all([
      prisma.notificationLog.findMany({
        where: scope,
        orderBy: { sentAt: 'desc' },
        take: limit,
      }),
      prisma.notificationLog.count({ where: { ...scope, status: 'sent' } }),
    ]);

    pruneOld(profileId);

    res.json({
      success: true,
      unreadCount,
      notifications: notifications.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        type: n.type,
        data: n.data || {},
        read: n.status === 'read',
        sentAt: n.sentAt,
      })),
    });
  } catch (err) {
    console.error('[NOTIFICATIONS] list error:', err.message);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// Rows are per-user activity, not an archive: without a retention rule the table
// grows forever and the inbox slows down for the heaviest users first.
const RETENTION_DAYS = 30;

/** Fire-and-forget prune of this user's old notifications. Never blocks a response. */
function pruneOld(userId) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  prisma.notificationLog
    .deleteMany({ where: { userId, sentAt: { lt: cutoff } } })
    .catch((e) => console.warn('[NOTIFICATIONS] prune failed:', e.message));
}

// DELETE /api/notifications        — clear this role's inbox
// DELETE /api/notifications?scope=read — clear only the ones already read
router.delete('/', firebaseAuth, async (req, res) => {
  try {
    const profileId = await callerProfileId(req);
    if (!profileId) return res.status(404).json({ error: 'Profile not found' });

    const role = callerRole(req);
    const scope = role ? { userId: profileId, role } : { userId: profileId };
    const readOnly = String(req.query.scope || '').toLowerCase() === 'read';

    const { count } = await prisma.notificationLog.deleteMany({
      where: readOnly ? { ...scope, status: 'read' } : scope,
    });

    const unreadCount = await prisma.notificationLog.count({
      where: { ...scope, status: 'sent' },
    });
    res.json({ success: true, deleted: count, unreadCount });
  } catch (err) {
    console.error('[NOTIFICATIONS] clear error:', err.message);
    res.status(500).json({ error: 'Failed to clear notifications' });
  }
});

// POST /api/notifications/read — mark one ({ id }) or all ({} ) as read.
router.post('/read', firebaseAuth, async (req, res) => {
  try {
    const profileId = await callerProfileId(req);
    if (!profileId) return res.status(404).json({ error: 'Profile not found' });

    const { id } = req.body || {};
    const role = callerRole(req);
    const scope = role ? { userId: profileId, role } : { userId: profileId };

    // userId is always in the where clause — without it, passing someone else's
    // notification id would let a caller mark another user's mail as read. The role
    // keeps "mark all read" in one app from clearing the other app's badge.
    await prisma.notificationLog.updateMany({
      where: id ? { ...scope, id } : { ...scope, status: 'sent' },
      data: { status: 'read' },
    });

    const unreadCount = await prisma.notificationLog.count({
      where: { ...scope, status: 'sent' },
    });
    res.json({ success: true, unreadCount });
  } catch (err) {
    console.error('[NOTIFICATIONS] mark-read error:', err.message);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

module.exports = router;
