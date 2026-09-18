# חיבור Telegram לנוכחות+

## 1. צור בוט

ב-Telegram פתח את `@BotFather`, הרץ `/newbot` ושמור את ה-Bot Token במקום פרטי.
אין להכניס את הטוקן לקוד או ל-Git.

## 2. חבר את תיקיית הפרויקט ל-Supabase

מתוך תיקיית הפרויקט ב-PowerShell:

```powershell
npx supabase login
npx supabase link --project-ref ojzemdselyxxscbbvssm
npx supabase db push
```

`db push` יוצר רק את טבלאות החיבור של Telegram ואת מדיניות ה-RLS שלהן.

## 3. שמור Secrets ופרוס את ה-Edge Function

```powershell
$BOT_TOKEN = Read-Host "Telegram Bot Token"
$WEBHOOK_SECRET = [guid]::NewGuid().ToString("N")

npx supabase secrets set TELEGRAM_BOT_TOKEN="$BOT_TOKEN" TELEGRAM_WEBHOOK_SECRET="$WEBHOOK_SECRET"
npx supabase functions deploy attendance-telegram --no-verify-jwt
```

## 4. חבר את Telegram ל-Webhook

```powershell
.\setup-telegram-webhook.ps1 -BotToken "$BOT_TOKEN" -WebhookSecret "$WEBHOOK_SECRET"
```

בתוצאה צריך להופיע `"ok": true`.

## 5. חבר את החשבון שלך

1. העלה את גרסת ה-PWA המעודכנת ל-GitHub Pages.
2. פתח נוכחות+ → הגדרות → Telegram.
3. לחץ **צור קוד חיבור לטלגרם**.
4. שלח לבוט את הפקודה שמופיעה, למשל `/link ABCD1234`.
5. הבוט יציג את מצב המשמרת ואת כפתורי הפעולה.

## פקודות שימושיות

- `/start` — תפריט וסטטוס.
- `/today` — סיכום היום.
- `/month` — רשימת נוכחות וסיכום החודש.
- `/unlink` — ניתוק חשבון Telegram מהאפליקציה.

הכפתורים משתנים אוטומטית לפי מצב המשמרת: כניסה, הפסקה, חזרה מהפסקה ויציאה.
