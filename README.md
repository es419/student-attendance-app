# נוכחות+

אפליקציית PWA סטטית למעקב נוכחות, שעות ושכר משוער.

## מבנה

- `index.html` — מבנה המסך בלבד.
- `styles.css` — כל העיצוב.
- `app.js` — הלוגיקה, Supabase, נוכחות, חישובים, ייצוא והגדרות.
- `sw.js` — cache, offline shell והתראות push.
- `manifest.json` — הגדרות PWA.

## הרצה מקומית

```powershell
py -m http.server 8000
```

ואז לפתוח `http://localhost:8000`.

## טעינה

יש שכבת loading חוסמת אחת בלבד:

- אם קיים snapshot מקומי, המסך מוצג מיד והסנכרון מול Supabase מתבצע ברקע.
- אם אין snapshot, הלוגו נשאר רק עד שהבקשה הראשונית ל-Supabase מסתיימת.
- אין timeout מלאכותי ואין spinner נוסף בתוך המסך.

## Telegram companion

הפרויקט כולל בוט Telegram שמתחבר לאותו חשבון ואותם נתוני נוכחות.

הבוט תומך בכניסה, יציאה, יציאה/חזרה מהפסקה, סטטוס נוכחי, סיכום היום ודוח החודש. החיבור לחשבון נעשה באמצעות קוד חד-פעמי מהגדרות האפליקציה.

### התקנה ב-Supabase

1. הרץ את המיגרציה שב-`supabase/migrations/20260918_add_telegram_companion.sql`.
2. הגדר Secrets לפונקציה: `TELEGRAM_BOT_TOKEN` ו-`TELEGRAM_WEBHOOK_SECRET`.
3. פרוס את `supabase/functions/attendance-telegram` ללא JWT verification.
4. הגדר את webhook של Telegram לכתובת הפונקציה עם אותו `secret_token`.

לא שומרים Bot Token בקוד או ב-Git.
