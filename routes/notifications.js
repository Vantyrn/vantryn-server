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

// GET /api/notifications?limit=50 — newest first, plus the unread count for the badge.
router.get('/', firebaseAuth, async (req, res) => {
  try {
    const profileId = await callerProfileId(req);
    if (!profileId) return res.json({ success: true, notifications: [], unreadCount: 0 });

    // Cap the page size: an inbox is a recent-activity list, not an archive, and an
    // unbounded query here is a trivial way to hurt the database.
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

    const [notifications, unreadCount] = await Promise.all([
      prisma.notificationLog.findMany({
        where: { userId: profileId },
        orderBy: { sentAt: 'desc' },
        take: limit,
      }),
      prisma.notificationLog.count({ where: { userId: profileId, status: 'sent' } }),
    ]);

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

// POST /api/notifications/read — mark one ({ id }) or all ({} ) as read.
router.post('/read', firebaseAuth, async (req, res) => {
  try {
    const profileId = await callerProfileId(req);
    if (!profileId) return res.status(404).json({ error: 'Profile not found' });

    const { id } = req.body || {};
    // userId is always in the where clause — without it, passing someone else's
    // notification id would let a caller mark another user's mail as read.
    await prisma.notificationLog.updateMany({
      where: id ? { id, userId: profileId } : { userId: profileId, status: 'sent' },
      data: { status: 'read' },
    });

    const unreadCount = await prisma.notificationLog.count({
      where: { userId: profileId, status: 'sent' },
    });
    res.json({ success: true, unreadCount });
  } catch (err) {
    console.error('[NOTIFICATIONS] mark-read error:', err.message);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

module.exports = router;
