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

## 🔑 פרטי כניסה
| משתמש | סיסמה | תפקיד |
|--------|--------|--------|
| admin  | admin123 | מנהל |
| yossi  | 1234   | עובד |
| dana   | 1234   | עובדת |
| moshe  | 1234   | עובד |
| ronit  | 1234   | עובדת |
| avi    | 1234   | עובד |

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
