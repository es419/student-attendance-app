import { createClient } from "npm:@supabase/supabase-js@2.109.0";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TZ = "Asia/Jerusalem";

if (!BOT_TOKEN || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing TELEGRAM_BOT_TOKEN or Supabase environment variables");
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEFAULT_SETTINGS = {
  hourlyRate: 39.58,
  regularHours: 8,
  sickDayHours: 0,
  ot125Hours: 2,
  monthlyCap: 120,
  freeBreakMinutes: 40,
  attendanceRemindersEnabled: true,
  checkInReminderTime: "08:00",
  checkOutReminderTime: "16:00",
  checkOutRepeatMinutes: 30,
};

type TelegramUser = { id: number; username?: string; first_name?: string };
type TelegramChat = { id: number; type: string };
type Message = { message_id: number; chat: TelegramChat; from?: TelegramUser; text?: string };
type CallbackQuery = { id: string; from: TelegramUser; message?: Message; data?: string };
type Update = { message?: Message; callback_query?: CallbackQuery };

type ActiveSession = {
  date: string;
  checkIn: string;
  breaks: Array<{ start: string; end: string | null; reminderId?: string }>;
};

type MonthData = { days: Record<string, { in?: string; out?: string; brk?: number; type?: 'work' | 'sick' }> };

// Constant-time string comparison (avoids leaking the secret through timing).
function safeEqual(a: string, b: string) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function telegram(method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    console.error("Telegram API error", method, result);
  }
  return result;
}

function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    month: `${get("year")}-${get("month")}`,
  };
}

function timeToMinutes(value: string) {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

// A shift longer than this is treated as a forgotten clock-out, never guessed.
const MAX_SHIFT_MINUTES = 16 * 60;

// Minutes from start to end on a 24h clock; wraps past midnight (22:00 -> 06:00 = 480).
function minutesBetween(start: string, end: string) {
  return (((timeToMinutes(end) - timeToMinutes(start)) % 1440) + 1440) % 1440;
}

// Minutes since the epoch of a local (Asia/Jerusalem) date + "HH:MM", for differences only.
function localMinutes(date: string, time: string) {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 60_000 + timeToMinutes(time);
}

function elapsedMinutesSince(session: ActiveSession, now: { date: string; time: string }) {
  return localMinutes(now.date, now.time) - localMinutes(session.date, session.checkIn);
}

function breakMinutes(session: ActiveSession, openBreakEnd?: string) {
  return session.breaks.reduce((sum, b) => {
    const end = b.end ?? openBreakEnd;
    return end ? sum + minutesBetween(b.start, end) : sum;
  }, 0);
}

function isOnBreak(session: ActiveSession | null) {
  if (!session || session.breaks.length === 0) return false;
  return !session.breaks[session.breaks.length - 1].end;
}

async function getKv(userId: string, keys: string[]) {
  const { data, error } = await db
    .from("kv_store")
    .select("key,value")
    .eq("user_id", userId)
    .in("key", keys);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((row) => [row.key, row.value]));
}

async function setKv(userId: string, key: string, value: unknown) {
  const { error } = await db.from("kv_store").upsert(
    { user_id: userId, key, value, updated_at: new Date().toISOString() },
    { onConflict: "user_id,key" },
  );
  if (error) throw error;
}

async function deleteKv(userId: string, key: string) {
  const { error } = await db.from("kv_store").delete().eq("user_id", userId).eq("key", key);
  if (error) throw error;
}

async function linkedUser(chatId: string) {
  const { data, error } = await db
    .from("telegram_links")
    .select("user_id")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id as string | undefined;
}

async function linkAccount(codeRaw: string, chatId: string, from?: TelegramUser) {
  const code = codeRaw.trim().toUpperCase();
  const { data, error } = await db
    .from("telegram_link_codes")
    .select("user_id,expires_at")
    .eq("code", code)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, message: "הקוד לא תקין או שכבר נוצל." };
  if (new Date(data.expires_at).getTime() <= Date.now()) {
    await db.from("telegram_link_codes").delete().eq("code", code);
    return { ok: false, message: "הקוד פג תוקף. צור קוד חדש באפליקציה." };
  }

  const { data: existingChat } = await db
    .from("telegram_links")
    .select("user_id")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (existingChat && existingChat.user_id !== data.user_id) {
    return { ok: false, message: "חשבון הטלגרם הזה כבר מחובר למשתמש אחר." };
  }

  const { error: linkError } = await db.from("telegram_links").upsert(
    {
      user_id: data.user_id,
      chat_id: chatId,
      telegram_username: from?.username ?? null,
      telegram_first_name: from?.first_name ?? null,
      linked_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (linkError) throw linkError;
  await db.from("telegram_link_codes").delete().eq("user_id", data.user_id);
  return { ok: true, userId: data.user_id as string, message: "החשבון חובר בהצלחה לנוכחות+ ✅" };
}

async function loadState(userId: string) {
  const now = localParts();
  const monthKey = `attendance:${now.month}`;
  const rows = await getKv(userId, ["settings", "activeSession", monthKey]);
  return {
    now,
    settings: { ...DEFAULT_SETTINGS, ...(rows.settings ?? {}) },
    activeSession: (rows.activeSession ?? null) as ActiveSession | null,
    monthData: (rows[monthKey] ?? { days: {} }) as MonthData,
    monthKey,
  };
}

async function scheduleBreakReminder(userId: string, session: ActiveSession, freeBreakMinutes: number) {
  if (freeBreakMinutes <= 10) return session;
  const { count } = await db
    .from("push_subscriptions")
    .select("endpoint", { count: "exact", head: true })
    .eq("user_id", userId);
  if (!count) return session;

  const fireAt = new Date(Date.now() + (freeBreakMinutes - 10) * 60_000);
  const { data, error } = await db.from("break_reminders").insert({
    user_id: userId,
    fire_at: fireAt.toISOString(),
    message: `עוד 10 דקות וההפסקה שלך (${freeBreakMinutes} דק') מסתיימת`,
  }).select("id").single();
  if (!error && data?.id) {
    session.breaks[session.breaks.length - 1].reminderId = data.id;
  }
  return session;
}

async function cancelReminder(reminderId?: string) {
  if (!reminderId) return;
  await db.from("break_reminders").delete().eq("id", reminderId).eq("sent", false);
}

const ATTENDANCE_REMINDER_MESSAGES = {
  checkIn: "לא שכחת להחתים כניסה?",
  checkOut: "לא שכחת להחתים יציאה?",
  checkOutRepeat: "עדיין לא החתמת יציאה",
};

async function cancelAttendanceReminders(userId: string, messages: string[]) {
  if (!messages.length) return;
  await db.from("break_reminders")
    .delete()
    .eq("user_id", userId)
    .eq("sent", false)
    .in("message", messages);
}

async function scheduleTelegramClockOutReminders(
  userId: string,
  nowTime: string,
  settings: Record<string, unknown>,
) {
  await cancelAttendanceReminders(userId, [
    ATTENDANCE_REMINDER_MESSAGES.checkOut,
    ATTENDANCE_REMINDER_MESSAGES.checkOutRepeat,
  ]);
  if (settings.attendanceRemindersEnabled === false) return;

  const { count } = await db.from("push_subscriptions")
    .select("endpoint", { count: "exact", head: true })
    .eq("user_id", userId);
  if (!count) return;

  const target = String(settings.checkOutReminderTime || "16:00");
  const deltaMinutes = timeToMinutes(target) - timeToMinutes(nowTime);
  const repeatMinutes = Math.max(0, Number(settings.checkOutRepeatMinutes) || 0);
  const rows: Array<{ user_id: string; fire_at: string; message: string }> = [];

  if (deltaMinutes > 0) {
    const first = new Date(Date.now() + deltaMinutes * 60_000);
    rows.push({
      user_id: userId,
      fire_at: first.toISOString(),
      message: ATTENDANCE_REMINDER_MESSAGES.checkOut,
    });
    if (repeatMinutes > 0) {
      rows.push({
        user_id: userId,
        fire_at: new Date(first.getTime() + repeatMinutes * 60_000).toISOString(),
        message: ATTENDANCE_REMINDER_MESSAGES.checkOutRepeat,
      });
    }
  }
  if (rows.length) await db.from("break_reminders").insert(rows);
}

async function performAction(userId: string, action: string) {
  const state = await loadState(userId);
  let session = state.activeSession;
  const now = state.now;

  if (action === "clock_in") {
    if (session) return "כבר קיימת משמרת פעילה.";
    session = { date: now.date, checkIn: now.time, breaks: [] };
    await setKv(userId, "activeSession", session);
    await cancelAttendanceReminders(userId, [ATTENDANCE_REMINDER_MESSAGES.checkIn]);
    await scheduleTelegramClockOutReminders(userId, now.time, state.settings);
    return `נכנסת למשמרת ב-${now.time} 🟢`;
  }

  if (action === "start_break") {
    if (!session) return "אין כרגע משמרת פעילה.";
    if (isOnBreak(session)) return "אתה כבר בהפסקה.";
    session.breaks.push({ start: now.time, end: null });
    session = await scheduleBreakReminder(userId, session, Number(state.settings.freeBreakMinutes) || 0);
    await setKv(userId, "activeSession", session);
    return `יצאת להפסקה ב-${now.time} ☕`;
  }

  if (action === "end_break") {
    if (!session) return "אין כרגע משמרת פעילה.";
    if (!isOnBreak(session)) return "אתה לא בהפסקה כרגע.";
    const last = session.breaks[session.breaks.length - 1];
    last.end = now.time;
    await cancelReminder(last.reminderId);
    await setKv(userId, "activeSession", session);
    return `חזרת מהפסקה ב-${now.time} ↩️`;
  }

  if (action === "clock_out") {
    if (!session) return "אין כרגע משמרת פעילה.";
    const checkout = now.time;
    const elapsed = elapsedMinutesSince(session, now);
    if (elapsed > MAX_SHIFT_MINUTES) {
      // Almost certainly a forgotten clock-out. Leave everything untouched so the
      // app can ask for the real end time.
      return "המשמרת פתוחה כבר מעל 16 שעות. פתח את נוכחות+ והזן את שעת היציאה האמיתית.";
    }
    const checkin = session.checkIn;
    const startedBreak = isOnBreak(session);
    const totalBreak = breakMinutes(session, checkout);

    await cancelAttendanceReminders(userId, [
      ATTENDANCE_REMINDER_MESSAGES.checkOut,
      ATTENDANCE_REMINDER_MESSAGES.checkOutRepeat,
    ]);
    if (startedBreak) await cancelReminder(session.breaks[session.breaks.length - 1].reminderId);

    if (elapsed < 1) {
      // in and out within the same minute: an accidental tap, not a shift
      await deleteKv(userId, "activeSession");
      return "המשמרת נמשכה פחות מדקה ולא נשמרה.";
    }

    // Save the day first; only then close the shift, so a failure loses nothing.
    const sessionMonth = session.date.slice(0, 7);
    const key = `attendance:${sessionMonth}`;
    const rows = key === state.monthKey ? { [key]: state.monthData } : await getKv(userId, [key]);
    const monthData = (rows[key] ?? { days: {} }) as MonthData;
    if (!monthData.days) monthData.days = {};
    monthData.days[session.date] = { in: checkin, out: checkout, brk: totalBreak };
    await setKv(userId, key, monthData);
    await deleteKv(userId, "activeSession");
    return `סיימת את המשמרת ב-${checkout} 🔴`;
  }

  return "פעולה לא מוכרת.";
}

function elapsedText(session: ActiveSession, now: { date: string; time: string }) {
  const minutes = Math.max(0, elapsedMinutesSince(session, now) - breakMinutes(session));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function keyboard(session: ActiveSession | null) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  if (!session) {
    rows.push([{ text: "🟢 כניסה", callback_data: "clock_in" }]);
  } else if (isOnBreak(session)) {
    rows.push([
      { text: "↩️ חזרה מהפסקה", callback_data: "end_break" },
      { text: "🔴 יציאה מהמשמרת", callback_data: "clock_out" },
    ]);
  } else {
    rows.push([
      { text: "☕ יציאה להפסקה", callback_data: "start_break" },
      { text: "🔴 יציאה מהמשמרת", callback_data: "clock_out" },
    ]);
  }
  rows.push([
    { text: "📋 היום שלי", callback_data: "today" },
    { text: "📅 החודש", callback_data: "month" },
  ]);
  rows.push([{ text: "🔄 רענון", callback_data: "status" }]);
  return { inline_keyboard: rows };
}

async function statusText(userId: string) {
  const state = await loadState(userId);
  const s = state.activeSession;
  if (!s) return { text: "אין כרגע משמרת פעילה.", session: null as ActiveSession | null };
  if (elapsedMinutesSince(s, state.now) > MAX_SHIFT_MINUTES) {
    return {
      text: `⚠️ משמרת פתוחה מאז ${s.date.slice(8, 10)}/${s.date.slice(5, 7)} ${s.checkIn}.\nנראה ששכחת להחתים יציאה — פתח את נוכחות+ והזן את שעת היציאה האמיתית.`,
      session: s,
    };
  }
  if (isOnBreak(s)) {
    const last = s.breaks[s.breaks.length - 1];
    return { text: `☕ בהפסקה מאז ${last.start}\nכניסה למשמרת: ${s.checkIn}`, session: s };
  }
  return { text: `🟢 במשמרת מאז ${s.checkIn}\nזמן משמרת: ${elapsedText(s, state.now)}`, session: s };
}

async function todayText(userId: string) {
  const state = await loadState(userId);
  const today = state.now.date;
  const saved = state.monthData.days?.[today];
  const lines = [`📋 היום — ${today}`];
  if (saved?.type === 'sick') {
    lines.push(`יום מחלה · ${Number(state.settings.sickDayHours) || 0} שעות בתקן`);
  } else if (saved) {
    lines.push(`כניסה: ${saved.in ?? '—'}`, `יציאה: ${saved.out ?? '—'}`, `הפסקות: ${saved.brk || 0} דק׳`);
  } else {
    lines.push("אין עדיין משמרת שהסתיימה היום.");
  }
  if (state.activeSession) {
    lines.push("", isOnBreak(state.activeSession)
      ? `☕ משמרת פעילה בהפסקה (כניסה ${state.activeSession.checkIn})`
      : `🟢 משמרת פעילה מ-${state.activeSession.checkIn}`);
  }
  return { text: lines.join("\n"), session: state.activeSession };
}

function dayHours(entry: { in?: string; out?: string; brk?: number; type?: 'work' | 'sick' }, freeBreakMinutes: number, sickDayHours = 0) {
  if (entry.type === 'sick') return Math.max(0, Number(sickDayHours) || 0);
  if (!entry.in || !entry.out) return 0;
  const wrapped = minutesBetween(entry.in, entry.out);
  const span = wrapped > 0 && wrapped <= MAX_SHIFT_MINUTES ? wrapped : 0;
  const excessBreak = Math.max(0, (Number(entry.brk) || 0) - freeBreakMinutes);
  return Math.max(0, span - excessBreak) / 60;
}

async function monthText(userId: string) {
  const state = await loadState(userId);
  const dates = Object.keys(state.monthData.days ?? {}).sort();
  const lines = [`📅 נוכחות ${state.now.month}`];
  let total = 0;
  const freeBreak = Number(state.settings.freeBreakMinutes) || 0;
  const sickDayHours = Number(state.settings.sickDayHours) || 0;
  for (const date of dates) {
    const entry = state.monthData.days[date];
    const hours = dayHours(entry, freeBreak, sickDayHours);
    total += hours;
    const description = entry.type === 'sick' ? 'מחלה' : `${entry.in ?? '—'}–${entry.out ?? '—'}`;
    lines.push(`${date.slice(8, 10)}/${date.slice(5, 7)}  ${description}  · ${hours.toFixed(1)} ש׳`);
  }
  if (!dates.length) lines.push("אין עדיין משמרות שמורות החודש.");
  const cap = Number(state.settings.monthlyCap) || 0;
  lines.push("", `סה״כ: ${total.toFixed(1)} שעות`);
  if (cap > 0) lines.push(`יעד: ${cap} · נותרו: ${Math.max(0, cap - total).toFixed(1)} שעות`);
  return { text: lines.join("\n"), session: state.activeSession };
}

async function sendMenu(chatId: string, userId: string, prefix?: string, editMessageId?: number) {
  const status = await statusText(userId);
  const text = `${prefix ? `${prefix}\n\n` : ""}${status.text}\n\nבחר פעולה:`;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    reply_markup: keyboard(status.session),
  };
  if (editMessageId) {
    payload.message_id = editMessageId;
    return telegram("editMessageText", payload);
  }
  return telegram("sendMessage", payload);
}

async function handleMessage(message: Message) {
  if (message.chat.type !== "private") return;
  const chatId = String(message.chat.id);
  const text = (message.text ?? "").trim();

  const linkMatch = text.match(/^\/link(?:@\w+)?\s+([A-Z0-9-]+)$/i);
  if (linkMatch) {
    const result = await linkAccount(linkMatch[1], chatId, message.from);
    if (!result.ok || !result.userId) {
      await telegram("sendMessage", { chat_id: chatId, text: result.message });
      return;
    }
    await sendMenu(chatId, result.userId, result.message);
    return;
  }

  const userId = await linkedUser(chatId);
  if (!userId) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "כדי להשתמש בבוט, פתח את נוכחות+ → הגדרות → Telegram, צור קוד חיבור ושלח כאן:\n/link CODE",
    });
    return;
  }

  if (/^\/unlink(?:@\w+)?$/i.test(text)) {
    await db.from("telegram_links").delete().eq("chat_id", chatId);
    await telegram("sendMessage", { chat_id: chatId, text: "החיבור לנוכחות+ נותק." });
    return;
  }

  if (/^\/month(?:@\w+)?$/i.test(text)) {
    const report = await monthText(userId);
    await telegram("sendMessage", { chat_id: chatId, text: report.text, reply_markup: keyboard(report.session) });
    return;
  }
  if (/^\/today(?:@\w+)?$/i.test(text)) {
    const report = await todayText(userId);
    await telegram("sendMessage", { chat_id: chatId, text: report.text, reply_markup: keyboard(report.session) });
    return;
  }
  await sendMenu(chatId, userId);
}

async function handleCallback(query: CallbackQuery) {
  const message = query.message;
  if (!message || message.chat.type !== "private") return;
  const chatId = String(message.chat.id);
  await telegram("answerCallbackQuery", { callback_query_id: query.id });

  const userId = await linkedUser(chatId);
  if (!userId) {
    await telegram("sendMessage", { chat_id: chatId, text: "החיבור לחשבון בוטל. צור קוד חיבור חדש באפליקציה." });
    return;
  }

  const action = query.data ?? "status";
  if (["clock_in", "start_break", "end_break", "clock_out"].includes(action)) {
    const result = await performAction(userId, action);
    await sendMenu(chatId, userId, result, message.message_id);
    return;
  }
  if (action === "today") {
    const report = await todayText(userId);
    await telegram("editMessageText", {
      chat_id: chatId,
      message_id: message.message_id,
      text: report.text,
      reply_markup: keyboard(report.session),
    });
    return;
  }
  if (action === "month") {
    const report = await monthText(userId);
    await telegram("editMessageText", {
      chat_id: chatId,
      message_id: message.message_id,
      text: report.text,
      reply_markup: keyboard(report.session),
    });
    return;
  }
  await sendMenu(chatId, userId, undefined, message.message_id);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: true, service: "attendance-telegram" });
  // Fail closed: without a configured secret anyone could post fake updates.
  if (!WEBHOOK_SECRET) {
    console.error("TELEGRAM_WEBHOOK_SECRET is not set; refusing all requests");
    return json({ error: "webhook not configured" }, 503);
  }
  const provided = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!safeEqual(provided, WEBHOOK_SECRET)) return json({ error: "unauthorized" }, 401);

  try {
    const update = await req.json() as Update;
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message) await handleMessage(update.message);
    return json({ ok: true });
  } catch (error) {
    console.error(error);
    return json({ ok: false }, 200);
  }
});
