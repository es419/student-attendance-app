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
    s.src = 'vendor/xlsx.full.min.js';
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
  sickDayHours: 0,
  ot125Hours: 2,
  monthlyCap: 120,
  freeBreakMinutes: 40,
  capWarnHours: 10,
  attendanceRemindersEnabled: true,
  checkOutReminderTime: '16:00',
  checkOutRepeatMinutes: 30,
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
let monthData = { days: {} }; // { "YYYY-MM-DD": { type, in, out, brk } }
let payslipActual = { gross: null, net: null };
let viewMode = 'list'; // 'calendar' | 'list'
let activeTab = 'today'; // 'today' | 'shifts'
let payslipOpen = false;
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
    payslipActual = normalizePayslip(cached.payslipActual);
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
      settings, monthData, payslipActual, activeSession, cachedAt: Date.now()
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
function showToast(msg, opts = {}){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('has-action', !!opts.action);
  if(opts.action){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = opts.action.label;
    b.addEventListener('click', () => {
      clearTimeout(toastTimer);
      t.classList.remove('show');
      opts.action.onClick();
    });
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), opts.duration || (opts.action ? 6000 : 2200));
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
    refreshAttendanceReminderSchedule();
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

const ATTENDANCE_REMINDER_MESSAGES = {
  checkIn: 'לא שכחת להחתים כניסה?',
  checkOut: 'לא שכחת להחתים יציאה?',
  checkOutRepeat: 'עדיין לא החתמת יציאה'
};

function parseClockTime(value, fallback){
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if(!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if(hour > 23 || minute > 59) return fallback;
  return { hour, minute };
}

async function hasPushSubscription(){
  return !!(await getCurrentPushSubscription());
}

async function cancelAttendanceReminderMessages(messages){
  if(!currentUserId || !messages.length) return;
  try{
    await supabaseClient
      .from('break_reminders')
      .delete()
      .eq('user_id', currentUserId)
      .eq('sent', false)
      .in('message', messages);
  }catch(e){
    console.error('cancelAttendanceReminderMessages failed', e);
  }
}

async function scheduleCheckInReminders(){
  if(!currentUserId) return;
  // Check-in reminders are disabled. Remove any unsent reminders left by older app versions.
  await cancelAttendanceReminderMessages([ATTENDANCE_REMINDER_MESSAGES.checkIn]);
}

async function scheduleCheckOutReminders(){
  if(!currentUserId) return;
  await cancelAttendanceReminderMessages([
    ATTENDANCE_REMINDER_MESSAGES.checkOut,
    ATTENDANCE_REMINDER_MESSAGES.checkOutRepeat
  ]);
  if(!settings.attendanceRemindersEnabled || !activeSession || !(await hasPushSubscription())) return;

  const clock = parseClockTime(settings.checkOutReminderTime, { hour:16, minute:0 });
  const [year, month, day] = activeSession.date.split('-').map(Number);
  const first = new Date(year, month - 1, day, clock.hour, clock.minute, 0, 0);
  const repeatMinutes = Math.max(0, Number(settings.checkOutRepeatMinutes) || 0);
  const rows = [];

  if(first.getTime() > Date.now()){
    rows.push({
      user_id: currentUserId,
      fire_at: first.toISOString(),
      message: ATTENDANCE_REMINDER_MESSAGES.checkOut
    });
  }
  if(repeatMinutes > 0){
    const second = new Date(first.getTime() + repeatMinutes * 60000);
    if(second.getTime() > Date.now()){
      rows.push({
        user_id: currentUserId,
        fire_at: second.toISOString(),
        message: ATTENDANCE_REMINDER_MESSAGES.checkOutRepeat
      });
    }
  }
  if(rows.length){
    const { error } = await supabaseClient.from('break_reminders').insert(rows);
    if(error) throw error;
  }
}

async function refreshAttendanceReminderSchedule(){
  try{
    await scheduleCheckInReminders();
    if(activeSession) await scheduleCheckOutReminders();
  }catch(e){
    console.error('refreshAttendanceReminderSchedule failed', e);
  }
}

// ---- monthly hour-cap proximity warning ----
// Reuses the same break_reminders table + cron/Edge Function — just fires immediately (fire_at = now)
// instead of being scheduled ahead of time. Only ever sent once per calendar month.
async function checkCapWarningOnce(){
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

let capWarningBusy = false;
async function checkCapWarning(){
  if(capWarningBusy) return; // ticker + clock-out can fire together; warn once
  capWarningBusy = true;
  try{ await checkCapWarningOnce(); } finally{ capWarningBusy = false; }
}

function deepClone(obj){
  return JSON.parse(JSON.stringify(obj));
}

function normalizeSettings(saved = null){
  const merged = { ...deepClone(DEFAULT_SETTINGS), ...(saved || {}) };
  if(!Number.isFinite(Number(merged.sickDayHours)) || Number(merged.sickDayHours) < 0) merged.sickDayHours = 0;
  if(!Array.isArray(merged.deductions)) merged.deductions = deepClone(DEFAULT_SETTINGS.deductions);
  if(!Array.isArray(merged.additions)) merged.additions = deepClone(DEFAULT_SETTINGS.additions);
  return merged;
}

function normalizePayslip(value = null){
  const amount = raw => raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0 ? null : Number(raw);
  return { gross: amount(value?.gross), net: amount(value?.net) };
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

async function kvGetStrict(key){
  const userId = currentUserId;
  if(!userId) throw new Error('No authenticated user');
  const { data, error } = await supabaseClient
    .from('kv_store')
    .select('value')
    .eq('user_id', userId)
    .eq('key', key)
    .maybeSingle();
  if(error) throw error;
  return data ? data.value : null;
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
    if(!userId) return false;
    const { error } = await supabaseClient.from('kv_store').delete().eq('user_id', userId).eq('key', key);
    if(error) throw error;
    return true;
  }catch(e){
    console.error('kvDelete error', e);
    return false;
  }
}

// ---- Telegram companion ----
function makeTelegramLinkCode(){
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

async function getTelegramLink(){
  if(!currentUserId) return null;
  try{
    const { data, error } = await supabaseClient
      .from('telegram_links')
      .select('telegram_username,telegram_first_name,linked_at')
      .eq('user_id', currentUserId)
      .maybeSingle();
    if(error) throw error;
    return data || null;
  }catch(e){
    console.error('getTelegramLink error', e);
    return null;
  }
}

async function refreshTelegramUI(){
  const status = $('#telegramStatusText');
  const connectBtn = $('#telegramConnectBtn');
  const disconnectBtn = $('#telegramDisconnectBtn');
  const box = $('#telegramLinkBox');
  if(!status || !connectBtn || !disconnectBtn || !box) return;

  status.textContent = 'בודק סטטוס…';
  try{
    const link = await getTelegramLink();
    if(link){
      const name = link.telegram_username ? `@${link.telegram_username}` : (link.telegram_first_name || 'חשבון Telegram');
      status.textContent = `Telegram מחובר: ${name} ✓`;
      status.className = 'push-status on';
      connectBtn.hidden = true;
      disconnectBtn.hidden = false;
      box.hidden = true;
    }else{
      status.textContent = 'Telegram עדיין לא מחובר';
      status.className = 'push-status off';
      connectBtn.hidden = false;
      disconnectBtn.hidden = true;
    }
  }catch(e){
    status.textContent = 'לא ניתן לבדוק את חיבור Telegram';
    status.className = 'push-status blocked';
  }
}

async function createTelegramLinkCode(){
  if(!currentUserId){
    showToast('החיבור לחשבון עדיין לא מוכן. סגור ופתח את האפליקציה ונסה שוב.');
    return;
  }

  const button = $('#telegramConnectBtn');
  if(button) button.disabled = true;
  const code = makeTelegramLinkCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  try{
    const { error } = await supabaseClient.from('telegram_link_codes').upsert({
      user_id: currentUserId,
      code,
      expires_at: expiresAt,
      created_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if(error) throw error;
    $('#telegramLinkCommand').textContent = `/link ${code}`;
    $('#telegramLinkBox').hidden = false;
    showToast('קוד חיבור נוצר ל-10 דקות');
  }catch(e){
    console.error('createTelegramLinkCode error', e);
    showToast('לא הצלחנו ליצור קוד. ודא שהעדכון ב-Supabase הותקן.');
  }finally{
    if(button) button.disabled = false;
  }
}

async function disconnectTelegram(){
  if(!currentUserId) return;
  try{
    const { error } = await supabaseClient.from('telegram_links').delete().eq('user_id', currentUserId);
    if(error) throw error;
    $('#telegramLinkBox').hidden = true;
    showToast('Telegram נותק');
    await refreshTelegramUI();
  }catch(e){
    console.error('disconnectTelegram error', e);
    showToast('שגיאה בניתוק Telegram');
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
  const mk = monthKey(d);
  // strict reads: a network error must not look like an empty month
  const [saved, savedPayslip] = await Promise.all([kvGetStrict(`attendance:${mk}`), kvGetStrict(`payslip:${mk}`)]);
  monthData = saved || { days:{} };
  payslipActual = normalizePayslip(savedPayslip);
}

// Read-modify-write against the freshest server copy, so an edit made from another
// device or the Telegram bot is never overwritten by a stale local snapshot.
async function mutateMonth(mk, mutator){
  const key = `attendance:${mk}`;
  const latest = (await kvGetStrict(key)) || { days:{} };
  if(!latest.days || typeof latest.days !== 'object') latest.days = {};
  mutator(latest);
  const ok = await kvSet(key, latest);
  if(!ok) throw new Error('failed to save month');
  if(mk === monthKey(currentDate)){
    monthData = latest;
    writeInitialCache(currentUserId);
  }
  return latest;
}

// ---- active shift (quick clock in/out + break) ----
// One initial network request: settings + current month + active shift.
async function loadInitialData(userId = currentUserId){
  if(!userId) throw new Error('No authenticated user');

  const monthDataKey = `attendance:${monthKey(currentDate)}`;
  const payslipKey = `payslip:${monthKey(currentDate)}`;
  const { data: rows, error } = await supabaseClient
    .from('kv_store')
    .select('key, value')
    .eq('user_id', userId)
    .in('key', ['settings', monthDataKey, payslipKey, 'activeSession']);

  if(error) throw error;

  const byKey = Object.fromEntries((rows || []).map(row => [row.key, row.value]));
  settings = normalizeSettings(byKey.settings);

  monthData = byKey[monthDataKey] || { days:{} };
  payslipActual = normalizePayslip(byKey[payslipKey]);
  activeSession = byKey.activeSession || null;
  applyTheme();
  writeInitialCache(userId);
}

async function saveActiveSession(){
  writeInitialCache(currentUserId);
  if(activeSession){
    const ok = await kvSet('activeSession', activeSession);
    if(!ok) showToast('שגיאה בשמירת סטטוס המשמרת');
    return ok;
  }
  const ok = await kvDelete('activeSession');
  if(!ok) showToast('שגיאה בסגירת המשמרת. רענן ונסה שוב');
  return ok;
}

function isOnBreak(){
  if(!activeSession || activeSession.breaks.length === 0) return false;
  const last = activeSession.breaks[activeSession.breaks.length-1];
  return !last.end;
}

let shiftActionBusy = false;
let editorResolvesSession = false; // the entry editor is being used to close a forgotten shift

async function syncActiveSessionFromCloud(){
  const userId = currentUserId;
  if(!userId) throw new Error('No authenticated user');
  const { data, error } = await supabaseClient
    .from('kv_store')
    .select('value')
    .eq('user_id', userId)
    .eq('key', 'activeSession')
    .maybeSingle();
  if(error) throw error;
  activeSession = data ? data.value : null;
  writeInitialCache(userId);
}

async function runShiftAction(action){
  if(shiftActionBusy) return;
  shiftActionBusy = true;
  // Capture the moment of the press now: the network round-trips below must never
  // move the recorded time.
  const stamp = { time: nowTimeStr(), date: todayStr(), at: Date.now() };
  try{
    // Telegram and another device can change the shift while this PWA is asleep.
    // Re-read the authoritative active session before every attendance mutation.
    await syncActiveSessionFromCloud();
    await action(stamp);
  }catch(e){
    console.error('shift action failed', e);
    showToast('הפעולה לא נשמרה. בדוק חיבור ונסה שוב.');
    render();
  }finally{
    shiftActionBusy = false;
  }
}

// Ends the running shift: cancels its pending reminders and removes it from the cloud.
async function closeActiveSession(session){
  await cancelAttendanceReminderMessages([
    ATTENDANCE_REMINDER_MESSAGES.checkOut,
    ATTENDANCE_REMINDER_MESSAGES.checkOutRepeat
  ]);
  for(const b of (session.breaks || [])) await cancelBreakReminder(b.reminderId);
  activeSession = null;
  return saveActiveSession();
}

async function clockIn(){
  return runShiftAction(async (stamp) => {
    if(activeSession){
      render();
      showToast('כבר קיימת משמרת פעילה');
      return;
    }
    activeSession = { date: stamp.date, checkIn: stamp.time, breaks: [] };
    if(!(await saveActiveSession())){ activeSession = null; render(); return; }
    try{
      await cancelAttendanceReminderMessages([ATTENDANCE_REMINDER_MESSAGES.checkIn]);
      await scheduleCheckOutReminders();
    }catch(e){ console.error('reminders failed', e); } // reminders are best-effort
    render();
    showToast('המשמרת התחילה — בהצלחה!');
  });
}

async function startBreak(){
  return runShiftAction(async (stamp) => {
    if(!activeSession){ render(); showToast('אין משמרת פעילה'); return; }
    if(isOnBreak()){ render(); showToast('אתה כבר בהפסקה'); return; }
    activeSession.breaks.push({ start: stamp.time, end: null });
    if(!(await saveActiveSession())){ activeSession.breaks.pop(); render(); return; }
    render();
    showToast('יצאת להפסקה');
    // schedule a push reminder for 10 minutes before the free break allowance runs out
    const reminderId = await scheduleBreakReminder();
    if(reminderId){
      activeSession.breaks[activeSession.breaks.length-1].reminderId = reminderId;
      await saveActiveSession();
    }
  });
}

async function endBreak(){
  return runShiftAction(async (stamp) => {
    if(!activeSession){ render(); showToast('אין משמרת פעילה'); return; }
    if(!isOnBreak()){ render(); showToast('אתה לא בהפסקה כרגע'); return; }
    const lastBreak = activeSession.breaks[activeSession.breaks.length-1];
    lastBreak.end = stamp.time;
    if(!(await saveActiveSession())){ lastBreak.end = null; render(); return; }
    await cancelBreakReminder(lastBreak.reminderId);
    render();
    showToast('חזרת מהפסקה');
  });
}

async function clockOut(){
  return runShiftAction(async (stamp) => {
    if(!activeSession){ render(); showToast('אין משמרת פעילה'); return; }
    if(AttendanceCalc.isStaleSession(activeSession, stamp.at)){
      // Almost certainly a forgotten clock-out: never guess the end time.
      render();
      showToast('המשמרת פתוחה מעל 16 שעות — הזן שעת יציאה');
      openStaleSessionEditor();
      return;
    }
    const { date, checkIn } = activeSession;
    const checkOut = stamp.time;
    const breaks = activeSession.breaks.map(b => ({ ...b }));
    const lastBreak = breaks[breaks.length - 1];
    if(lastBreak && !lastBreak.end) lastBreak.end = checkOut;
    const totalBreakMin = AttendanceCalc.sessionBreakMinutes({ breaks });

    if(AttendanceCalc.minutesBetween(checkIn, checkOut) === 0){
      // in and out within the same minute: an accidental tap, not a shift
      await closeActiveSession(activeSession);
      render();
      showToast('המשמרת נמשכה פחות מדקה ולא נשמרה');
      return;
    }

    // Save the day first; only then close the running shift. If the save fails the
    // shift stays open and nothing is lost. A shift that crosses midnight is kept.
    const mk = date.slice(0, 7);
    const latest = await mutateMonth(mk, m => { m.days[date] = { in: checkIn, out: checkOut, brk: totalBreakMin }; });
    await closeActiveSession(activeSession);

    if(mk !== monthKey(currentDate)){
      currentDate = new Date(date + 'T00:00:00');
      try{ await loadMonth(currentDate); }catch(e){ monthData = latest; }
    }
    render();
    showToast('המשמרת הסתיימה ונשמרה');
    checkCapWarning();
  });
}

async function discardStaleSession(){
  return runShiftAction(async () => {
    if(!activeSession){ render(); return; }
    await closeActiveSession(activeSession);
    render();
    showToast('המשמרת בוטלה');
  });
}

function openStaleSessionEditor(){
  if(!activeSession) return;
  switchTab('shifts');
  const closedBreaks = AttendanceCalc.sessionBreakMinutes({ breaks: (activeSession.breaks || []).filter(b => b.end) });
  openEntryEditor(null, { date: activeSession.date, in: activeSession.checkIn, out: '', brk: closedBreaks, resolvesSession: true });
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
  if(AttendanceCalc.isStaleSession(activeSession, Date.now())){
    const since = `${activeSession.date.slice(8,10)}.${activeSession.date.slice(5,7)} ${activeSession.checkIn}`;
    return `
      <section class="shift-widget stale">
        <div class="shift-status">⚠️ משמרת פתוחה מאז ${since}</div>
        <p class="stale-text">נראה ששכחת להחתים יציאה. הזן את שעת היציאה האמיתית או בטל את המשמרת.</p>
        <div class="shift-actions">
          <button id="resolveStaleBtn" class="shift-btn" type="button">✏️ הזן יציאה</button>
          ${lpButton('discardStaleBtn','secondary','🗑️ בטל משמרת')}
        </div>
        <p class="lp-hint">ביטול משמרת דורש לחיצה ארוכה</p>
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
  if(activeSession && AttendanceCalc.isStaleSession(activeSession, Date.now()) && !document.getElementById('resolveStaleBtn')){
    renderUnlessEditing(); // the shift just crossed the limit while the app was open
    return;
  }
  const el = document.getElementById('shiftElapsed');
  if(!el || !activeSession || isOnBreak()) return;
  const diffMin = AttendanceCalc.netElapsedMinutes(activeSession, Date.now());
  el.textContent = `· חלפו ${Math.floor(diffMin/60)}ש׳ ${diffMin % 60}ד׳`;
}

// ---- calculation (pure logic lives in calc.js) ----
function computeMonth(monthDataArg){ return AttendanceCalc.computeMonth(monthDataArg || monthData, settings); }

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
const SHIFT_HEADER = ['תאריך','כניסה','יציאה','הפסקה (דק\')','חריגת הפסקה (דק\')','שעות רגילות','שעות 125%','שעות 150%','סה"כ שעות','סוג יום'];
function shiftSheetRows(md, calc){
  const dates = Object.keys(md.days || {}).sort();
  const rows = dates.map(date => {
    const e = md.days[date];
    const h = calc.perDay[date];
    return [
      date, e.in || '', e.out || '', e.brk || 0, Math.round(h.excessBreakMin),
      Number(h.regular.toFixed(2)), Number(h.ot125.toFixed(2)), Number(h.ot150.toFixed(2)),
      Number(h.total.toFixed(2)), e.type === 'sick' ? 'מחלה' : 'עבודה'
    ];
  });
  const totals = [
    'סה"כ', '', '', '', Math.round(calc.excessBreakMinTotal),
    Number(calc.paidRegular.toFixed(2)), Number(calc.paidOt125.toFixed(2)), Number(calc.paidOt150.toFixed(2)),
    Number(calc.rawTotal.toFixed(2)), ''
  ];
  return [SHIFT_HEADER, ...rows, [], totals];
}

function fmtHours(h){ return h.toLocaleString('he-IL',{minimumFractionDigits:1,maximumFractionDigits:1}); }
function fmtMoney(n){ return '₪' + n.toLocaleString('he-IL',{minimumFractionDigits:0,maximumFractionDigits:0}); }
function fmtMoneyDiff(n){ return `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtMoney(Math.abs(n))}`; }
function payslipDiff(actual, estimated){
  if(actual === null) return '<span class="comparison-missing">לא הוזן</span>';
  const delta = actual - estimated;
  const label = delta === 0 ? 'תואם' : `${fmtMoneyDiff(delta)} ${delta > 0 ? 'מעל' : 'מתחת'} לאומדן`;
  return `<span class="comparison-diff ${delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'equal'}">${label}</span>`;
}
function buildPayslipCard(calc){
  const actual = normalizePayslip(payslipActual);
  return `<details class="payslip-card" id="payslipDetails" ${payslipOpen ? 'open' : ''}>
    <summary class="payslip-head"><div><h2>השוואה לתלוש</h2><p>${HE_MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}</p></div></summary>
    <div class="payslip-inputs">
      <label>ברוטו בתלוש (₪)<input id="actualPayslipGross" type="number" min="0" step="0.01" inputmode="decimal" value="${actual.gross ?? ''}" placeholder="לא הוזן"></label>
      <label>נטו בתלוש (₪)<input id="actualPayslipNet" type="number" min="0" step="0.01" inputmode="decimal" value="${actual.net ?? ''}" placeholder="לא הוזן"></label>
    </div>
    <div class="payslip-table" aria-label="פער בין האומדן לתלוש">
      <div class="payslip-row payslip-row-head"><span>רכיב</span><span>אומדן</span><span>תלוש</span><span>פער</span></div>
      <div class="payslip-row"><strong>ברוטו</strong><span>${fmtMoney(calc.gross)}</span><span>${actual.gross === null ? '—' : fmtMoney(actual.gross)}</span>${payslipDiff(actual.gross,calc.gross)}</div>
      <div class="payslip-row"><strong>נטו</strong><span>${fmtMoney(calc.net)}</span><span>${actual.net === null ? '—' : fmtMoney(actual.net)}</span>${payslipDiff(actual.net,calc.net)}</div>
    </div>
    <div class="payslip-actions"><button type="button" id="savePayslipBtn">שמור השוואה</button><button type="button" id="clearPayslipBtn" class="payslip-clear">נקה</button></div>
  </details>`;
}

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

  const shiftsSheet = XLSX.utils.aoa_to_sheet(shiftSheetRows(monthData, calc));
  shiftsSheet['!cols'] = SHIFT_HEADER.map(() => ({ wch: 15 }));
  shiftsSheet['!views'] = [{ rightToLeft: true }];

  const summaryRows = [
    ['סיכום שכר', `${HE_MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}`],
    [],
    ['שכר שעתי', settings.hourlyRate],
    ['ימי מחלה', calc.sickDays],
    ['שעות מחלה (ששולמו)', Number(calc.sickHours.toFixed(2))],
    ['שעות רגילות (ששולמו)', Number(calc.paidRegular.toFixed(2))],
    ['שעות 125% (ששולמו)', Number(calc.paidOt125.toFixed(2))],
    ['שעות 150% (ששולמו)', Number(calc.paidOt150.toFixed(2))],
    ['סה"כ שעות בפועל', Number(calc.rawTotal.toFixed(2))],
    ['שעות שלא שולמו (חריגת תקרה)', Number(calc.unpaid.toFixed(2))],
    [],
    ['שכר משעות עבודה ומחלה', Number(calc.hoursGross.toFixed(2))],
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
  const monthlyHeader = ['חודש','ימי מחלה','שעות מחלה','שעות רגילות','שעות 125%','שעות 150%','סה"כ שעות בפועל','שעות לא ששולמו','ברוטו','נטו'];
  const monthlyRows = [];

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
      calc.sickDays,
      Number(calc.sickHours.toFixed(2)),
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

    // this month's own sheet, same shape as the single-month export
    const monthSheet = XLSX.utils.aoa_to_sheet(shiftSheetRows(md, calc));
    monthSheet['!cols'] = SHIFT_HEADER.map(() => ({ wch: 14 }));
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
  monthlyRows.push(['סה"כ הכל', '', '', '', '', '', '', '', Number(grandGross.toFixed(2)), Number(grandNet.toFixed(2))]);

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

// True while the user is typing or has the entry editor open.
function isUserEditing(){
  const overlay = document.getElementById('entryEditorOverlay');
  if(overlay && !overlay.hidden) return true;
  const a = document.activeElement;
  return !!(a && a.closest && a.closest('#mainContent') && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
}
let renderPending = false;
function renderUnlessEditing(){
  if(isUserEditing()){ renderPending = true; return; }
  renderPending = false;
  render();
}
function flushPendingRender(){
  if(renderPending && !isUserEditing()){ renderPending = false; render(); }
}
document.addEventListener('focusout', () => setTimeout(flushPendingRender, 250));
const dataFingerprint = () => JSON.stringify([settings, monthData, payslipActual, activeSession]);

function render(){
  const main = $('#mainContent');
  const prevListScroll = document.getElementById('entriesContainer')?.scrollTop || 0;
  main.classList.remove('editor-open');
  const calc = computeMonth();
  const capPct = Math.min(100, (calc.rawTotal / settings.monthlyCap) * 100);
  const overPct = calc.capExceeded ? 100 - (settings.monthlyCap/calc.rawTotal*100) : 0;

  const dates = Object.keys(monthData.days).sort().reverse();

  main.innerHTML = `
    <div class="tab-bar">
      <button type="button" data-tab="today" class="tab-btn ${activeTab==='today'?'active':''}">היום</button>
      <button type="button" data-tab="shifts" class="tab-btn ${activeTab==='shifts'?'active':''}">משמרות</button>
    </div>

    <div class="tab-panel" data-panel="today" ${activeTab!=='today' ? 'hidden' : ''}>
    ${buildShiftWidget()}
    <div class="today-body">
    <section class="ledger-card">
      <div class="cap-label">
        <span>0</span>
        <span class="cap-remaining">${calc.capExceeded ? 'חריגה מהתקרה' : `נותרו ${fmtHours(Math.max(0, settings.monthlyCap - calc.rawTotal))} ש׳`}</span>
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
      ${calc.sickDays > 0 ? `<div class="sick-note">נכללו ${calc.sickDays} ימי מחלה (${fmtHours(calc.sickHours)} שעות), לפי התקן שהוגדר.</div>` : ''}

      <div class="pay-breakdown">
        <div class="pay-row"><span>שכר משעות עבודה ומחלה</span><span class="mono">${fmtMoney(calc.hoursGross)}</span></div>
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
    ${buildPayslipCard(calc)}
    </div>
    </div>

    <div class="tab-panel" data-panel="shifts" ${activeTab!=='shifts' ? 'hidden' : ''}>
    <section class="month-select">
      <button id="prevMonth" aria-label="חודש קודם">‹</button>
      <span id="monthLabel">${HE_MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}</span>
      <button id="nextMonth" aria-label="חודש הבא">›</button>
    </section>

    <button class="add-entry-trigger" type="button" id="addEntryBtn">＋ הוספת יום</button>

    <div class="entry-editor-overlay" id="entryEditorOverlay" hidden>
    <section class="add-entry entry-editor" role="dialog" aria-modal="true" aria-labelledby="entryEditorTitle">
      <div class="entry-editor-head"><h2 id="entryEditorTitle">הוספת / עדכון יום עבודה</h2><button type="button" id="entryEditorClose" aria-label="סגירה">✕</button></div>
      <form id="entryForm">
        <label>תאריך <input type="date" id="entryDate" value="${todayStr()}"></label>
        <label>סוג יום
          <select id="entryType">
            <option value="work">יום עבודה</option>
            <option value="sick">מחלה</option>
          </select>
        </label>
        <div class="entry-work-fields" id="entryWorkFields">
          <label>שעת כניסה <input type="time" id="entryIn"></label>
          <label>שעת יציאה <input type="time" id="entryOut"></label>
          <label>הפסקה (דק') <input type="number" id="entryBreak" value="0" min="0" inputmode="numeric"></label>
        </div>
        <p class="stale-note" id="staleNote" hidden>⚠️ משמרת שלא נסגרה — הזן את שעת היציאה האמיתית ושמור כדי לסגור אותה.</p>
        <p class="sick-entry-note" id="sickDayNote" hidden>${Number(settings.sickDayHours) > 0 ? `מחלה: ${fmtHours(settings.sickDayHours)} שעות בתעריף רגיל, בתשלום מהיום הראשון.` : 'כדי להזין יום מחלה, הגדירו תחילה את שעות התקן בהגדרות.'}</p>
        <button type="submit">שמור יום</button>
      </form>
    </section>
    </div>

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
  $('#entryType').addEventListener('change', updateEntryTypeUI);
  $('#addEntryBtn').addEventListener('click', () => openEntryEditor());
  $('#entryEditorClose').addEventListener('click', closeEntryEditor);
  $('#entryEditorOverlay').addEventListener('click', ev => { if(ev.target.id === 'entryEditorOverlay') closeEntryEditor(); });
  $('#savePayslipBtn').addEventListener('click', savePayslipComparison);
  $('#clearPayslipBtn').addEventListener('click', clearPayslipComparison);
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
  main.classList.toggle('shifts-active', activeTab === 'shifts');
  main.classList.toggle('today-active', activeTab === 'today');
  document.getElementById('payslipDetails')?.addEventListener('toggle', ev => { payslipOpen = ev.target.open; });
  if(prevListScroll){
    const list = document.getElementById('entriesContainer');
    if(list) list.scrollTop = prevListScroll;
  }
}

function switchTab(tab){
  if(tab !== 'today' && tab !== 'shifts') return;
  activeTab = tab;
  const main = $('#mainContent');
  main.scrollTop = 0;
  main.classList.toggle('shifts-active', tab === 'shifts');
  main.classList.toggle('today-active', tab === 'today');
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
  const resolveStaleBtn = document.getElementById('resolveStaleBtn');
  const discardStaleBtn = document.getElementById('discardStaleBtn');
  if(resolveStaleBtn) resolveStaleBtn.addEventListener('click', openStaleSessionEditor);
  if(discardStaleBtn) attachLongPress(discardStaleBtn, discardStaleSession);
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

function updateEntryTypeUI(){
  const isSick = $('#entryType').value === 'sick';
  $('#entryWorkFields').hidden = isSick;
  $('#sickDayNote').hidden = !isSick;
}

function closeEntryEditor(){
  const overlay = document.getElementById('entryEditorOverlay');
  if(overlay) overlay.hidden = true;
  document.getElementById('mainContent')?.classList.remove('editor-open');
  editorResolvesSession = false;
  flushPendingRender();
}

function openEntryEditor(date = null, prefill = null){
  editorResolvesSession = !!(prefill && prefill.resolvesSession);
  if(prefill){
    $('#entryDate').value = prefill.date;
    $('#entryType').value = 'work';
    $('#entryIn').value = prefill.in;
    $('#entryOut').value = prefill.out;
    $('#entryBreak').value = prefill.brk;
    updateEntryTypeUI();
  }else if(date){
    fillFormForDate(date);
  }else{
    $('#entryDate').value = todayStr();
    $('#entryType').value = 'work';
    $('#entryIn').value = '';
    $('#entryOut').value = '';
    $('#entryBreak').value = 0;
    updateEntryTypeUI();
  }
  $('#staleNote').hidden = !editorResolvesSession;
  const overlay = document.getElementById('entryEditorOverlay');
  if(overlay) overlay.hidden = false;
  document.getElementById('mainContent')?.classList.add('editor-open');
}

function fillFormForDate(date){
  const e = monthData.days[date];
  $('#entryDate').value = date;
  $('#entryType').value = e?.type === 'sick' ? 'sick' : 'work';
  updateEntryTypeUI();
  $('#entryIn').value = e?.type === 'sick' ? '' : (e?.in || '');
  $('#entryOut').value = e?.type === 'sick' ? '' : (e?.out || '');
  $('#entryBreak').value = e?.type === 'sick' ? 0 : (e?.brk || 0);
}

function wireEntryInteractions(){
  document.querySelectorAll('.entry-row').forEach(row => {
    row.addEventListener('click', (ev) => {
      if(ev.target.closest('.entry-del')) return;
      openEntryEditor(row.dataset.date);
    });
  });
  document.querySelectorAll('.cal-cell[data-date]').forEach(cell => {
    cell.addEventListener('click', () => openEntryEditor(cell.dataset.date));
  });
  document.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const date = btn.dataset.del;
      const mk = date.slice(0, 7);
      const removed = monthData.days[date];
      try{
        await mutateMonth(mk, m => { delete m.days[date]; });
      }catch(e){
        console.error('delete failed', e);
        showToast('המחיקה נכשלה. בדוק חיבור ונסה שוב.');
        return;
      }
      render();
      showToast('היום נמחק', { action: { label: 'ביטול', onClick: async () => {
        try{
          await mutateMonth(mk, m => { m.days[date] = removed; });
          render();
          showToast('המחיקה בוטלה');
        }catch(e){
          console.error('undo failed', e);
          showToast('לא ניתן היה לשחזר את היום');
        }
      } } });
    });
  });
}

function buildList(dates, calc){
  return dates.map(date => {
    const h = calc.perDay[date];
    const e = monthData.days[date];
    const day = date.split('-')[2];
    const weekday = new Date(date + 'T00:00:00').toLocaleDateString('he-IL', { weekday:'short' }).replace('יום ', '');
    const isSick = e.type === 'sick';
    const dayTime = isSick
      ? `מחלה · ${fmtHours(h.total)} שעות`
      : `${e.in}–${e.out}${e.brk>0?` · הפסקה ${e.brk} ד׳${h.excessBreakMin>0?` <span class="break-flag">(-${Math.round(h.excessBreakMin)} ד׳)</span>`:''}`:''}`;
    const chips = isSick
      ? `<span class="chip sick">מחלה · ${fmtHours(h.total)} ש׳</span>`
      : `${h.regular>0?`<span class="chip regular">${fmtHours(h.regular)}</span>`:''}${h.ot125>0?`<span class="chip ot125">${fmtHours(h.ot125)}</span>`:''}${h.ot150>0?`<span class="chip ot150">${fmtHours(h.ot150)}</span>`:''}`;
    return `<div class="entry-row ${isSick ? 'sick-entry-row' : ''}" data-date="${date}">
      <div class="entry-row-top">
        <div class="entry-main">
          <div class="entry-date">${weekday} · ${day}.${String(currentDate.getMonth()+1).padStart(2,'0')}</div>
          <div class="entry-time">${dayTime}</div>
        </div>
        <div class="entry-pay mono">${fmtMoney(h.pay)}</div>
        <button class="entry-del" data-del="${date}" aria-label="מחק">✕</button>
      </div>
      <div class="entry-chips">${chips}</div>
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
    if(hasEntry && e.type === 'sick') cls += ' sick-day';
    if(isToday) cls += ' today';
    cells += `<div class="${cls}" data-date="${date}">
      <span class="cal-day-num">${d}</span>
      ${hasEntry && e.type === 'sick' ? '<span class="cal-sick-mark">מ</span>' : ''}
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
  const type = $('#entryType').value || 'work';
  const inT = $('#entryIn').value;
  const outT = $('#entryOut').value;
  const brk = Number($('#entryBreak').value) || 0;
  if(!date){ showToast('נא לבחור תאריך'); return; }
  if(type === 'work'){
    if(!inT || !outT){ showToast('נא למלא שעת כניסה ויציאה'); return; }
    const mins = AttendanceCalc.shiftMinutes(inT, outT); // crossing midnight is allowed
    if(mins === null){ showToast('בדוק את השעות: משמרת יכולה להיות עד 16 שעות'); return; }
    if(brk < 0 || brk > mins){ showToast('משך ההפסקה לא הגיוני ביחס למשמרת'); return; }
  }
  if(type === 'sick' && !(Number(settings.sickDayHours) > 0)){ showToast('הגדר קודם את שעות התקן ליום מחלה בהגדרות'); return; }

  const submitBtn = ev.submitter || document.querySelector('#entryForm button[type="submit"]');
  if(submitBtn) submitBtn.disabled = true;
  const entry = type === 'sick' ? { type:'sick' } : { type:'work', in:inT, out:outT, brk };
  try{
    await mutateMonth(date.slice(0, 7), m => { m.days[date] = entry; });
    if(editorResolvesSession && activeSession) await closeActiveSession(activeSession);
    editorResolvesSession = false;
    if(date.slice(0, 7) !== monthKey(currentDate)){
      // the entry belongs to another month than the one on screen — switch to it
      currentDate = new Date(date + 'T00:00:00');
      await loadMonth(currentDate);
    }
    render();
    showToast('היום נשמר');
    checkCapWarning();
  }catch(e){
    // the editor stays open with everything the user typed
    console.error('save entry failed', e);
    showToast('השמירה נכשלה. בדוק חיבור ונסה שוב.');
  }finally{
    if(submitBtn) submitBtn.disabled = false;
  }
}

async function savePayslipComparison(){
  const parseAmount = selector => {
    const value = $(selector).value.trim();
    if(value === '') return null;
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? amount : NaN;
  };
  const gross = parseAmount('#actualPayslipGross');
  const net = parseAmount('#actualPayslipNet');
  if(Number.isNaN(gross) || Number.isNaN(net)){ showToast('הסכומים בתלוש חייבים להיות מספרים חיוביים'); return; }
  if(gross === null && net === null){ showToast('הזן לפחות סכום אחד מהתלוש'); return; }
  const next = { gross, net };
  const ok = await kvSet(`payslip:${monthKey(currentDate)}`, next);
  if(!ok){ showToast('שגיאה בשמירת ההשוואה'); return; }
  payslipActual = next;
  writeInitialCache(currentUserId);
  render();
  showToast('ההשוואה לתלוש נשמרה');
}

async function clearPayslipComparison(){
  const empty = { gross:null, net:null };
  const ok = await kvSet(`payslip:${monthKey(currentDate)}`, empty);
  if(!ok){ showToast('שגיאה בניקוי ההשוואה'); return; }
  payslipActual = empty;
  writeInitialCache(currentUserId);
  render();
  showToast('ההשוואה נוקתה');
}

async function changeMonth(delta){
  const previous = currentDate;
  currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth()+delta, 1);
  showDataLoader();
  try{
    await loadMonth(currentDate);
    render();
  }catch(e){
    console.error('changeMonth failed', e);
    currentDate = previous; // never show another month's label over stale data
    showToast('לא ניתן לטעון את החודש. בדוק חיבור.');
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
  $('#setSickDayHours').value = settings.sickDayHours ?? 0;
  $('#setOt125Hours').value = settings.ot125Hours;
  $('#setMonthlyCap').value = settings.monthlyCap;
  $('#setFreeBreak').value = settings.freeBreakMinutes;
  $('#setCapWarnHours').value = settings.capWarnHours;
  $('#setAttendanceReminders').value = settings.attendanceRemindersEnabled ? 'on' : 'off';
  $('#setCheckOutReminderTime').value = settings.checkOutReminderTime || '16:00';
  $('#setCheckOutRepeatMinutes').value = settings.checkOutRepeatMinutes ?? 30;
  updateThemeButtonsUI();
  renderDeductionRows();
  renderAdditionRows();
  refreshPushStatusUI();
  refreshTelegramUI();
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

$('#telegramConnectBtn').addEventListener('click', async () => {
  await createTelegramLinkCode();
});

$('#telegramCopyBtn').addEventListener('click', async () => {
  const command = $('#telegramLinkCommand').textContent || '';
  if(!command) return;
  try{
    await navigator.clipboard.writeText(command);
    showToast('פקודת החיבור הועתקה');
  }catch(e){
    showToast('לא ניתן להעתיק אוטומטית');
  }
});

$('#telegramDisconnectBtn').addEventListener('click', async () => {
  if(!confirm('לנתק את חשבון Telegram מנוכחות+?')) return;
  await disconnectTelegram();
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
  const num = id => Number($(id).value);
  const next = {
    hourlyRate: num('#setRate'),
    regularHours: num('#setRegularHours'),
    sickDayHours: num('#setSickDayHours') || 0,
    ot125Hours: num('#setOt125Hours') || 0,
    monthlyCap: num('#setMonthlyCap'),
    freeBreakMinutes: num('#setFreeBreak') || 0,
    capWarnHours: num('#setCapWarnHours') || 0,
    checkOutRepeatMinutes: num('#setCheckOutRepeatMinutes') || 0
  };
  const deductions = [...document.querySelectorAll('#deductionsSettings .deduction-row')].map((row,i) => ({
    ...settings.deductions[i],
    name: row.querySelector('[data-field="name"]').value || 'רכיב',
    percent: Number(row.querySelector('[data-field="percent"]').value) || 0
  }));
  const additions = [...document.querySelectorAll('#additionsSettings .deduction-row')].map((row,i) => ({
    ...settings.additions[i],
    name: row.querySelector('[data-field="name"]').value || 'תוספת',
    amount: Number(row.querySelector('[data-field="amount"]').value) || 0
  }));

  // A zero cap or rate would silently zero out the whole salary estimate — refuse it.
  const problem =
    !(next.hourlyRate > 0) ? 'שכר שעתי חייב להיות גדול מאפס' :
    !(next.regularHours > 0 && next.regularHours <= 24) ? 'שעות ליום רגיל חייבות להיות בין 0 ל-24' :
    !(next.monthlyCap > 0) ? 'תקרת השעות החודשית חייבת להיות גדולה מאפס' :
    [next.sickDayHours, next.ot125Hours, next.freeBreakMinutes, next.capWarnHours, next.checkOutRepeatMinutes].some(v => !(v >= 0)) ? 'ערכים שליליים אינם מותרים' :
    deductions.some(d => d.percent < 0 || d.percent > 100) || deductions.reduce((s,d) => s + d.percent, 0) > 100 ? 'אחוזי הניכויים חייבים להיות בין 0 ל-100 וסכומם עד 100' :
    additions.some(a => a.amount < 0) ? 'סכום תוספת לא יכול להיות שלילי' : null;
  if(problem){ showToast(problem); return; }

  Object.assign(settings, next);
  settings.attendanceRemindersEnabled = $('#setAttendanceReminders').value === 'on';
  settings.checkOutReminderTime = $('#setCheckOutReminderTime').value || '16:00';
  settings.deductions = deductions;
  settings.additions = additions;
  await saveSettingsToStorage();
  await refreshAttendanceReminderSchedule();
  closeSettings();
  render();
});
$('#resetData').addEventListener('click', async () => {
  if(!confirm('לאפס את כל נתוני הנוכחות והשכר לחודש הנוכחי? פעולה זו לא ניתנת לביטול.')) return;
  try{
    await mutateMonth(monthKey(currentDate), m => { m.days = {}; });
  }catch(e){
    console.error('reset failed', e);
    showToast('האיפוס נכשל. בדוק חיבור ונסה שוב.');
    return;
  }
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
  $('#authPassword').setAttribute('autocomplete', authMode === 'signin' ? 'current-password' : 'new-password');
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
      const before = dataFingerprint();
      await loadInitialData(userId);
      if(dataFingerprint() !== before) renderUnlessEditing();
      refreshAttendanceReminderSchedule();
    }catch(e){
      console.error('background refresh failed', e);
    }
    return;
  }

  showDataLoader();
  try{
    await loadInitialData(userId);
    showReadyApp();
    refreshAttendanceReminderSchedule();
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
  // the cached snapshot holds pay data: don't leave it behind on a shared device
  try{
    Object.keys(localStorage).filter(k => k.startsWith('nc_initial:')).forEach(k => localStorage.removeItem(k));
  }catch(e){ /* localStorage unavailable */ }
  currentUserId = null;
  appStarted = false;
  settings = null;
  monthData = { days:{} };
  activeSession = null;
  clearInterval(shiftTimerInterval);
  shiftTimerInterval = null;
  showAuthScreen();
}

let foregroundRefreshPromise = null;
async function refreshFromCloud(){
  if(!appStarted || !currentUserId) return;
  if(foregroundRefreshPromise) return foregroundRefreshPromise;
  foregroundRefreshPromise = (async () => {
    try{
      const before = dataFingerprint();
      await loadInitialData(currentUserId);
      if(dataFingerprint() !== before) renderUnlessEditing();
    }catch(e){
      console.error('foreground refresh failed', e);
    }finally{
      foregroundRefreshPromise = null;
    }
  })();
  return foregroundRefreshPromise;
}

document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible' && appStarted){
    tickShiftTimer();
    void refreshFromCloud(); // picks up Telegram / other-device attendance changes
  }
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
