/*
 * Pure attendance / pay calculations. No DOM, no network, no globals besides the
 * exported API, so the same code runs in the browser and in `npm test`.
 *
 * Times are "HH:MM" strings in the user's local time. A shift that ends "earlier"
 * than it starts crosses midnight (22:00 -> 06:00 is 8h). Any shift longer than
 * MAX_SHIFT_MINUTES is treated as invalid / forgotten instead of being guessed.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AttendanceCalc = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const MAX_SHIFT_MINUTES = 16 * 60;

  function timeToMinutes(t) {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + m;
  }

  // Minutes from start to end on a 24h clock; wraps past midnight. 0 when equal.
  function minutesBetween(start, end) {
    return (((timeToMinutes(end) - timeToMinutes(start)) % 1440) + 1440) % 1440;
  }

  // Length of a shift in minutes, or null when it is empty or unrealistically long.
  function shiftMinutes(inTime, outTime) {
    if (!inTime || !outTime) return null;
    const m = minutesBetween(inTime, outTime);
    return m > 0 && m <= MAX_SHIFT_MINUTES ? m : null;
  }

  function dayHours(entry, settings) {
    if (entry && entry.type === 'sick') {
      const total = Math.max(0, Number(settings.sickDayHours) || 0);
      return { total, regular: total, ot125: 0, ot150: 0, excessBreakMin: 0, type: 'sick' };
    }
    const span = entry ? shiftMinutes(entry.in, entry.out) : null;
    const rawSpan = span === null ? 0 : span;
    const brk = Number(entry && entry.brk) || 0;
    const excessBreakMin = Math.max(0, brk - settings.freeBreakMinutes);
    const mins = Math.max(0, rawSpan - excessBreakMin);
    const total = mins / 60;
    const regular = Math.min(total, settings.regularHours);
    let rest = Math.max(0, total - settings.regularHours);
    const ot125 = Math.min(rest, settings.ot125Hours);
    rest = Math.max(0, rest - settings.ot125Hours);
    const ot150 = rest;
    return { total, regular, ot125, ot150, excessBreakMin, type: 'work' };
  }

  function computeMonth(monthData, settings) {
    const md = monthData || { days: {} };
    const days = md.days || {};
    const dates = Object.keys(days).sort();
    let cumRaw = 0;
    let paidRegular = 0, paidOt125 = 0, paidOt150 = 0, unpaid = 0, rawTotal = 0;
    let excessBreakMinTotal = 0, sickHours = 0, sickDays = 0;
    const perDay = {};

    for (const date of dates) {
      const entry = days[date];
      const h = dayHours(entry, settings);
      if (entry && entry.type === 'sick') { sickHours += h.total; sickDays++; }
      perDay[date] = h;
      rawTotal += h.total;
      excessBreakMinTotal += h.excessBreakMin;

      let ratio = 1;
      if (cumRaw >= settings.monthlyCap) {
        ratio = 0;
      } else if (cumRaw + h.total > settings.monthlyCap) {
        ratio = h.total > 0 ? (settings.monthlyCap - cumRaw) / h.total : 0;
      }
      cumRaw += h.total;

      h.paidRegular = h.regular * ratio;
      h.paidOt125 = h.ot125 * ratio;
      h.paidOt150 = h.ot150 * ratio;
      h.pay = h.paidRegular * settings.hourlyRate
            + h.paidOt125 * settings.hourlyRate * 1.25
            + h.paidOt150 * settings.hourlyRate * 1.5;

      paidRegular += h.paidRegular;
      paidOt125 += h.paidOt125;
      paidOt150 += h.paidOt150;
      unpaid += h.total * (1 - ratio);
    }

    const hoursGross = paidRegular * settings.hourlyRate
                     + paidOt125 * settings.hourlyRate * 1.25
                     + paidOt150 * settings.hourlyRate * 1.5;
    const additionAmounts = settings.additions.map(a => ({ ...a, amount: Number(a.amount) || 0 }));
    const totalAdditions = additionAmounts.reduce((s, a) => s + a.amount, 0);
    const gross = hoursGross + totalAdditions; // additions are part of gross, deductions apply to all of it
    const deductionAmounts = settings.deductions.map(d => ({ ...d, amount: gross * (d.percent / 100) }));
    const totalDeductions = deductionAmounts.reduce((s, d) => s + d.amount, 0);
    const net = gross - totalDeductions;

    return {
      perDay, paidRegular, paidOt125, paidOt150, unpaid, rawTotal, hoursGross, gross,
      deductionAmounts, totalDeductions, additionAmounts, totalAdditions, net,
      excessBreakMinTotal, sickHours, sickDays, capExceeded: rawTotal > settings.monthlyCap
    };
  }

  // ---- running shift helpers ----
  function sessionStartMs(session) {
    return new Date(`${session.date}T${session.checkIn}:00`).getTime();
  }

  function isStaleSession(session, nowMs) {
    if (!session) return false;
    return nowMs - sessionStartMs(session) > MAX_SHIFT_MINUTES * 60000;
  }

  // Total break minutes of a session; an open break counts until `openBreakEnd` (if given).
  function sessionBreakMinutes(session, openBreakEnd) {
    return (session.breaks || []).reduce((sum, b) => {
      const end = b.end || openBreakEnd;
      return end ? sum + minutesBetween(b.start, end) : sum;
    }, 0);
  }

  // Worked minutes so far, excluding finished breaks.
  function netElapsedMinutes(session, nowMs) {
    const gross = Math.max(0, Math.floor((nowMs - sessionStartMs(session)) / 60000));
    return Math.max(0, gross - sessionBreakMinutes(session));
  }

  return {
    MAX_SHIFT_MINUTES, timeToMinutes, minutesBetween, shiftMinutes, dayHours, computeMonth,
    isStaleSession, sessionBreakMinutes, netElapsedMinutes
  };
});
