const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../calc.js');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const quiet = { error() {} };
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing source section: ${start}`);
  return source.slice(a, b);
}
const clone = v => JSON.parse(JSON.stringify(v));
const mk = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
const date = '2026-11-26';
const existing = { type:'work', in:'08:00', out:'12:00', brk:0, note:'חשוב', tag:'remote' };
function shifts({ days = {}, active = null, failDelete = false, failWrite = false, failRead = false } = {}) {
  const db = { 'attendance:2026-11': { days:clone(days) }, ...(active ? { activeSession:clone(active) } : {}) };
  const messages = [], cache = [];
  const now = new Date(2026,10,26,14).getTime();
  const c = vm.createContext({ currentUserId:'owner', monthChangeBusy:false, shiftActionBusy:false, transitionNext:false,
    currentDate:new Date(2026,10,26), activeSession:clone(active), earlierEntryDraft:null, AttendanceCalc:C, AttendanceRecords:require('../records.js'), deepClone:clone,
    nowTimeStr:()=> '14:00', todayStr:()=>date, Date:class extends Date { static now(){ return now; } },
    updateShiftBusy(){}, render(){}, showToast:m=>messages.push(m), console:quiet, monthKey:mk,
    writeInitialCache:()=>cache.push(clone(c.activeSession)),
    kvGetStrict:async key=> { if(failRead) throw Error('offline'); return clone(db[key] || null); },
    kvSet:async(key,value)=> { if(failWrite) return false; db[key]=clone(value); return true; },
    kvDelete:async key=> { if(failDelete) return false; delete db[key]; return true; },
    syncActiveSessionFromCloud:async()=>{ c.activeSession=clone(db.activeSession || null); },
    cancelAttendanceReminderMessages:async()=>{}, cancelBreakReminder:async()=>{}, scheduleCheckOutReminders:async()=>{},
    ATTENDANCE_REMINDER_MESSAGES:{}, checkCapWarning(){}, openStaleSessionEditor(){}, loadMonth:async()=>{}
  });
  for(const [a,b] of [
    ['async function mutateMonth(', '// ---- active shift'],
    ['async function saveActiveSession(', 'function isOnBreak('],
    ['async function runShiftAction(', '// Ends the running shift'],
    ['async function closeActiveSession(', 'async function clockIn('],
    ['async function clockIn(', 'async function startBreak('],
    ['async function clockOut(', 'async function discardStaleSession(']
  ]) vm.runInContext(section(a,b),c);
  return { c, db, messages, cache, retryDelete(){ failDelete=false; } };
}
test('normal check-in refuses a date that already contains work or sickness', async()=>{
  for(const entry of [existing,{type:'sick'}]) {
    const h=shifts({days:{[date]:entry}}); await h.c.clockIn();
    assert.equal(h.db.activeSession,undefined); assert.deepEqual(h.db['attendance:2026-11'].days[date],entry);
    assert.match(h.messages.at(-1),/כבר קיים רישום/);
  }
});
test('check-in never starts a shift when the existing-day read fails', async()=>{
  const h=shifts({failRead:true}); await h.c.clockIn(); assert.equal(h.db.activeSession,undefined);
  assert.match(h.messages.at(-1),/לא נשמרה/);
});
test('clock-out keeps day metadata and all other dates', async()=>{
  const h=shifts({days:{[date]:existing,'2026-11-25':existing},active:{date,checkIn:'08:00',breaks:[]}});
  await h.c.clockOut(); const saved=h.db['attendance:2026-11'].days;
  assert.equal(saved[date].out,'14:00'); assert.equal(saved[date].note,'חשוב'); assert.equal(saved[date].tag,'remote');
  assert.deepEqual(saved['2026-11-25'],existing); assert.equal(h.db.activeSession,undefined);
});
test('clock-out refuses to overwrite a different saved shift or a sick day', async()=>{
  for(const entry of [existing,{type:'sick'}]) {
    const h=shifts({days:{[date]:entry},active:{date,checkIn:'13:00',breaks:[]}}); await h.c.clockOut();
    assert.deepEqual(h.db['attendance:2026-11'].days[date],entry); assert.ok(h.c.activeSession);
    assert.doesNotMatch(h.messages.join(' '),/המשמרת הסתיימה ונשמרה/);
  }
});
test('failed close leaves the session active, reports failure, and safely retries', async()=>{
  const h=shifts({days:{[date]:existing},active:{date,checkIn:'08:00',breaks:[]},failDelete:true});
  await h.c.clockOut(); assert.ok(h.c.activeSession); assert.ok(h.db.activeSession);
  assert.doesNotMatch(h.messages.join(' '),/המשמרת הסתיימה ונשמרה/);
  h.retryDelete(); await h.c.clockOut(); assert.equal(h.c.activeSession,null); assert.equal(h.db.activeSession,undefined);
  assert.equal(h.db['attendance:2026-11'].days[date].note,existing.note);
});
test('failed attendance save never closes the session', async()=>{
  const h=shifts({active:{date,checkIn:'08:00',breaks:[]},failWrite:true}); await h.c.clockOut();
  assert.ok(h.db.activeSession); assert.deepEqual(h.db['attendance:2026-11'].days,{});
});
test('failed session save never writes a fake shift to the initial cache', async()=>{
  const h=shifts({failWrite:true}); h.c.activeSession={date,checkIn:'08:00',breaks:[]};
  assert.equal(await h.c.saveActiveSession(),false); assert.equal(h.cache.length,0);
});
function insights(getAll) {
  const box={innerHTML:'',isConnected:true};
  const settings={hourlyRate:40,regularHours:8,sickDayHours:8,ot125Hours:2,monthlyCap:120,freeBreakMinutes:40,deductions:[],additions:[]};
  const c=vm.createContext({ currentUserId:'owner', document:{getElementById:id=>id==='insightsBody'?box:null},
    getAllMonthsData:getAll, settings, deepClone:clone, AttendanceCalc:C, AttendanceRecords:require('../records.js'), deepClone:clone, monthKey:mk,
    HE_MONTHS:Array.from({length:12},(_,i)=>`M${i+1}`), fmtHours:n=>n.toFixed(1), console:quiet });
  vm.runInContext(section('let insightsRequestId =', '// Home-screen shortcut'),c);
  return {c,box};
}
test('workday average excludes sick hours and empty historical months', async()=>{
  const h=insights(async()=>({'2026-11':{days:{a:{type:'work',in:'08:00',out:'16:00'},b:{type:'sick'}}},'2026-12':{days:{}}}));
  await h.c.renderInsights(); assert.match(h.box.innerHTML,/ממוצע שעות ליום<\/span><span class="stat-value mono">8\.0/);
  assert.match(h.box.innerHTML,/על 1 החודשים/);
});
test('sick-only history has no fictitious workday average', async()=>{
  const h=insights(async()=>({'2026-11':{days:{a:{type:'sick'}}}})); await h.c.renderInsights();
  assert.match(h.box.innerHTML,/ממוצע שעות ליום<\/span><span class="stat-value mono">—/);
});
test('history failures show a retryable error instead of an empty-history message', async()=>{
  const h=insights(async()=>{throw Error('offline')}); await h.c.renderInsights();
  assert.match(h.box.innerHTML,/לא ניתן לטעון/); assert.match(h.box.innerHTML,/retryInsights/);
  assert.doesNotMatch(h.box.innerHTML,/עדיין אין נתונים/);
});
test('an old summary response cannot replace a newer summary request', async()=>{
  let first; let n=0;
  const h=insights(()=>++n===1?new Promise(r=>first=r):Promise.resolve({}));
  const pending=h.c.renderInsights(); await h.c.renderInsights(); const latest=h.box.innerHTML;
  first({'2026-11':{days:{a:existing}}}); await pending; assert.equal(h.box.innerHTML,latest);
});
test('summary response is ignored after an account switch', async()=>{
  let resolve; const h=insights(()=>new Promise(r=>resolve=r)); const pending=h.c.renderInsights();
  h.c.currentUserId='someone-else'; resolve({'2026-11':{days:{a:existing}}}); await pending;
  assert.doesNotMatch(h.box.innerHTML,/insight-grid/);
});
test('month switch keeps the visible month/data until a successful read, ignoring double clicks', async()=>{
  const waits=[]; const current=new Date(2026,10,1); const old={days:{old:existing}}; let renders=0;
  const c=vm.createContext({ currentDate:current, currentUserId:'owner', shiftActionBusy:false,plannerOpen:false,plannerSaving:false,payslipDirty:false,
    monthData:old, payslipActual:null, monthKey:mk, softHaptic(){},setBusyBar(){},normalizePayslip:x=>x,
    writeInitialCache(){},render:()=>renders++,showToast(){},console:quiet,
    kvGetStrict:key=>new Promise(resolve=>waits.push({key,resolve})) });
  vm.runInContext(section('let monthChangeBusy =', '// ---- settings drawer'),c);
  const pending=c.changeMonth(1); await c.changeMonth(1);
  assert.equal(waits.length,2); assert.equal(c.currentDate,current); assert.equal(c.monthData,old);
  waits.forEach(w=>w.resolve(w.key.startsWith('attendance:')?{days:{}}:null)); await pending;
  assert.equal(mk(c.currentDate),'2026-12'); assert.equal(renders,1);
});
test('failed month switch leaves both label and entries intact', async()=>{
  const current=new Date(2026,10,1), old={days:{old:existing}};const messages=[];
  const c=vm.createContext({currentDate:current,currentUserId:'owner',shiftActionBusy:false,plannerOpen:false,plannerSaving:false,payslipDirty:false,
    monthData:old,monthKey:mk,softHaptic(){},setBusyBar(){},console:quiet,showToast:m=>messages.push(m),kvGetStrict:async()=>{throw Error('offline')}});
  vm.runInContext(section('let monthChangeBusy =','// ---- settings drawer'),c);await c.changeMonth(1);
  assert.equal(c.currentDate,current);assert.equal(c.monthData,old);assert.match(messages[0],/לא ניתן לטעון/);
});
test('settings writes preserve a newer work plan and do not commit failed drafts locally', async()=>{
  const old={hourlyRate:40,workPlan:{target:120}}, latest={hourlyRate:40,workPlan:{target:110}};
  let saved,fail=false;let cache=0;
  const c=vm.createContext({currentUserId:'owner',settings:old,normalizeSettings:x=>x,kvGetStrict:async()=>clone(latest),
    kvSet:async(k,v)=>{saved=clone(v);return !fail},writeInitialCache:()=>cache++,applyTheme(){}});
  vm.runInContext(section('async function saveSettingsToStorage(', 'async function loadMonth('),c);
  await c.saveSettingsToStorage({hourlyRate:45});assert.equal(saved.workPlan.target,110);assert.equal(c.settings.hourlyRate,45);
  fail=true;await assert.rejects(c.saveSettingsToStorage({hourlyRate:50}));assert.equal(c.settings.hourlyRate,45);assert.equal(cache,1);
});
test('late initial data is discarded after a month or account changes', async()=>{
  for(const change of ['month','account']) {
    let resolve; const old={hourlyRate:40};
    const query={select(){return this},eq(){return this},in(){return new Promise(r=>resolve=r)}};
    const c=vm.createContext({currentUserId:'owner',currentDate:new Date(2026,10,1),settings:old,monthKey:mk,supabaseClient:{from:()=>query}});
    vm.runInContext(section('async function loadInitialData(', 'async function saveActiveSession('),c);
    const pending=c.loadInitialData();if(change==='month')c.currentDate=new Date(2026,11,1);else c.currentUserId='other';
    resolve({data:[{key:'settings',value:{hourlyRate:99}}],error:null});assert.equal(await pending,false);assert.equal(c.settings,old);
  }
});
test('foreground refresh returns a failure result instead of a success signal', async()=>{
  const c=vm.createContext({appStarted:true,currentUserId:'owner',shiftActionBusy:false,monthChangeBusy:false,
    dataFingerprint:()=>'',loadInitialData:async()=>{throw Error('offline')},cleanupRetiredReception:async()=>{},console:quiet});
  vm.runInContext(section('let foregroundRefreshPromise =', "document.addEventListener('visibilitychange'"),c);
  assert.equal(await c.refreshFromCloud(),false);
});
test('overlapping edits in one tab cannot resurrect another deleted day', async()=>{
  const h=shifts({days:{a:existing,b:existing,c:existing}});
  await Promise.all([h.c.mutateMonth('2026-11',m=>delete m.days.a),h.c.mutateMonth('2026-11',m=>delete m.days.b)]);
  assert.deepEqual(Object.keys(h.db['attendance:2026-11'].days),['c']);
});
