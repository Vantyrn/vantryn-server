// Vendor reachability — is an "online" vendor actually there to take the order?
//
// onlineStatus alone lies: a vendor who was online and then killed the app stays
// 'online' forever (we can't run JS in a dead app to flip it), so orders were routed to
// a store nobody was watching and just sat until the SLA breach. Auto-offline on socket
// disconnect was tried and abandoned because a backgrounded-but-alive app looks identical
// to a killed one at the socket layer (see lib/socket.js).
//
// The fix is a heartbeat: the vendor app already polls GET /vendor/profile every ~15s
// while its JS is alive (foreground, and backgrounded while the Android bubble foreground
// service keeps the process up). Each poll stamps bubbleLastSeenAt. A vendor is REACHABLE
// only if they are online AND that stamp is recent. A killed app stops polling, goes
// stale within STALE_MS, and is treated as offline.
//
// ponytail: threshold is 6× the client's 15s poll — generous enough to ride out a
// background throttle hiccup, tight enough to catch a killed app in ~90s. If the poll
// interval changes, change this. Upgrade path if the poll proves unreliable: a dedicated
// POST /vendor/heartbeat on its own timer.
const VENDOR_STALE_MS = 90 * 1000;

const isFresh = (lastSeen) =>
  !!lastSeen && Date.now() - new Date(lastSeen).getTime() <= VENDOR_STALE_MS;

// Reachable = the store says it's open AND we have proof its app is alive.
//
// Proof is EITHER a recent HTTP heartbeat OR a live socket. The heartbeat alone was
// not enough: it is a JS setInterval in the vendor app, and Android suspends JS timers
// while the app is backgrounded — which is precisely when the floating bubble is up.
// A vendor who backgrounded the app with the bubble showing (the state that means
// "online and available") stopped stamping bubbleLastSeenAt, went stale in 90s and was
// auto-flipped offline on the next order, with the bubble still on their screen.
// The socket survives backgrounding, so it covers exactly that gap.
const isVendorReachable = (vendor) => {
  if (!vendor || vendor.onlineStatus !== 'online') return false;
  if (isFresh(vendor.bubbleLastSeenAt)) return true;
  // Lazy require: lib/socket pulls in prisma/fcm, and this module is imported from
  // request paths that must not care about socket wiring.
  try {
    return require('./socket').isVendorSocketOnline(vendor.id);
  } catch (_) {
    return false;
  }
};

module.exports = { VENDOR_STALE_MS, isFresh, isVendorReachable };
