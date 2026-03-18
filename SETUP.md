# 📋 הנחיות הגדרת Google Sheet — ניהול קו ייצור

## שלב 1: יצירת Google Sheet חדש
1. היכנס ל-https://sheets.google.com
2. לחץ על **"גיליון אלקטרוני ריק"**
3. שנה את השם ל: **"ניהול קו ייצור — Data"**

## שלב 2: יצירת הגיליונות (Sheets)
צור 3 גיליונות (טאבים בתחתית):
- **data** — כאן יישמרו הפקעות, שלבים, פרויקטים, ולוגי עבודה
- **users** — כאן יישמרו המשתמשים
- **audit** — כאן יישמר לוג הפעילות

## שלב 3: פתיחת Apps Script
1. בתפריט העליון: **הרחבות** → **Apps Script**
2. מחק את כל הטקסט ב-`Code.gs`
3. הדבק את הקוד הבא:

```javascript
const SHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();

function doGet(e) {
  const type = e.parameter.type;
  
  if (type === "users") {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName("users");
    if (!sheet || sheet.getLastRow() < 2) return ContentService.createTextOutput("[]").setMimeType(ContentService.MimeType.JSON);
    const data = sheet.getRange("A2").getValue();
    return ContentService.createTextOutput(data).setMimeType(ContentService.MimeType.JSON);
  }
  
  // Default: load main data
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName("data");
  if (!sheet || sheet.getLastRow() < 2) return ContentService.createTextOutput("{}").setMimeType(ContentService.MimeType.JSON);
  const data = sheet.getRange("A2").getValue();
  return ContentService.createTextOutput(data).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  
  if (body.action === "saveUsers") {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName("users");
    sheet.getRange("A1").setValue("users_json");
    sheet.getRange("A2").setValue(JSON.stringify(body.users));
    return ContentService.createTextOutput("ok").setMimeType(ContentService.MimeType.TEXT);
  }
  
  if (body.action === "save") {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName("data");
    sheet.getRange("A1").setValue("data_json");
    sheet.getRange("A2").setValue(JSON.stringify(body.payload));
    return ContentService.createTextOutput("ok").setMimeType(ContentService.MimeType.TEXT);
  }
  
  return ContentService.createTextOutput("unknown action").setMimeType(ContentService.MimeType.TEXT);
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

## שלב 6: העלאה ל-Netlify
1. היכנס ל-https://app.netlify.com
2. גרור את תיקיית `app` לאזור ה-Deploy
3. המתן לסיום ההעלאה
4. קבל URL כמו: `https://random-name.netlify.app`

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
