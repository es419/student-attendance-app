const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../calc.js');

const settings = {
  hourlyRate: 40, regularHours: 8, sickDayHours: 8, ot125Hours: 2, monthlyCap: 120,
  freeBreakMinutes: 40,
  deductions: [{ id: 'p', name: 'פנסיה', percent: 10 }],
  additions: [{ id: 't', name: 'נסיעות', amount: 200 }]
};
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('minutesBetween wraps past midnight', () => {
  assert.equal(C.minutesBetween('08:00', '16:30'), 510);
  assert.equal(C.minutesBetween('22:00', '06:00'), 480);
  assert.equal(C.minutesBetween('10:00', '10:00'), 0);
});

test('shiftMinutes rejects empty and unrealistic shifts', () => {
  assert.equal(C.shiftMinutes('08:00', '16:00'), 480);
  assert.equal(C.shiftMinutes('22:00', '06:00'), 480);
  assert.equal(C.shiftMinutes('08:00', '08:00'), null);
  assert.equal(C.shiftMinutes('08:00', '07:00'), null); // 23h is a typo, not a shift
  assert.equal(C.shiftMinutes('', '07:00'), null);
});

test('dayHours: regular, 125% and 150% tiers', () => {
  const h = C.dayHours({ in: '08:00', out: '20:00', brk: 0 }, settings); // 12h
  near(h.total, 12); near(h.regular, 8); near(h.ot125, 2); near(h.ot150, 2);
});

test('dayHours: only break minutes above the free allowance are deducted', () => {
  const h = C.dayHours({ in: '08:00', out: '16:00', brk: 60 }, settings); // 480 - 20
  near(h.total, 460 / 60); assert.equal(h.excessBreakMin, 20);
  const free = C.dayHours({ in: '08:00', out: '16:00', brk: 30 }, settings);
  near(free.total, 8);
});

test('dayHours: overnight shift is counted, not zeroed', () => {
  near(C.dayHours({ in: '22:00', out: '06:00', brk: 0 }, settings).total, 8);
});

test('dayHours: sick day uses the configured hours', () => {
  const h = C.dayHours({ type: 'sick' }, settings);
  near(h.total, 8); assert.equal(h.type, 'sick');
});

test('computeMonth: additions are part of gross and deductions apply to all of it', () => {
  const m = C.computeMonth({ days: { '2026-09-01': { in: '08:00', out: '16:00', brk: 0 } } }, settings);
  near(m.hoursGross, 320);            // 8h * 40
  near(m.gross, 520);                 // + 200 travel
  near(m.totalDeductions, 52);        // 10% of 520, not of 320
  near(m.net, 468);
});

test('computeMonth: hours over the cap are not paid', () => {
  const s = { ...settings, monthlyCap: 10, additions: [], deductions: [] };
  const m = C.computeMonth({ days: {
    '2026-09-01': { in: '08:00', out: '16:00', brk: 0 },   // 8h
    '2026-09-02': { in: '08:00', out: '16:00', brk: 0 }    // 8h -> only 2h fit under the cap
  } }, s);
  near(m.rawTotal, 16); near(m.unpaid, 6); near(m.hoursGross, 400);
  assert.equal(m.capExceeded, true);
});

test('computeMonth: empty month', () => {
  const m = C.computeMonth({ days: {} }, settings);
  near(m.rawTotal, 0); near(m.gross, 200);
});

test('isStaleSession flags a shift left open too long', () => {
  const session = { date: '2026-09-27', checkIn: '08:00', breaks: [] };
  const start = new Date('2026-09-27T08:00:00').getTime();
  assert.equal(C.isStaleSession(session, start + 15 * 3600000), false);
  assert.equal(C.isStaleSession(session, start + 17 * 3600000), true);
  assert.equal(C.isStaleSession(null, start), false);
});

test('netElapsedMinutes and break helpers', () => {
  const session = { date: '2026-09-27', checkIn: '08:00', breaks: [{ start: '12:00', end: '12:30' }] };
  const start = new Date('2026-09-27T08:00:00').getTime();
  assert.equal(C.netElapsedMinutes(session, start + 5 * 3600000), 270);
  assert.equal(C.sessionBreakMinutes(session), 30);
  const open = { breaks: [{ start: '23:50', end: null }] };
  assert.equal(C.sessionBreakMinutes(open, '00:10'), 20); // wraps midnight
  assert.equal(C.sessionBreakMinutes(open), 0);
});
