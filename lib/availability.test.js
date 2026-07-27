// node lib/availability.test.js — no framework, throws on the first bad case.
const assert = require('assert');
const { checkVendorAvailability } = require('./availability');

// 2026-07-27 is a Monday. Times are IST wall clock (the lib is India-only), built as
// absolute instants so the result is the same on a UTC server and an IST laptop.
const at = (dayOffset, h, m = 0) =>
  new Date(Date.UTC(2026, 6, 27 + dayOffset, h, m) - 330 * 60 * 1000);

const nineToTen = { open: '09:00', close: '22:00' };
const weekdays = {
  Monday: nineToTen, Tuesday: nineToTen, Wednesday: nineToTen,
  Thursday: nineToTen, Friday: nineToTen,
  Saturday: { isClosed: true }, Sunday: { isClosed: true },
};

// Inside the window.
assert.deepStrictEqual(checkVendorAvailability(weekdays, at(0, 13)), { isOpen: true, nextOpen: null });

// Before opening → later today, 12h clock.
assert.deepStrictEqual(
  checkVendorAvailability(weekdays, at(0, 7)),
  { isOpen: false, nextOpen: 'today at 9:00 AM' }
);

// After closing → tomorrow, NOT "today at 9:00" (the bug this file exists for).
assert.deepStrictEqual(
  checkVendorAvailability(weekdays, at(0, 23)),
  { isOpen: false, nextOpen: 'tomorrow at 9:00 AM' }
);

// Friday night → skips the closed weekend to Monday.
assert.deepStrictEqual(
  checkVendorAvailability(weekdays, at(4, 23)),
  { isOpen: false, nextOpen: 'on Monday at 9:00 AM' }
);

// Closed all day → next open day, not "today".
assert.deepStrictEqual(
  checkVendorAvailability(weekdays, at(5, 12)),
  { isOpen: false, nextOpen: 'on Monday at 9:00 AM' }
);

// Overnight window 22:00–02:00: open at 23:00 today AND at 01:00 tomorrow.
const overnight = { ...weekdays, Monday: { open: '22:00', close: '02:00' }, Tuesday: { open: '22:00', close: '02:00' } };
assert.strictEqual(checkVendorAvailability(overnight, at(0, 23)).isOpen, true);
assert.strictEqual(checkVendorAvailability(overnight, at(1, 1)).isOpen, true);
assert.strictEqual(checkVendorAvailability(overnight, at(1, 12)).isOpen, false);

// No hours configured → sell.
assert.deepStrictEqual(checkVendorAvailability(null, at(0, 3)), { isOpen: true, nextOpen: null });

console.log('availability: all cases pass');
