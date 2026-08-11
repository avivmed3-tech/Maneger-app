# 📋 הנחיות הגדרת Google Sheet — ניהול קו ייצור

## שלב 1: יצירת Google Sheet חדש
1. היכנס ל-https://sheets.google.com
2. לחץ על **"גיליון אלקטרוני ריק"**
3. שנה את השם ל: **"ניהול קו ייצור — Data"**

## שלב 2: פתיחת Apps Script
(הגיליונות `data` ו-`users` ייווצרו אוטומטית)
1. בתפריט העליון: **הרחבות** → **Apps Script**
2. מחק את כל הטקסט ב-`Code.gs`
3. הדבק את הקוד הבא:

```javascript
const SS = SpreadsheetApp.getActiveSpreadsheet();

function getOrCreateSheet(name) {
  let sheet = SS.getSheetByName(name);
  if (!sheet) {
    sheet = SS.insertSheet(name);
    sheet.getRange("A1").setValue(name + "_json");
  }
  return sheet;
}

function doGet(e) {
  const type = (e && e.parameter && e.parameter.type) || "";
  
  if (type === "users") {
    const sheet = getOrCreateSheet("users");
    if (sheet.getLastRow() < 2) return ContentService.createTextOutput("[]").setMimeType(ContentService.MimeType.JSON);
    const data = sheet.getRange("A2").getValue();
    return ContentService.createTextOutput(data || "[]").setMimeType(ContentService.MimeType.JSON);
  }
  
  const sheet = getOrCreateSheet("data");
  if (sheet.getLastRow() < 2) return ContentService.createTextOutput("{}").setMimeType(ContentService.MimeType.JSON);
  const data = sheet.getRange("A2").getValue();
  return ContentService.createTextOutput(data || "{}").setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    
    if (body.action === "saveUsers") {
      const sheet = getOrCreateSheet("users");
      sheet.getRange("A1").setValue("users_json");
      sheet.getRange("A2").setValue(JSON.stringify(body.users));
      return ContentService.createTextOutput("ok").setMimeType(ContentService.MimeType.TEXT);
    }
    
    if (body.action === "save") {
      const sheet = getOrCreateSheet("data");
      sheet.getRange("A1").setValue("data_json");
      sheet.getRange("A2").setValue(JSON.stringify(body.payload));
      return ContentService.createTextOutput("ok").setMimeType(ContentService.MimeType.TEXT);
    }
    
    return ContentService.createTextOutput("unknown action").setMimeType(ContentService.MimeType.TEXT);
  } catch(err) {
    return ContentService.createTextOutput("error: " + err.message).setMimeType(ContentService.MimeType.TEXT);
  }
}
```

## שלב 4: פריסה (Deploy)
1. לחץ על **"פריסה"** (Deploy) → **"פריסה חדשה"** (New deployment)
2. בסוג: בחר **"אפליקציית אינטרנט"** (Web app)
3. הגדרות:
   - **תיאור**: ניהול קו ייצור API
   - **הרצה כ**: **אני** (Me)
   - **גישה**: **כל אחד** (Anyone)
4. לחץ **"פריסה"** (Deploy)
5. אשר הרשאות אם מתבקש
6. **העתק את ה-URL** שמוצג — זה ייראה כמו:
   ```
   https://script.google.com/macros/s/AKfycbw.../exec
   ```

## שלב 5: עדכון הקוד
1. פתח את `index.html`
2. חפש את השורה (בתחילת הקובץ):
   ```javascript
   const GS_URL="";
   ```
3. הדבק את ה-URL שהעתקת:
   ```javascript
   const GS_URL="https://script.google.com/macros/s/AKfycbw.../exec";
   ```
4. שמור

## שלב 6: העלאה ל-GitHub Pages
1. צור repository חדש ב-GitHub (Public)
2. העלה את כל הקבצים מתיקיית `app` (index.html, sw.js, manifest.json, icon-192.png, icon-512.png)
3. Settings → Pages → Branch: **main** → Folder: **/ (root)** → Save
4. האפליקציה תהיה זמינה ב: `https://USERNAME.github.io/REPO-NAME`

## 🔑 פרטי כניסה (משתמשי דמו)

המערכת נטענת עם מבנה ארגוני מלא: **2 מחלקות**, בכל מחלקה **מנהל מחלקה**,
**2 ראשי צוות**, ולכל ראש צוות **3 עובדים** — בנוסף לעורך וצופה לבדיקת כל סוגי המשתמשים.

| משתמש | סיסמה | תפקיד | מחלקה / כפיפות |
|--------|--------|--------|----------------|
| admin  | admin123 | 🛡️ מנהל מערכת | — |
| avi    | 1234   | 💼 מנהל מחלקה | מחלקת הרכבה |
| yossi  | 1234   | ⭐ ראש צוות | מחלקת הרכבה ← אבי |
| dana   | 1234   | 🔩 מרכיב מכני | ← יוסי |
| moshe  | 1234   | 🔧 מלחימה | ← יוסי |
| ronit  | 1234   | 🔌 חיווט | ← יוסי |
| noa    | 1234   | ⭐ ראש צוות | מחלקת הרכבה ← אבי |
| itay   | 1234   | 👷 עובד | ← נועה |
| galit  | 1234   | 🔩 מרכיב מכני | ← נועה |
| omer   | 1234   | 🔧 מלחימה | ← נועה |
| tamar  | 1234   | 💼 מנהל מחלקה | מחלקת בדיקות |
| david  | 1234   | ⭐ ראש צוות | מחלקת בדיקות ← תמר |
| lior   | 1234   | 🛠️ טכנאי | ← דוד |
| shira  | 1234   | 🔍 מבקר איכות | ← דוד |
| roi    | 1234   | 👷 עובד | ← דוד |
| michal | 1234   | ⭐ ראש צוות | מחלקת בדיקות ← תמר |
| yoav   | 1234   | 🛠️ טכנאי | ← מיכל |
| hadas  | 1234   | 🔍 מבקר איכות | ← מיכל |
| uri    | 1234   | 🔌 חיווט | ← מיכל |
| anat   | 1234   | ✏️ עורך | מחלקת הרכבה |
| viewer | 1234   | 👁️ צופה | — |

> ⚠️ **חשוב:** שנה סיסמאות לאחר ההתחברות הראשונה!

## 🔧 פתרון בעיות סנכרון

### הסנכרון לא עובד?
1. **פתח Console בדפדפן** (F12 → Console) — חפש הודעות `[SYNC]`
2. **בדוק שה-URL נכון** — פתח את ה-URL בטאב חדש, אתה צריך לראות `{}` או את הנתונים
3. **פרוס מחדש** — Apps Script → Deploy → Manage deployments → עריכה → New version → Deploy
4. **⚠️ חשוב מאוד:** אחרי כל שינוי בקוד של Apps Script — חובה **פריסה חדשה** (New deployment) ולא רק שמירה!
5. **נקה localStorage** — בדפדפן הפלאפון: הגדרות אתר → מחק נתונים, ואז רענן

### בדיקה ידנית:
פתח בדפדפן:
```
YOUR_URL?t=123
```
אם מחזיר `{}` — הנתונים עוד לא נשמרו. תעשה פעולה כלשהי באפליקציה ותבדוק שוב.

---

## 🆕 עדכון סכימת Supabase (תעריפים, סיסמאות וצפי מכירות)

הגרסה החדשה משתמשת בעמודות נוספות. אם אתה מקים פרויקט Supabase חדש,
הרץ את ה-SQL הבא ב-SQL Editor (במסד הקיים העמודות כבר נוספו):

```sql
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS sale_rate numeric DEFAULT 0;      -- תעריף מכירה (שווי מכירת עובד) לשעה
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS password_plain text;              -- סיסמה לצפייה ע"י מנהל
ALTER TABLE public.stages    ADD COLUMN IF NOT EXISTS hourly_rate numeric DEFAULT 0;    -- תעריף שעתי קבוע למרכז עבודה (שלב)
```

> ⚠️ **אבטחה:** העמודה `password_plain` שומרת את סיסמת העובד כטקסט גלוי כדי לאפשר
> למנהל לצפות בה. סיסמאות שנוצרו לפני העדכון מאוחסנות בהצפנה (hash) בלבד ולא ניתן
> לשחזרן — יש לאפס אותן דרך עריכת המשתמש כדי שיופיעו בכפתור הצפייה.

---

## 🆕 עדכון סכימה — תפקיד לשלב, זמן עבודה ותוכניות עבודה יומיות

הגרסה החדשה מוסיפה: שיוך תפקיד מבצע + זמן עבודה (דקות ליחידה) לכל שלב,
וטבלת תוכניות עבודה יומיות (שיבוץ עובד לפק"ע + שלב ליום מסוים). הרץ ב-SQL Editor:

```sql
-- שלב: תפקיד מבצע (מרכיב/טכנאי/מבקר/חיווט...) וזמן עבודה משוער ליחידה (דקות)
ALTER TABLE public.stages ADD COLUMN IF NOT EXISTS role_id text;
ALTER TABLE public.stages ADD COLUMN IF NOT EXISTS minutes numeric DEFAULT 0;

-- תוכניות עבודה יומיות — מנהל משבץ לעובד פק"ע + שלב ליום נתון
CREATE TABLE IF NOT EXISTS public.daily_plans (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  user_name text,
  plan_date date NOT NULL,
  order_id text,
  stage_id text,
  target_qty numeric DEFAULT 0,
  serial_ids jsonb DEFAULT '[]'::jsonb,
  note text,
  done boolean DEFAULT false,
  created_by text,
  created_by_name text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  company_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.companies(id)
);
ALTER TABLE public.daily_plans ADD COLUMN IF NOT EXISTS serial_ids jsonb DEFAULT '[]'::jsonb;  -- מספרים סידוריים ספציפיים ששובצו (ריק = לפי כמות/הכל)
CREATE INDEX IF NOT EXISTS daily_plans_company_user_date_idx ON public.daily_plans (company_id, user_id, plan_date);
ALTER TABLE public.daily_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anon_all_daily_plans ON public.daily_plans;
CREATE POLICY anon_all_daily_plans ON public.daily_plans FOR ALL USING (true) WITH CHECK (true);
ALTER PUBLICATION supabase_realtime ADD TABLE public.daily_plans;
```

> 💡 **זמן משוער לסיום פק"ע:** המערכת מחשבת צפי לפי סכום זמני השלבים × יחידות,
> חלקי "יום עבודה נטו" (ברירת מחדל 8 שע', ניתן לשינוי במסך הפק"ע). אם הפק"ע נבנתה
> מבלוק עם זמנים מוגדרים — הזמנים מהבלוק קודמים לזמן השלב הכללי.

---

## 🆕 עדכון סכימה — זמן תקן לכל מק"ט

הגרסה החדשה מפרידה בין שלושה זמנים שונים:

| מושג | פירוש | מקור |
|------|--------|------|
| **זמן תקן** | הזמן שהוגדר **מראש** לכל מק"ט, שלב אחר שלב | נקבע ידנית באפליקציה (לשונית ⏱️ זמן תקן ובפועל ← ״⚙️ הגדרת זמני תקן״) |
| **זמן בפועל** | הזמן שנמדד באמת מדיווחי העובדים (מה שנקרא בעבר "זמן תקן") | מחושב מרישומי העבודה שהסתיימו |
| **זמן מכירה** | הדקות שהוקצו לשלב במחירון / בבלוק | שדה `minutes` בשלב או בבלוק |

זמן התקן נשמר בטבלה חדשה. הרץ ב-SQL Editor:

```sql
-- זמן תקן לכל מק"ט — דקות לכל שלב (jsonb: {"s1":28,"s2":52,...})
CREATE TABLE IF NOT EXISTS public.pn_standards (
  id text PRIMARY KEY,
  pn text NOT NULL,
  stage_minutes jsonb DEFAULT '{}'::jsonb,
  total_min numeric DEFAULT 0,          -- זמן כולל ליחידה, לשימוש כשאין פירוט לפי שלב
  note text,
  updated_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  company_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.companies(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS pn_standards_company_pn_idx ON public.pn_standards (company_id, pn);
ALTER TABLE public.pn_standards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anon_all_pn_standards ON public.pn_standards;
CREATE POLICY anon_all_pn_standards ON public.pn_standards FOR ALL USING (true) WITH CHECK (true);
ALTER PUBLICATION supabase_realtime ADD TABLE public.pn_standards;
```

> ⚠️ **עד שה-SQL ירוץ** האפליקציה תמשיך לעבוד: זמני התקן יישמרו בזיכרון המקומי
> (localStorage) של הדפדפן בלבד ולא יסונכרנו בין מכשירים. אחרי יצירת הטבלה
> הם ייסנכרנו אוטומטית בשמירה הבאה.

**איפה זה מופיע:** לשונית ⏱️ *זמן תקן ובפועל* (גרפים, טבלאות לפי מק"ט/שלב/עובד
והמסך להגדרת התקן), מסך הפק"ע (זמן תקן ליחידה וצפי לפי תקן), דוחות הצוות
(פער מול תקן ועמידה בתקן), וייצוא ה-Excel (גיליונות *זמן תקן מול בפועל*
ו-*הגדרות זמן תקן*, ועמודות חדשות בגיליונות פקודות עבודה, לוג עבודה וסיכום).

**נתוני דמו:** כפתור טעינת נתוני הדמו יוצר זמן תקן לכל אחד מ-8 המק"טים
(מזהים שמתחילים ב-`demo_std_`), כך שאפשר לראות מיד את ההשוואה בין תקן, בפועל ומכירה.
