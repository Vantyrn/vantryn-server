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

// Reachable = the store says it's open AND its app has checked in recently.
const isVendorReachable = (vendor) =>
  !!vendor && vendor.onlineStatus === 'online' && isFresh(vendor.bubbleLastSeenAt);

module.exports = { VENDOR_STALE_MS, isFresh, isVendorReachable };
