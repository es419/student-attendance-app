const SUPABASE_URL = 'https://ojzemdselyxxscbbvssm.supabase.co';
const SUPABASE_KEY = 'sb_publishable_IVQ2kJsIMv7nA-PxZkK23A_FkTbXkeZ';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const VAPID_PUBLIC_KEY = 'BAevMi3SdJM6bns7zX37-eFKmfHK_e7zdq4v4uEth0s-xi56IDqntJjZYky4bRJKTxvcv4A8m_R1Fs-oRV_MYxc';

// Load the Excel export library only when actually needed, instead of on every page visit
let xlsxLoadPromise = null;
function ensureXLSXLoaded(){
  if(typeof XLSX !== 'undefined') return Promise.resolve();
  if(xlsxLoadPromise) return xlsxLoadPromise;
  xlsxLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve();
    s.onerror = () => { xlsxLoadPromise = null; reject(new Error('failed to load xlsx')); };
    document.head.appendChild(s);
  });
  return xlsxLoadPromise;
}

const HE_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

const DEFAULT_SETTINGS = {
  hourlyRate: 39.58,
  regularHours: 8,
  ot125Hours: 2,
  monthlyCap: 120,
  freeBreakMinutes: 40,
  capWarnHours: 10,
  themeMode: 'system',
  accentColor: 'bronze',
  deductions: [
    { id: 'pension', name: 'פנסיה', percent: 6 },
    { id: 'keren', name: 'קרן השתלמות', percent: 2.5 },
    { id: 'bituach', name: 'ביטוח לאומי ובריאות', percent: 3.5 }
  ],
  additions: [
    { id: 'travel', name: 'נסיעות', amount: 0 }
  ]
};

let settings = null;
let currentDate = new Date();
let monthData = { days: {} }; // { "YYYY-MM-DD": { in, out, brk } }
let viewMode = 'list'; // 'calendar' | 'list'
let activeTab = 'today'; // 'today' | 'shifts'
let activeSession = null; // { date, checkIn, breaks:[{start,end|null}] } — persisted while a shift is running
let currentUserId = null;

const $ = (sel) => document.querySelector(sel);

function initialCacheKey(userId){
  return `nc_initial:${userId}:${monthKey(currentDate)}`;
}

function readInitialCache(userId){
  if(!userId) return false;
  try{
    const raw = localStorage.getItem(initialCacheKey(userId));
    if(!raw) return false;
    const cached = JSON.parse(raw);
    if(!cached || typeof cached !== 'object') return false;
    settings = normalizeSettings(cached.settings);
    monthData = cached.monthData || { days:{} };
    activeSession = cached.activeSession || null;
    applyTheme();
    return true;
  }catch(e){
    return false;
  }
}

function writeInitialCache(userId){
  if(!userId) return;
  try{
    localStorage.setItem(initialCacheKey(userId), JSON.stringify({
      settings, monthData, activeSession, cachedAt: Date.now()
    }));
  }catch(e){ /* cache is best-effort */ }
}
const softHaptic = () => { try{ if(navigator.vibrate) navigator.vibrate(8); }catch(e){} };
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
function todayStr(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function nowTimeStr(){
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

let toastTimer = null;
function showToast(msg){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove('show'), 2200);
}

// ---- push notifications (break reminders) ----
let swRegistration = null;

function urlBase64ToUint8Array(base64String){
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for(let i = 0; i < rawData.length; ++i){
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function registerServiceWorker(){
  if(!('serviceWorker' in navigator)) return null;
  try{
    // index.html starts registration as early as possible. Reuse that promise here
    // so push notifications and the rest of the app share one registration.
    if(window.__attendanceSwRegistrationPromise){
      swRegistration = await window.__attendanceSwRegistrationPromise;
    }
    if(!swRegistration){
      swRegistration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    }
    return swRegistration;
  }catch(e){
    console.error('service worker registration failed', e);
    return null;
  }
}

function pushSupportStatus(){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  if(Notification.permission === 'denied') return 'denied';
  return 'ok';
}

async function getCurrentPushSubscription(){
  if(!swRegistration) return null;
  try{
    return await swRegistration.pushManager.getSubscription();
  }catch(e){
    return null;
  }
}

async function refreshPushStatusUI(){
  const statusEl = $('#pushStatusText');
  const btn = $('#pushToggleBtn');
  if(!statusEl || !btn) return;

  const support = pushSupportStatus();
  if(support === 'unsupported'){
    statusEl.textContent = 'הדפדפן הזה לא תומך בהתראות פוש';
    statusEl.className = 'push-status blocked';
    btn.hidden = true;
    return;
  }
  if(support === 'denied'){
    statusEl.textContent = 'ההתראות נחסמו בהגדרות הדפדפן/המכשיר';
    statusEl.className = 'push-status blocked';
    btn.hidden = true;
    return;
  }

  btn.hidden = false;
  const sub = await getCurrentPushSubscription();
  if(sub){
    statusEl.textContent = 'התראות פוש פעילות ✓';
    statusEl.className = 'push-status on';
    btn.textContent = 'בטל התראות פוש';
  } else {
    statusEl.textContent = 'התראות פוש כבויות';
    statusEl.className = 'push-status off';
    btn.textContent = 'הפעל התראות פוש';
  }
}

async function subscribeToPush(){
  if(!swRegistration){
    await registerServiceWorker();
  }
  if(!swRegistration){
    showToast('לא ניתן להפעיל התראות בדפדפן הזה');
    return;
  }
  const permission = await Notification.requestPermission();
  if(permission !== 'granted'){
    showToast('ההרשאה להתראות לא ניתנה');
    await refreshPushStatusUI();
    return;
  }
  try{
    const sub = await swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
    const raw = sub.toJSON();
    const userId = currentUserId;
    if(!userId) throw new Error('no user');
    const { error } = await supabaseClient.from('push_subscriptions').upsert({
      user_id: userId,
      endpoint: raw.endpoint,
      p256dh: raw.keys.p256dh,
      auth: raw.keys.auth
    }, { onConflict: 'user_id,endpoint' });
    if(error) throw error;
    showToast('התראות פוש הופעלו');
  }catch(e){
    console.error(e);
    showToast('שגיאה בהפעלת ההתראות');
  }
  await refreshPushStatusUI();
}

async function unsubscribeFromPush(){
  const sub = await getCurrentPushSubscription();
  if(sub){
    try{
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      const userId = currentUserId;
      if(userId){
        await supabaseClient.from('push_subscriptions').delete().eq('user_id', userId).eq('endpoint', endpoint);
      }
    }catch(e){
      console.error(e);
    }
  }
  showToast('התראות פוש כבויות');
  await refreshPushStatusUI();
}

async function scheduleBreakReminder(){
  // Only worth scheduling if there's meaningfully more than 10 minutes of free break left
  if(settings.freeBreakMinutes <= 10) return null;
  const sub = await getCurrentPushSubscription();
  if(!sub) return null; // push not enabled — skip silently

  const fireAt = new Date(Date.now() + (settings.freeBreakMinutes - 10) * 60000);
  try{
    const userId = currentUserId;
    if(!userId) return null;
    const { data, error } = await supabaseClient
      .from('break_reminders')
      .insert({
        user_id: userId,
        fire_at: fireAt.toISOString(),
        message: `עוד 10 דקות וההפסקה שלך (${settings.freeBreakMinutes} דק') מסתיימת`
      })
      .select('id')
      .single();
    if(error) throw error;
    return data.id;
  }catch(e){
    console.error('scheduleBreakReminder failed', e);
    return null;
  }
}

async function cancelBreakReminder(reminderId){
  if(!reminderId) return;
  try{
    await supabaseClient.from('break_reminders').delete().eq('id', reminderId).eq('sent', false);
  }catch(e){
    console.error('cancelBreakReminder failed', e);
  }
}

// ---- monthly hour-cap proximity warning ----
// Reuses the same break_reminders table + cron/Edge Function — just fires immediately (fire_at = now)
// instead of being scheduled ahead of time. Only ever sent once per calendar month.
async function checkCapWarning(){
  if(settings.capWarnHours <= 0) return; // disabled
  if(monthKey(currentDate) !== monthKey(new Date())) return; // only relevant for the real current month
  const sub = await getCurrentPushSubscription();
  if(!sub) return; // push not enabled — nothing to send

  const calc = computeMonth();
  const remaining = settings.monthlyCap - calc.rawTotal;
  if(remaining > settings.capWarnHours) return; // not close enough yet

  const thisMonthKey = monthKey(new Date());
  let state = null;
  try{ state = await kvGet('capWarningState'); }catch(e){ /* ignore */ }
  if(state && state.month === thisMonthKey) return; // already warned this month

  try{
    const userId = currentUserId;
    if(!userId) return;
    await supabaseClient.from('break_reminders').insert({
      user_id: userId,
      fire_at: new Date().toISOString(),
      message: `שים לב: הגעת ל-${fmtHours(calc.rawTotal)} מתוך ${settings.monthlyCap} שעות החודש`
    });
    await kvSet('capWarningState', { month: thisMonthKey });
  }catch(e){
    console.error('checkCapWarning failed', e);
  }
}

function deepClone(obj){
  return JSON.parse(JSON.stringify(obj));
}

function normalizeSettings(saved = null){
  const merged = { ...deepClone(DEFAULT_SETTINGS), ...(saved || {}) };
  if(!Array.isArray(merged.deductions)) merged.deductions = deepClone(DEFAULT_SETTINGS.deductions);
  if(!Array.isArray(merged.additions)) merged.additions = deepClone(DEFAULT_SETTINGS.additions);
  return merged;
}

// ---- Supabase key-value storage ----
async function kvGet(key){
  try{
    const userId = currentUserId;
    if(!userId) return null;
    const { data, error } = await supabaseClient
      .from('kv_store')
      .select('value')
      .eq('user_id', userId)
      .eq('key', key)
      .maybeSingle();
    if(error) throw error;
    return data ? data.value : null;
  }catch(e){
    console.error('kvGet error', e);
    return null;
  }
}

async function kvSet(key, value){
  try{
    const userId = currentUserId;
    if(!userId) return false;
    const { error } = await supabaseClient
      .from('kv_store')
      .upsert({ user_id: userId, key, value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' });
    if(error) throw error;
    return true;
  }catch(e){
    console.error('kvSet error', e);
    return false;
  }
}

async function kvDelete(key){
  try{
    const userId = currentUserId;
    if(!userId) return;
    const { error } = await supabaseClient.from('kv_store').delete().eq('user_id', userId).eq('key', key);
    if(error) throw error;
  }catch(e){
    console.error('kvDelete error', e);
  }
}

const HEADER_ICON_MAP = {
  bronze: 'icon-192.png',
  copper: 'icon-header-copper.png',
  teal: 'icon-header-teal.png'
};

function applyTheme(){
  let resolvedTheme = settings.themeMode || 'dark';
  if(resolvedTheme === 'system'){
    resolvedTheme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', resolvedTheme);
  const accent = settings.accentColor || 'bronze';
  document.documentElement.setAttribute('data-accent', accent);

  const metaTheme = document.getElementById('themeColorMeta');
  if(metaTheme) metaTheme.setAttribute('content', resolvedTheme === 'dark' ? '#0d1622' : '#f2f4f7');

  try{
    localStorage.setItem('nc_theme_cache', JSON.stringify({ themeMode: settings.themeMode, accentColor: settings.accentColor }));
  }catch(e){ /* localStorage unavailable */ }

  const iconSrc = HEADER_ICON_MAP[accent] || HEADER_ICON_MAP.bronze;
  document.querySelectorAll('img.brand-mark').forEach(img => {
    if(!img.src.endsWith(iconSrc)) img.src = iconSrc;
  });
}

// React live if the OS appearance changes while the app is open (only matters when mode is 'system')
if(window.matchMedia){
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if(settings && settings.themeMode === 'system') applyTheme();
  });
}

async function saveSettingsToStorage(){
  writeInitialCache(currentUserId);
  const ok = await kvSet('settings', settings);
  applyTheme();
  showToast(ok ? 'ההגדרות נשמרו' : 'שגיאה בשמירת ההגדרות');
}

async function loadMonth(d){
  const key = `attendance:${monthKey(d)}`;
  const saved = await kvGet(key);
  monthData = saved || { days:{} };
}

async function saveMonth(d){
  if(monthKey(d) === monthKey(currentDate)) writeInitialCache(currentUserId);
  const key = `attendance:${monthKey(d)}`;
  const ok = await kvSet(key, monthData);
  if(!ok) showToast('שגיאה בשמירה');
}

// ---- active shift (quick clock in/out + break) ----
// One initial network request: settings + current month + active shift.
async function loadInitialData(userId = currentUserId){
  if(!userId) throw new Error('No authenticated user');

  const monthDataKey = `attendance:${monthKey(currentDate)}`;
  const { data: rows, error } = await supabaseClient
    .from('kv_store')
    .select('key, value')
    .eq('user_id', userId)
    .in('key', ['settings', monthDataKey, 'activeSession']);

  if(error) throw error;

  const byKey = Object.fromEntries((rows || []).map(row => [row.key, row.value]));
  settings = normalizeSettings(byKey.settings);

  monthData = byKey[monthDataKey] || { days:{} };
  activeSession = byKey.activeSession || null;
  applyTheme();
  writeInitialCache(userId);
}

async function saveActiveSession(){
  writeInitialCache(currentUserId);
  if(activeSession){
    const ok = await kvSet('activeSession', activeSession);
    if(!ok) showToast('שגיאה בשמירת סטטוס המשמרת');
  } else {
    await kvDelete('activeSession');
  }
}

function isOnBreak(){
  if(!activeSession || activeSession.breaks.length === 0) return false;
  const last = activeSession.breaks[activeSession.breaks.length-1];
  return !last.end;
}

async function clockIn(){
  if(activeSession) return;
  activeSession = { date: todayStr(), checkIn: nowTimeStr(), breaks: [] };
  await saveActiveSession();
  render();
  showToast('המשמרת התחילה — בהצלחה!');
}

async function startBreak(){
  if(!activeSession || isOnBreak()) return;
  activeSession.breaks.push({ start: nowTimeStr(), end: null });
  await saveActiveSession();
  render();
  showToast('יצאת להפסקה');
  // schedule a push reminder for 10 minutes before the free break allowance runs out
  const reminderId = await scheduleBreakReminder();
  if(reminderId){
    activeSession.breaks[activeSession.breaks.length-1].reminderId = reminderId;
    await saveActiveSession();
  }
}

async function endBreak(){
  if(!activeSession || !isOnBreak()) return;
  const lastBreak = activeSession.breaks[activeSession.breaks.length-1];
  lastBreak.end = nowTimeStr();
  await cancelBreakReminder(lastBreak.reminderId);
  await saveActiveSession();
  render();
  showToast('חזרת מהפסקה');
}

async function clockOut(){
  if(!activeSession) return;
  const checkOut = nowTimeStr();
  if(isOnBreak()){
    const lastBreak = activeSession.breaks[activeSession.breaks.length-1];
    lastBreak.end = checkOut;
    await cancelBreakReminder(lastBreak.reminderId);
  }
  const date = activeSession.date;
  const checkIn = activeSession.checkIn;
  const totalBreakMin = activeSession.breaks.reduce((sum,b) => {
    const end = b.end || checkOut;
    return sum + Math.max(0, timeToMinutes(end) - timeToMinutes(b.start));
  }, 0);

  if(timeToMinutes(checkOut) <= timeToMinutes(checkIn)){
    showToast('שעת הסיום יצאה לפני ההתחלה — ערוך את היום ידנית ברשימה');
    activeSession = null;
    await saveActiveSession();
    render();
    return;
  }

  if(date.slice(0,7) !== monthKey(currentDate)){
    currentDate = new Date(date+'T00:00:00');
    await loadMonth(currentDate);
  }
  monthData.days[date] = { in: checkIn, out: checkOut, brk: totalBreakMin };
  await saveMonth(currentDate);
  activeSession = null;
  await saveActiveSession();
  render();
  showToast('המשמרת הסתיימה ונשמרה');
  checkCapWarning();
}

function lpButton(id, extraClass, label){
  return `<button id="${id}" class="shift-btn lp ${extraClass||''}" type="button">
    <span class="lp-fill"></span><span class="lp-label">${label}</span>
  </button>`;
}

function buildShiftWidget(){
  if(!activeSession){
    return `
      <section class="shift-widget idle">
        ${lpButton('clockInBtn','','🟢 כניסה עכשיו')}
        <p class="lp-hint">החזיקו לחיצה כדי לאשר</p>
      </section>`;
  }
  if(isOnBreak()){
    const b = activeSession.breaks[activeSession.breaks.length-1];
    return `
      <section class="shift-widget on-break">
        <div class="shift-status">☕ בהפסקה מהשעה ${b.start}</div>
        <div class="shift-actions">
          ${lpButton('endBreakBtn','','🟢 חזרה מהפסקה')}
          ${lpButton('clockOutBtn','secondary','🔴 סיום משמרת')}
        </div>
        <p class="lp-hint">החזיקו לחיצה כדי לאשר</p>
      </section>`;
  }
  return `
    <section class="shift-widget active">
      <div class="shift-status">🟠 במשמרת מהשעה ${activeSession.checkIn} <span id="shiftElapsed" class="mono"></span></div>
      <div class="shift-actions">
        ${lpButton('startBreakBtn','','☕ יציאה להפסקה')}
        ${lpButton('clockOutBtn','secondary','🔴 סיום משמרת')}
      </div>
      <p class="lp-hint">החזיקו לחיצה כדי לאשר</p>
    </section>`;
}

function tickShiftTimer(){
  const el = document.getElementById('shiftElapsed');
  if(!el || !activeSession || isOnBreak()) return;
  const start = new Date(`${activeSession.date}T${activeSession.checkIn}:00`);
  const now = new Date();
  let diffMin = Math.floor((now - start) / 60000);
  const breakMin = activeSession.breaks.reduce((s,b) => s + (b.end ? (timeToMinutes(b.end) - timeToMinutes(b.start)) : 0), 0);
  diffMin = Math.max(0, diffMin - breakMin);
  const h = Math.floor(diffMin/60), m = diffMin % 60;
  el.textContent = `· חלפו ${h}ש׳ ${m}ד׳`;
}

// ---- calculation ----
function timeToMinutes(t){
  const [h,m] = t.split(':').map(Number);
  return h*60+m;
}

function dayHours(entry){
  let rawSpan = timeToMinutes(entry.out) - timeToMinutes(entry.in);
  if(rawSpan < 0) rawSpan = 0;
  const brk = Number(entry.brk)||0;
  const excessBreakMin = Math.max(0, brk - settings.freeBreakMinutes);
  let mins = rawSpan - excessBreakMin;
  if(mins < 0) mins = 0;
  const total = mins/60;
  const regular = Math.min(total, settings.regularHours);
  let rest = Math.max(0, total - settings.regularHours);
  const ot125 = Math.min(rest, settings.ot125Hours);
  rest = Math.max(0, rest - settings.ot125Hours);
  const ot150 = rest;
  return { total, regular, ot125, ot150, excessBreakMin };
}

function computeMonth(monthDataArg){
  const md = monthDataArg || monthData;
  const dates = Object.keys(md.days).sort();
  let cumRaw = 0;
  let paidRegular=0, paidOt125=0, paidOt150=0, unpaid=0, rawTotal=0, excessBreakMinTotal=0;
  const perDay = {};

  for(const date of dates){
    const h = dayHours(md.days[date]);
    perDay[date] = h;
    rawTotal += h.total;
    excessBreakMinTotal += h.excessBreakMin;

    let ratio = 1;
    if(cumRaw >= settings.monthlyCap){
      ratio = 0;
    } else if(cumRaw + h.total > settings.monthlyCap){
      ratio = h.total > 0 ? (settings.monthlyCap - cumRaw) / h.total : 0;
    }
    cumRaw += h.total;

    h.paidRegular = h.regular*ratio;
    h.paidOt125 = h.ot125*ratio;
    h.paidOt150 = h.ot150*ratio;
    h.pay = h.paidRegular*settings.hourlyRate + h.paidOt125*settings.hourlyRate*1.25 + h.paidOt150*settings.hourlyRate*1.5;

    paidRegular += h.paidRegular;
    paidOt125 += h.paidOt125;
    paidOt150 += h.paidOt150;
    unpaid += h.total*(1-ratio);
  }

  const hoursGross = paidRegular*settings.hourlyRate + paidOt125*settings.hourlyRate*1.25 + paidOt150*settings.hourlyRate*1.5;
  const additionAmounts = settings.additions.map(a => ({ ...a, amount: Number(a.amount)||0 }));
  const totalAdditions = additionAmounts.reduce((s,a)=>s+a.amount,0);
  const gross = hoursGross + totalAdditions; // additions are part of gross salary, not a tax-free top-up
  const deductionAmounts = settings.deductions.map(dd => ({ ...dd, amount: gross*(dd.percent/100) }));
  const totalDeductions = deductionAmounts.reduce((s,d)=>s+d.amount,0);
  const net = gross - totalDeductions;

  return { perDay, paidRegular, paidOt125, paidOt150, unpaid, rawTotal, hoursGross, gross, deductionAmounts, totalDeductions, additionAmounts, totalAdditions, net, excessBreakMinTotal, capExceeded: rawTotal > settings.monthlyCap };
}

async function getAllMonthsData(){
  try{
    const userId = currentUserId;
    if(!userId) return {};
    const { data, error } = await supabaseClient
      .from('kv_store')
      .select('key, value')
      .eq('user_id', userId)
      .like('key', 'attendance:%');
    if(error) throw error;
    const result = {};
    (data || []).forEach(row => {
      const mk = row.key.replace('attendance:', '');
      result[mk] = row.value;
    });
    return result;
  }catch(e){
    console.error('getAllMonthsData error', e);
    return {};
  }
}

// ---- rendering ----
function fmtHours(h){ return h.toLocaleString('he-IL',{minimumFractionDigits:1,maximumFractionDigits:1}); }
function fmtMoney(n){ return '₪' + n.toLocaleString('he-IL',{minimumFractionDigits:0,maximumFractionDigits:0}); }

async function exportMonthToExcel(calc){
  const dates = Object.keys(monthData.days).sort();
  if(dates.length === 0){
    showToast('אין עדיין נתונים לחודש הזה לייצוא');
    return;
  }
  try{
    if(typeof XLSX === 'undefined') showToast('טוען את ספריית האקסל…');
    await ensureXLSXLoaded();
  }catch(e){
    showToast('שגיאה בטעינת ספריית האקסל — נסה שוב');
    return;
  }

  const shiftsHeader = ['תאריך','כניסה','יציאה','הפסקה (דק\')','חריגת הפסקה (דק\')','שעות רגילות','שעות 125%','שעות 150%','סה"כ שעות'];
  const shiftsRows = dates.map(date => {
    const e = monthData.days[date];
    const h = calc.perDay[date];
    return [
      date,
      e.in,
      e.out,
      e.brk,
      Math.round(h.excessBreakMin),
      Number(h.regular.toFixed(2)),
      Number(h.ot125.toFixed(2)),
      Number(h.ot150.toFixed(2)),
      Number(h.total.toFixed(2))
    ];
  });
  const totalsRow = [
    'סה"כ', '', '', '', Math.round(calc.excessBreakMinTotal),
    Number(calc.paidRegular.toFixed(2)),
    Number(calc.paidOt125.toFixed(2)),
    Number(calc.paidOt150.toFixed(2)),
    Number(calc.rawTotal.toFixed(2))
  ];

  const shiftsSheet = XLSX.utils.aoa_to_sheet([shiftsHeader, ...shiftsRows, [], totalsRow]);
  shiftsSheet['!cols'] = shiftsHeader.map(() => ({ wch: 15 }));
  shiftsSheet['!views'] = [{ rightToLeft: true }];

  const summaryRows = [
    ['סיכום שכר', `${HE_MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}`],
    [],
    ['שכר שעתי', settings.hourlyRate],
    ['שעות רגילות (ששולמו)', Number(calc.paidRegular.toFixed(2))],
    ['שעות 125% (ששולמו)', Number(calc.paidOt125.toFixed(2))],
    ['שעות 150% (ששולמו)', Number(calc.paidOt150.toFixed(2))],
    ['סה"כ שעות בפועל', Number(calc.rawTotal.toFixed(2))],
    ['שעות שלא שולמו (חריגת תקרה)', Number(calc.unpaid.toFixed(2))],
    [],
    ['שכר משעות עבודה', Number(calc.hoursGross.toFixed(2))],
    ...calc.additionAmounts.filter(a=>a.amount>0).map(a => [`תוספת: ${a.name}`, Number(a.amount.toFixed(2))]),
    ['שכר ברוטו משוער', Number(calc.gross.toFixed(2))],
    ...calc.deductionAmounts.map(d => [`ניכוי: ${d.name} (${d.percent}%)`, -Number(d.amount.toFixed(2))]),
    [],
    ['שכר נטו משוער', Number(calc.net.toFixed(2))]
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet['!cols'] = [{ wch: 32 }, { wch: 16 }];
  summarySheet['!views'] = [{ rightToLeft: true }];

  const wb = XLSX.utils.book_new();
  wb.Workbook = wb.Workbook || {};
  wb.Workbook.Views = [{ RTL: true }];
  XLSX.utils.book_append_sheet(wb, summarySheet, 'סיכום');
  XLSX.utils.book_append_sheet(wb, shiftsSheet, 'משמרות');

  const filename = `נוכחות-${monthKey(currentDate)}.xlsx`;
  try{
    XLSX.writeFile(wb, filename);
    showToast('הקובץ יוצא בהצלחה');
  }catch(e){
    showToast('שגיאה בייצוא הקובץ');
  }
}

async function exportAllHistoryToExcel(){
  try{
    if(typeof XLSX === 'undefined') showToast('טוען את ספריית האקסל…');
    await ensureXLSXLoaded();
  }catch(e){
    showToast('שגיאה בטעינת ספריית האקסל — נסה שוב');
    return;
  }
  showToast('אוסף את כל ההיסטוריה…');
  const allMonths = await getAllMonthsData();
  const monthKeys = Object.keys(allMonths).sort();
  if(monthKeys.length === 0){
    showToast('אין עדיין נתונים לייצוא');
    return;
  }

  // Sheet 1: one row per month with totals
  const monthlyHeader = ['חודש','שעות רגילות','שעות 125%','שעות 150%','סה"כ שעות בפועל','שעות לא ששולמו','ברוטו','נטו'];
  const monthlyRows = [];
  const shiftsHeader = ['תאריך','כניסה','יציאה','הפסקה (דק\')','חריגת הפסקה (דק\')','שעות רגילות','שעות 125%','שעות 150%','סה"כ שעות'];

  const wb = XLSX.utils.book_new();
  wb.Workbook = wb.Workbook || {};
  wb.Workbook.Views = [{ RTL: true }];

  let grandGross = 0, grandNet = 0;
  const usedSheetNames = new Set();

  for(const mk of monthKeys){
    const md = allMonths[mk];
    const calc = computeMonth(md);
    const [y, m] = mk.split('-').map(Number);
    const label = `${HE_MONTHS[m-1]} ${y}`;

    monthlyRows.push([
      label,
      Number(calc.paidRegular.toFixed(2)),
      Number(calc.paidOt125.toFixed(2)),
      Number(calc.paidOt150.toFixed(2)),
      Number(calc.rawTotal.toFixed(2)),
      Number(calc.unpaid.toFixed(2)),
      Number(calc.gross.toFixed(2)),
      Number(calc.net.toFixed(2))
    ]);
    grandGross += calc.gross;
    grandNet += calc.net;

    // build this month's own sheet, same shape as the single-month export
    const dates = Object.keys(md.days || {}).sort();
    const monthRows = dates.map(date => {
      const e = md.days[date];
      const h = calc.perDay[date];
      return [
        date, e.in, e.out, e.brk, Math.round(h.excessBreakMin),
        Number(h.regular.toFixed(2)), Number(h.ot125.toFixed(2)), Number(h.ot150.toFixed(2)), Number(h.total.toFixed(2))
      ];
    });
    const totalsRow = [
      'סה"כ', '', '', '', Math.round(calc.excessBreakMinTotal),
      Number(calc.paidRegular.toFixed(2)), Number(calc.paidOt125.toFixed(2)), Number(calc.paidOt150.toFixed(2)), Number(calc.rawTotal.toFixed(2))
    ];

    const monthSheet = XLSX.utils.aoa_to_sheet([shiftsHeader, ...monthRows, [], totalsRow]);
    monthSheet['!cols'] = shiftsHeader.map(() => ({ wch: 14 }));
    monthSheet['!views'] = [{ rightToLeft: true }];

    // Excel sheet names: max 31 chars, no \ / ? * [ ] : — and must be unique
    let sheetName = label.slice(0, 31);
    let suffix = 2;
    while(usedSheetNames.has(sheetName)){
      sheetName = `${label.slice(0, 28)} ${suffix}`;
      suffix++;
    }
    usedSheetNames.add(sheetName);

    XLSX.utils.book_append_sheet(wb, monthSheet, sheetName);
  }

  monthlyRows.push([]);
  monthlyRows.push(['סה"כ הכל', '', '', '', '', '', Number(grandGross.toFixed(2)), Number(grandNet.toFixed(2))]);

  const monthlySheet = XLSX.utils.aoa_to_sheet([monthlyHeader, ...monthlyRows]);
  monthlySheet['!cols'] = monthlyHeader.map(() => ({ wch: 16 }));
  monthlySheet['!views'] = [{ rightToLeft: true }];
  // insert the summary as the first sheet
  XLSX.utils.book_append_sheet(wb, monthlySheet, 'סיכום חודשי');
  wb.SheetNames.unshift(wb.SheetNames.pop());

  try{
    XLSX.writeFile(wb, 'נוכחות-כל-ההיסטוריה.xlsx');
    showToast('הקובץ יוצא בהצלחה');
  }catch(e){
    showToast('שגיאה בייצוא הקובץ');
  }
}

function render(){
  const main = $('#mainContent');
  const calc = computeMonth();
  const capPct = Math.min(100, (calc.rawTotal / settings.monthlyCap) * 100);
  const overPct = calc.capExceeded ? 100 - (settings.monthlyCap/calc.rawTotal*100) : 0;

  const dates = Object.keys(monthData.days).sort().reverse();

  main.innerHTML = `
    ${buildShiftWidget()}

    <div class="tab-bar">
      <button type="button" data-tab="today" class="tab-btn ${activeTab==='today'?'active':''}">היום</button>
      <button type="button" data-tab="shifts" class="tab-btn ${activeTab==='shifts'?'active':''}">משמרות</button>
    </div>

    <div class="tab-panel" data-panel="today" ${activeTab!=='today' ? 'hidden' : ''}>
    <section class="ledger-card">
      <div class="cap-label">
        <span>0</span>
        <span>${settings.monthlyCap} שעות (תקרה)</span>
      </div>
      <div class="punch-strip">
        <div class="punch-fill">
          <span style="width:${Math.max(0,capPct-overPct)}%;background:var(--teal)"></span>
          <span style="width:${overPct}%;background:var(--rust)"></span>
        </div>
        <div class="punch-holes"></div>
      </div>

      <div class="ledger-grid">
        <div class="ledger-stat regular"><span class="stat-label">רגילות</span><span class="stat-value mono">${fmtHours(calc.paidRegular)}</span></div>
        <div class="ledger-stat ot125"><span class="stat-label">125%</span><span class="stat-value mono">${fmtHours(calc.paidOt125)}</span></div>
        <div class="ledger-stat ot150"><span class="stat-label">150%</span><span class="stat-value mono">${fmtHours(calc.paidOt150)}</span></div>
        <div class="ledger-stat"><span class="stat-label">סה"כ בפועל</span><span class="stat-value mono">${fmtHours(calc.rawTotal)}</span></div>
      </div>

      ${calc.capExceeded ? `<div class="cap-warning">חרגת מ-${settings.monthlyCap} שעות החודש — כ-${fmtHours(calc.unpaid)} שעות לא ישולמו לפי החוזה.</div>` : ''}
      ${calc.excessBreakMinTotal > 0 ? `<div class="break-note">☕ החודש נוכו ${Math.round(calc.excessBreakMinTotal)} דק׳ (${fmtHours(calc.excessBreakMinTotal/60)} ש׳) בגין חריגות הפסקה מעבר ל-${settings.freeBreakMinutes} הדק׳ הפטורות ליום.</div>` : ''}

      <div class="pay-breakdown">
        <div class="pay-row"><span>שכר משעות עבודה</span><span class="mono">${fmtMoney(calc.hoursGross)}</span></div>
        ${calc.additionAmounts.filter(a=>a.amount>0).length ? `<div class="additions-list">
          ${calc.additionAmounts.filter(a=>a.amount>0).map(a => `<div class="pay-row"><span>${escapeHtml(a.name)}</span><span class="mono addition">+${fmtMoney(a.amount)}</span></div>`).join('')}
        </div>` : ''}
        <div class="pay-row subtotal"><span>שכר ברוטו משוער</span><span class="mono">${fmtMoney(calc.gross)}</span></div>
        <div class="deductions-list">
          ${calc.deductionAmounts.map(d => `<div class="pay-row"><span>${escapeHtml(d.name)} (${d.percent}%)</span><span class="mono">-${fmtMoney(d.amount)}</span></div>`).join('')}
        </div>
        <div class="pay-row net"><span>שכר נטו משוער</span><span class="mono">${fmtMoney(calc.net)}</span></div>
      </div>
    </section>
    </div>

    <div class="tab-panel" data-panel="shifts" ${activeTab!=='shifts' ? 'hidden' : ''}>
    <section class="month-select">
      <button id="prevMonth" aria-label="חודש קודם">‹</button>
      <span id="monthLabel">${HE_MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}</span>
      <button id="nextMonth" aria-label="חודש הבא">›</button>
    </section>

    <section class="add-entry">
      <h2>הוספת / עדכון יום עבודה</h2>
      <form id="entryForm">
        <label>תאריך <input type="date" id="entryDate" value="${todayStr()}"></label>
        <label>הפסקה (דק') <input type="number" id="entryBreak" value="0" min="0"></label>
        <label>שעת כניסה <input type="time" id="entryIn"></label>
        <label>שעת יציאה <input type="time" id="entryOut"></label>
        <button type="submit">שמור יום</button>
      </form>
    </section>

    <section class="entries-list">
      <div class="list-header">
        <h2>המשמרות שלי</h2>
        <div class="list-header-actions">
          <button type="button" id="exportExcelBtn" class="export-btn" title="ייצוא החודש הנוכחי לאקסל">📊 החודש</button>
          <button type="button" id="exportAllBtn" class="export-btn" title="ייצוא כל ההיסטוריה לאקסל">🗂️ הכל</button>
          <div class="view-toggle">
            <button type="button" data-view="calendar" class="${viewMode==='calendar'?'active':''}">לוח</button>
            <button type="button" data-view="list" class="${viewMode==='list'?'active':''}">רשימה</button>
          </div>
        </div>
      </div>
      <div id="entriesContainer">
        ${dates.length === 0 ? `<div class="empty-state">עדיין לא נרשמו ימי עבודה בחודש זה.<br>הוסיפו יום למעלה כדי להתחיל.</div>` : (viewMode === 'calendar' ? buildCalendar(calc) : buildList(dates, calc))}
      </div>
    </section>
    </div>
  `;

  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('#prevMonth').addEventListener('click', () => changeMonth(-1));
  $('#nextMonth').addEventListener('click', () => changeMonth(1));
  $('#entryForm').addEventListener('submit', onAddEntry);
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      viewMode = btn.dataset.view;
      updateEntriesView(calc);
    });
  });
  const exportBtn = document.getElementById('exportExcelBtn');
  if(exportBtn) exportBtn.addEventListener('click', () => exportMonthToExcel(calc));
  const exportAllBtn = document.getElementById('exportAllBtn');
  if(exportAllBtn) exportAllBtn.addEventListener('click', () => exportAllHistoryToExcel());
  wireEntryInteractions();
  wireShiftWidget();
  tickShiftTimer();
}

function switchTab(tab){
  if(tab !== 'today' && tab !== 'shifts') return;
  activeTab = tab;
  document.querySelectorAll('[data-tab]').forEach(btn => {
    const selected = btn.dataset.tab === tab;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  document.querySelectorAll('[data-panel]').forEach(panel => {
    panel.hidden = panel.dataset.panel !== tab;
  });
}

function updateEntriesView(calc = computeMonth()){
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewMode);
  });
  const container = document.getElementById('entriesContainer');
  if(!container) return;
  const dates = Object.keys(monthData.days).sort().reverse();
  container.innerHTML = dates.length === 0
    ? `<div class="empty-state">עדיין לא נרשמו ימי עבודה בחודש זה.<br>הוסיפו יום למעלה כדי להתחיל.</div>`
    : (viewMode === 'calendar' ? buildCalendar(calc) : buildList(dates, calc));
  wireEntryInteractions();
}

function wireShiftWidget(){
  const inBtn = document.getElementById('clockInBtn');
  const startBreakBtn = document.getElementById('startBreakBtn');
  const endBreakBtn = document.getElementById('endBreakBtn');
  const outBtn = document.getElementById('clockOutBtn');
  if(inBtn) attachLongPress(inBtn, clockIn);
  if(startBreakBtn) attachLongPress(startBreakBtn, startBreak);
  if(endBreakBtn) attachLongPress(endBreakBtn, endBreak);
  if(outBtn) attachLongPress(outBtn, clockOut);
}

function attachLongPress(el, callback, duration=650){
  let timer = null;
  const fill = el.querySelector('.lp-fill');

  function start(ev){
    ev.preventDefault();
    el.classList.add('pressing');
    if(fill){
      fill.style.transition = 'none';
      fill.style.width = '0%';
      // force reflow so the next transition actually animates from 0
      void fill.offsetWidth;
      fill.style.transition = `width ${duration}ms linear`;
      fill.style.width = '100%';
    }
    timer = setTimeout(() => {
      el.classList.remove('pressing');
      if(navigator.vibrate) navigator.vibrate(12);
      callback();
    }, duration);
  }

  function cancel(){
    clearTimeout(timer);
    el.classList.remove('pressing');
    if(fill){
      fill.style.transition = 'width .15s ease-out';
      fill.style.width = '0%';
    }
  }

  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', ev => ev.preventDefault());
}

function fillFormForDate(date){
  const e = monthData.days[date];
  $('#entryDate').value = date;
  if(e){
    $('#entryIn').value = e.in;
    $('#entryOut').value = e.out;
    $('#entryBreak').value = e.brk;
  } else {
    $('#entryIn').value = '';
    $('#entryOut').value = '';
    $('#entryBreak').value = 0;
  }
  window.scrollTo({top:0,behavior:'smooth'});
}

function wireEntryInteractions(){
  document.querySelectorAll('.entry-row').forEach(row => {
    row.addEventListener('click', (ev) => {
      if(ev.target.closest('.entry-del')) return;
      fillFormForDate(row.dataset.date);
    });
  });
  document.querySelectorAll('.cal-cell[data-date]').forEach(cell => {
    cell.addEventListener('click', () => fillFormForDate(cell.dataset.date));
  });
  document.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const date = btn.dataset.del;
      delete monthData.days[date];
      await saveMonth(currentDate);
      render();
      showToast('היום נמחק');
    });
  });
}

function buildList(dates, calc){
  return dates.map(date => {
    const h = calc.perDay[date];
    const e = monthData.days[date];
    const day = date.split('-')[2];
    return `<div class="entry-row" data-date="${date}">
      <div class="entry-row-top">
        <div class="entry-main">
          <div class="entry-date">${day}.${String(currentDate.getMonth()+1).padStart(2,'0')}</div>
          <div class="entry-time">${e.in}–${e.out}${e.brk>0?` · הפסקה ${e.brk} ד׳${h.excessBreakMin>0?` <span class="break-flag">(-${Math.round(h.excessBreakMin)} ד׳)</span>`:''}`:''}</div>
        </div>
        <div class="entry-pay mono">${fmtMoney(h.pay)}</div>
        <button class="entry-del" data-del="${date}" aria-label="מחק">✕</button>
      </div>
      <div class="entry-chips">
        ${h.regular>0?`<span class="chip regular">${fmtHours(h.regular)}</span>`:''}
        ${h.ot125>0?`<span class="chip ot125">${fmtHours(h.ot125)}</span>`:''}
        ${h.ot150>0?`<span class="chip ot150">${fmtHours(h.ot150)}</span>`:''}
      </div>
    </div>`;
  }).join('');
}

function buildCalendar(calc){
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const todayString = todayStr();
  const weekdayLabels = ['א','ב','ג','ד','ה','ו','ש'];

  let cells = '';
  for(let i=0;i<firstWeekday;i++){
    cells += `<div class="cal-cell empty-cell"></div>`;
  }
  for(let d=1; d<=daysInMonth; d++){
    const date = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const e = monthData.days[date];
    const h = calc.perDay[date];
    const hasEntry = !!e;
    const isToday = date === todayString;
    let cls = 'cal-cell';
    if(hasEntry) cls += ' has-entry';
    if(isToday) cls += ' today';
    cells += `<div class="${cls}" data-date="${date}">
      <span class="cal-day-num">${d}</span>
      ${hasEntry ? `
        <div class="cal-bar">
          ${h.regular>0?`<span style="flex:${h.regular};background:var(--teal)"></span>`:''}
          ${h.ot125>0?`<span style="flex:${h.ot125};background:var(--amber)"></span>`:''}
          ${h.ot150>0?`<span style="flex:${h.ot150};background:var(--rust)"></span>`:''}
        </div>
        <span class="cal-hours">${fmtHours(h.total)}</span>
      ` : ''}
    </div>`;
  }

  return `
    <div class="cal-weekdays">${weekdayLabels.map(l=>`<span>${l}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
  `;
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function onAddEntry(ev){
  ev.preventDefault();
  const date = $('#entryDate').value;
  const inT = $('#entryIn').value;
  const outT = $('#entryOut').value;
  const brk = Number($('#entryBreak').value)||0;
  if(!date || !inT || !outT){ showToast('נא למלא את כל השדות'); return; }
  if(timeToMinutes(outT) <= timeToMinutes(inT)){ showToast('שעת היציאה חייבת להיות אחרי הכניסה'); return; }

  const dMonthKey = date.slice(0,7);
  if(dMonthKey !== monthKey(currentDate)){
    // entry belongs to a different month than currently viewed — switch to it
    currentDate = new Date(date+'T00:00:00');
    await loadMonth(currentDate);
  }
  monthData.days[date] = { in: inT, out: outT, brk };
  await saveMonth(currentDate);
  render();
  showToast('היום נשמר');
  checkCapWarning();
}

async function changeMonth(delta){
  currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth()+delta, 1);
  showDataLoader();
  try{
    await loadMonth(currentDate);
    render();
  }finally{
    hideDataLoader();
  }
}

// ---- settings drawer ----
function renderDeductionRows(){
  const wrap = $('#deductionsSettings');
  wrap.innerHTML = settings.deductions.map((d,i) => `
    <div class="deduction-row" data-idx="${i}">
      <input type="text" value="${escapeHtml(d.name)}" data-field="name">
      <input type="number" value="${d.percent}" step="0.1" data-field="percent">
      <button type="button" data-remove="${i}">✕</button>
    </div>
  `).join('');
  wrap.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.deductions.splice(Number(btn.dataset.remove),1);
      renderDeductionRows();
    });
  });
}

function renderAdditionRows(){
  const wrap = $('#additionsSettings');
  wrap.innerHTML = settings.additions.map((a,i) => `
    <div class="deduction-row" data-idx="${i}">
      <input type="text" value="${escapeHtml(a.name)}" data-field="name">
      <input type="number" value="${a.amount}" step="1" data-field="amount">
      <button type="button" data-remove="${i}">✕</button>
    </div>
  `).join('');
  wrap.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.additions.splice(Number(btn.dataset.remove),1);
      renderAdditionRows();
    });
  });
}

function updateThemeButtonsUI(){
  document.querySelectorAll('.theme-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === settings.themeMode);
  });
  document.querySelectorAll('.accent-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.accent === settings.accentColor);
  });
}

function openSettings(){
  $('#setRate').value = settings.hourlyRate;
  $('#setRegularHours').value = settings.regularHours;
  $('#setOt125Hours').value = settings.ot125Hours;
  $('#setMonthlyCap').value = settings.monthlyCap;
  $('#setFreeBreak').value = settings.freeBreakMinutes;
  $('#setCapWarnHours').value = settings.capWarnHours;
  updateThemeButtonsUI();
  renderDeductionRows();
  renderAdditionRows();
  refreshPushStatusUI();
  const overlay = $('#drawerOverlay');
  overlay.classList.add('pre-open');
  overlay.hidden = false;
  requestAnimationFrame(() => {
    document.body.classList.add('settings-open');
    overlay.classList.remove('pre-open');
    $('#settingsDrawer').classList.add('open');
  });
}
function closeSettings(){
  $('#settingsDrawer').classList.remove('open');
  document.body.classList.remove('settings-open');
  window.setTimeout(() => {
    if(!$('#settingsDrawer').classList.contains('open')) $('#drawerOverlay').hidden = true;
  }, 360);
}

document.querySelectorAll('.theme-mode-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    settings.themeMode = btn.dataset.mode;
    applyTheme();
    updateThemeButtonsUI();
    await kvSet('settings', settings);
  });
});
document.querySelectorAll('.accent-swatch').forEach(btn => {
  btn.addEventListener('click', async () => {
    settings.accentColor = btn.dataset.accent;
    applyTheme();
    updateThemeButtonsUI();
    await kvSet('settings', settings);
  });
});

$('#pushToggleBtn').addEventListener('click', async () => {
  const sub = await getCurrentPushSubscription();
  if(sub){
    await unsubscribeFromPush();
  } else {
    await subscribeToPush();
  }
});

$('#settingsToggle').addEventListener('click', () => { softHaptic(); openSettings(); });
$('#settingsClose').addEventListener('click', closeSettings);
$('#drawerOverlay').addEventListener('click', closeSettings);
document.addEventListener('keydown', (ev) => {
  if(ev.key === 'Escape' && $('#settingsDrawer').classList.contains('open')) closeSettings();
});
$('#addDeduction').addEventListener('click', () => {
  settings.deductions.push({ id: 'd'+Date.now(), name:'רכיב חדש', percent:0 });
  renderDeductionRows();
});
$('#addAddition').addEventListener('click', () => {
  settings.additions.push({ id: 'a'+Date.now(), name:'תוספת חדשה', amount:0 });
  renderAdditionRows();
});
$('#saveSettings').addEventListener('click', async () => {
  settings.hourlyRate = Number($('#setRate').value) || 0;
  settings.regularHours = Number($('#setRegularHours').value) || 0;
  settings.ot125Hours = Number($('#setOt125Hours').value) || 0;
  settings.monthlyCap = Number($('#setMonthlyCap').value) || 0;
  settings.freeBreakMinutes = Number($('#setFreeBreak').value) || 0;
  settings.capWarnHours = Number($('#setCapWarnHours').value) || 0;
  document.querySelectorAll('#deductionsSettings .deduction-row').forEach((row,i) => {
    settings.deductions[i].name = row.querySelector('[data-field="name"]').value || 'רכיב';
    settings.deductions[i].percent = Number(row.querySelector('[data-field="percent"]').value) || 0;
  });
  document.querySelectorAll('#additionsSettings .deduction-row').forEach((row,i) => {
    settings.additions[i].name = row.querySelector('[data-field="name"]').value || 'תוספת';
    settings.additions[i].amount = Number(row.querySelector('[data-field="amount"]').value) || 0;
  });
  await saveSettingsToStorage();
  closeSettings();
  render();
});
$('#resetData').addEventListener('click', async () => {
  if(!confirm('לאפס את כל נתוני הנוכחות והשכר לחודש הנוכחי? פעולה זו לא ניתנת לביטול.')) return;
  monthData = { days:{} };
  await saveMonth(currentDate);
  render();
  showToast('הנתונים אופסו');
});

// ---- auth + startup ----
let authMode = 'signin'; // 'signin' | 'signup'
let appStarted = false;
let shiftTimerInterval = null;
let loaderVisible = true;

function showDataLoader(){
  const el = document.getElementById('initialSplash');
  if(!el) return;
  loaderVisible = true;
  el.classList.remove('leaving');
  el.setAttribute('aria-hidden', 'false');
}

function hideDataLoader(){
  const el = document.getElementById('initialSplash');
  if(!el || !loaderVisible) return;
  loaderVisible = false;
  el.classList.add('leaving');
  el.setAttribute('aria-hidden', 'true');
}

function revealApp(){
  $('#authScreen').style.display = 'none';
  const app = $('#appRoot');
  app.hidden = false;
  app.classList.remove('app-enter');
  void app.offsetWidth;
  app.classList.add('app-enter');
}

function showAuthScreen(){
  $('#authScreen').style.display = 'flex';
  $('#appRoot').hidden = true;
  hideDataLoader();
}

function setAuthError(msg){
  const el = $('#authError');
  if(msg){ el.textContent = msg; el.hidden = false; } else { el.hidden = true; }
}
function setAuthInfo(msg){
  const el = $('#authInfo');
  if(msg){ el.textContent = msg; el.hidden = false; } else { el.hidden = true; }
}

function updateAuthModeUI(){
  $('#authSubmitBtn').textContent = authMode === 'signin' ? 'התחברות' : 'הרשמה';
  $('#authToggleMode').textContent = authMode === 'signin' ? 'אין לך חשבון? הרשמה' : 'כבר יש לך חשבון? התחברות';
  setAuthError(null);
  setAuthInfo(null);
}

$('#authToggleMode').addEventListener('click', () => {
  authMode = authMode === 'signin' ? 'signup' : 'signin';
  updateAuthModeUI();
});

$('#authForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  setAuthError(null);
  setAuthInfo(null);
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const btn = $('#authSubmitBtn');
  btn.disabled = true;
  try{
    if(authMode === 'signin'){
      const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if(error) throw error;
    } else {
      const { data, error } = await supabaseClient.auth.signUp({ email, password });
      if(error) throw error;
      if(!data.session){
        setAuthInfo('נרשמת בהצלחה! בדוק את תיבת המייל שלך כדי לאשר את החשבון, ואז התחבר.');
        authMode = 'signin';
        updateAuthModeUI();
      }
    }
  }catch(e){
    setAuthError(e.message || 'שגיאה, נסה שוב');
  }finally{
    btn.disabled = false;
  }
});

$('#signOutBtn').addEventListener('click', async () => {
  await supabaseClient.auth.signOut();
});

function startShiftTicker(){
  clearInterval(shiftTimerInterval);
  shiftTimerInterval = setInterval(tickShiftTimer, 30000);
  checkCapWarning();
}

function showReadyApp(){
  revealApp();
  render();
  startShiftTicker();
}

async function startApp(session){
  const userId = session?.user?.id;
  if(!userId) return;
  if(appStarted && currentUserId === userId) return;

  appStarted = true;
  currentUserId = userId;
  registerServiceWorker(); // non-blocking

  // One startup path only:
  // 1) Cache exists -> render immediately, no loading animation, revalidate silently.
  // 2) No cache -> keep the one loader visible until Supabase returns.
  const hadCache = readInitialCache(userId);
  if(hadCache){
    showReadyApp();
    hideDataLoader();

    try{
      await loadInitialData(userId);
      render();
    }catch(e){
      console.error('background refresh failed', e);
    }
    return;
  }

  showDataLoader();
  try{
    await loadInitialData(userId);
    showReadyApp();
  }catch(e){
    console.error('startApp error', e);
    settings = normalizeSettings(settings);
    showReadyApp();
    showToast('לא הצלחנו לטעון את הנתונים. נסה לרענן.');
  }finally{
    hideDataLoader();
  }
}

function resetSignedOutState(){
  currentUserId = null;
  appStarted = false;
  settings = null;
  monthData = { days:{} };
  activeSession = null;
  clearInterval(shiftTimerInterval);
  shiftTimerInterval = null;
  showAuthScreen();
}

document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible' && appStarted) tickShiftTimer();
});

async function bootstrap(){
  updateAuthModeUI();
  showDataLoader();

  const { data: { session }, error } = await supabaseClient.auth.getSession();
  if(error) console.error('getSession error', error);

  if(session) await startApp(session);
  else resetSignedOutState();

  supabaseClient.auth.onAuthStateChange((event, nextSession) => {
    if(event === 'INITIAL_SESSION') return;
    if(!nextSession) return resetSignedOutState();
    void startApp(nextSession);
  });
}

void bootstrap();
