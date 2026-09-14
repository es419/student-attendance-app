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
