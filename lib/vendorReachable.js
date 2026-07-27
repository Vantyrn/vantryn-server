// Is a vendor available to take orders?
//
// The answer is simply: did they say they are online?
//
// This used to also require "proof of life" — a heartbeat stamp (bubbleLastSeenAt)
// no older than 90s, or a live socket. Both proofs die together in the one state that
// actually means "open for business": the vendor app backgrounded with the floating
// bubble up. Android freezes the JS runtime there, so the 15s poll stops AND the socket
// drops on ping timeout ~40s later. After that the same vendor read as 'online' in
// Admin (raw column) but 'offline' in the customer app (this predicate), and the store
// page showed CLOSED with the bubble still on the vendor's screen.
//
// The proof was never needed anyway: a new order reaches the vendor by FCM, which works
// on a frozen — and even a swiped-away — app. If they genuinely aren't there, the order
// sits and the 5-minute acceptance SLA (lib/bullmq.js) flags it for admin. That is the
// real safety net; a 90-second timer was just closing live stores.
//
// A vendor goes offline when they say so: the toggle/bubble (POST /vendor/status),
// logout, or an admin action. Same rule everywhere — Admin, browse list, store page and
// order placement now agree, which is the whole point of it living in one file.
const isVendorReachable = (vendor) => vendor?.onlineStatus === 'online';

module.exports = { isVendorReachable };
