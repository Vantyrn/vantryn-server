/**
 * Canonical order-status sets. Single source — these lists were previously copy-pasted into
 * routes/vendor.js, services/orderService.js and lib/vendorStatusHelper.js, and every copy
 * omitted the Shadowfax delivery statuses. Consequence: the moment Shadowfax sent ALLOTTED
 * (→ RIDER_ASSIGNED) the order vanished from the vendor's active list and the vendor was
 * auto-flipped OFFLINE while a delivery was still in flight.
 */

// Set by the vendor / customer before the parcel leaves the store.
const VENDOR_ACTIVE_STATUSES = [
  'pending_vendor',
  'pending_vendor_response',
  'accepted',
  'preparing',
  'ready_for_pickup',
];

// Set by Shadowfax callbacks (or the simulator). The order is still in flight.
const DELIVERY_ACTIVE_STATUSES = [
  'RIDER_ASSIGNED',
  'RIDER_AT_STORE',
  'RIDER_UNASSIGNED',
  'picked_up',
  'arrived_at_customer',
  'RETURN_TO_STORE_IN_PROGRESS',
];

const ACTIVE_ORDER_STATUSES = [...VENDOR_ACTIVE_STATUSES, ...DELIVERY_ACTIVE_STATUSES];

// Nothing more will happen to the order.
const TERMINAL_ORDER_STATUSES = [
  'delivered',
  'delivery_failed',
  'cancelled',
  'cancelled_by_vendor',
  'order_cancelled',
  'RETURNED_TO_SELLER',
];

// Membership tests MUST be case-insensitive. The same states are written in two casings
// depending on which path got there: the vendor/customer flows write lowercase
// ('cancelled_by_vendor'), while the system paths write UPPER_SNAKE — services/orderService.js
// and routes/vendor.js both write 'CANCELLED', and the SLA cleanup produced an order whose
// status is literally 'CANCELLED'. A lowercase-only .includes() silently reported that order
// as non-terminal, which is how a cancelled order still offered "Food Ready" to its customer.
const norm = (s) => String(s ?? '').toLowerCase();
const isActiveStatus = (s) => ACTIVE_ORDER_STATUSES.some((t) => norm(t) === norm(s));
const isTerminalStatus = (s) => TERMINAL_ORDER_STATUSES.some((t) => norm(t) === norm(s));

/**
 * A customer may cancel only while the rider does not yet have the parcel. Shadowfax charges
 * 100% of the delivery fee for a post-pickup cancellation, so this is a money guard.
 */
const CANCELLABLE_STATUSES = [
  ...VENDOR_ACTIVE_STATUSES,
  'payment_successful', // Order.status default before the vendor is notified
  'RIDER_ASSIGNED',
  'RIDER_AT_STORE',
  'RIDER_UNASSIGNED',
];

const isCancellableStatus = (s) => CANCELLABLE_STATUSES.includes(s);

module.exports = {
  isTerminalStatus,
  VENDOR_ACTIVE_STATUSES,
  DELIVERY_ACTIVE_STATUSES,
  ACTIVE_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  CANCELLABLE_STATUSES,
  isActiveStatus,
  isCancellableStatus,
};
