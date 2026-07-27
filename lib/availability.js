const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const toMins = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};

// "09:00" → "9:00 AM". Vendors enter 24h, customers read 12h.
const fmt = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m || 0).padStart(2, '0')} ${suffix}`;
};

const hasHours = (d) => !!(d && !d.isClosed && d.open && d.close);

/**
 * Is the store within its operating hours right now?
 *
 * @param {Object} operatingHours { Monday: { isClosed, open: "09:00", close: "22:00" }, … }
 * @param {Date}   now           injectable for tests
 * @returns {{ isOpen: boolean, nextOpen: string|null }} nextOpen reads like
 *          "today at 9:00 AM" / "tomorrow at 9:00 AM" / "on Friday at 9:00 AM".
 */
function checkVendorAvailability(operatingHours, now = new Date()) {
  if (!operatingHours || typeof operatingHours !== 'object') return { isOpen: true, nextOpen: null };

  try {
    // Read the wall clock in IST whatever the server TZ is (Railway runs UTC): with UTC
    // getters a 9am–10pm store reads as closed until 2:30pm IST. Shift, then use the UTC
    // getters on the shifted instant so the result never depends on process.env.TZ.
    const ist = new Date(now.getTime() + 330 * 60 * 1000);
    const dayIdx = ist.getUTCDay();
    const nowMins = ist.getUTCHours() * 60 + ist.getUTCMinutes();

    // Yesterday's overnight window (22:00–02:00) may still be running right now.
    const yesterday = operatingHours[DAYS[(dayIdx + 6) % 7]];
    if (hasHours(yesterday) && toMins(yesterday.close) < toMins(yesterday.open)
        && nowMins <= toMins(yesterday.close)) {
      return { isOpen: true, nextOpen: null };
    }

    const today = operatingHours[DAYS[dayIdx]];
    if (hasHours(today)) {
      const open = toMins(today.open);
      const close = toMins(today.close);
      // Overnight (close < open) runs to midnight today; the tail is handled above.
      const isOpen = close < open ? nowMins >= open : nowMins >= open && nowMins <= close;
      if (isOpen) return { isOpen: true, nextOpen: null };
      // Before opening → it reopens later today. Past closing → fall through to the
      // next day that has hours. Saying "today at 9:00 AM" at 11pm was the bug: it
      // pointed at a time that had already passed.
      if (nowMins < open) return { isOpen: false, nextOpen: `today at ${fmt(today.open)}` };
    }

    return { isOpen: false, nextOpen: nextOpenMessage(operatingHours, dayIdx) };
  } catch (err) {
    console.error('[AVAILABILITY-LIB] Error:', err.message);
    return { isOpen: true, nextOpen: null }; // err on the side of letting them sell
  }
}

/** First day after `fromDayIdx` that has hours: "tomorrow at 9:00 AM" / "on Friday at …". */
function nextOpenMessage(operatingHours, fromDayIdx) {
  for (let i = 1; i <= 7; i++) {
    const idx = (fromDayIdx + i) % 7;
    const day = operatingHours[DAYS[idx]];
    if (hasHours(day)) {
      return `${i === 1 ? 'tomorrow' : `on ${DAYS[idx]}`} at ${fmt(day.open)}`;
    }
  }
  return 'soon';
}

module.exports = { checkVendorAvailability };
