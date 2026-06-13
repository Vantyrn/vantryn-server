const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Checks if current time is within vendor's operating hours
 * @param {Object} operatingHours JSON: { Monday: { isClosed, open: "09:00", close: "22:00" }, ... }
 * @returns {Object} { isOpen: boolean, nextOpen: string|null }
 */
function checkVendorAvailability(operatingHours) {
  if (!operatingHours) return { isOpen: true, nextOpen: null };

  try {
    const now = new Date();
    // UTC to IST Offset if needed, but assuming server time is correct or handled
    const dayName = days[now.getDay()];
    const todayHours = operatingHours[dayName];

    // 1. Is Closed Today?
    if (!todayHours || todayHours.isClosed) {
      return { isOpen: false, nextOpen: getNextOpenMessage(operatingHours) };
    }

    // 2. Is within Time Window?
    const [openH, openM] = todayHours.open.split(':').map(Number);
    const [closeH, closeM] = todayHours.close.split(':').map(Number);
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const openMins = openH * 60 + openM;
    const closeMins = closeH * 60 + closeM;

    // Handle overnight shifts (e.g., 22:00 – 02:00)
    let isOpen = false;
    if (closeMins < openMins) {
      isOpen = currentMins >= openMins || currentMins <= closeMins;
    } else {
      isOpen = currentMins >= openMins && currentMins <= closeMins;
    }

    return { 
      isOpen, 
      nextOpen: isOpen ? null : `today at ${todayHours.open}` 
    };
  } catch (err) {
    console.error('[AVAILABILITY-LIB] Error:', err.message);
    return { isOpen: true, nextOpen: null }; // Err on side of cautious sales
  }
}

/**
 * Find the next available opening slot
 */
function getNextOpenMessage(operatingHours) {
  if (!operatingHours) return 'soon';
  try {
    const now = new Date();
    const currentDayIdx = now.getDay();

    // Check next 7 days
    for (let i = 1; i <= 7; i++) {
        const nextDayIdx = (currentDayIdx + i) % 7;
        const dayName = days[nextDayIdx];
        const dayData = operatingHours[dayName];
        
        if (dayData && !dayData.isClosed && dayData.open) {
            const dayText = i === 1 ? 'tomorrow' : `on ${dayName}`;
            return `${dayText} at ${dayData.open}`;
        }
    }
    return 'soon';
  } catch {
    return 'soon';
  }
}

module.exports = { checkVendorAvailability };
