#!/usr/bin/env node
/**
 * The Priority export, under every set of headers it has come out with.
 *
 * The report is recognised by its header row, and then each field is read by
 * its header name. Those are two different checks, and the gap between them is
 * how a whole file disappeared: the DataSheet export names the פק"ע column plain
 * פק'ע instead of מספר פק"ע. Detection accepted it (the serials sheet already
 * used that name), and then every one of 76,087 rows was skipped as "no פק"ע
 * number" — the import screen said 0 orders and nothing else was wrong.
 *
 * So this reads the same three orders twice, once under the older headers and
 * once under the DataSheet ones, and requires the two to come out identical —
 * and requires them to come out *right*, so "identical" can't mean "both empty".
 *
 * The code under test is lifted straight out of index.html (no JSX in it), and
 * the only stand-in is XLSX.utils.sheet_to_json, which priDetect uses to read
 * the header row.
 *
 *   npm test
 */
const fs=require("fs"),vm=require("vm"),path=require("path");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");

const slice=(from,to,what)=>{
  const a=html.indexOf(from),b=html.indexOf(to,a);
  if(a<0||b<0){console.error(`✗ could not find ${what} in index.html`);process.exit(1)}
  return html.slice(a,b);
};
const line=(starts,what)=>{
  const a=html.indexOf(starts);
  if(a<0){console.error(`✗ could not find ${what} in index.html`);process.exit(1)}
  return html.slice(a,html.indexOf("\n",a));
};

// A sheet here is just its rows as arrays; sheet_to_json({header:1}) hands them back.
const XLSX={utils:{sheet_to_json:(ws,o)=>o&&o.header===1?ws.aoa:[]}};
const ctx={console,XLSX,module:{exports:{}}};
vm.createContext(ctx);
vm.runInContext([
  line("const branchCode=v=>","branchCode"),
  line("const COLORS=[","COLORS"),
  line("const uid=()=>","uid"),
  line("const todays=()=>","todays"),
  line("const nowISO=()=>","nowISO"),
  line("const isoOf=d=>","isoOf"),
  line("const pnKey=pn=>","pnKey"),
  slice("function pnStdIndex(","const stdStageMin=","pnStdIndex"),
  slice("function isoDay(","// ── DB row converters","isoDay"),
  slice("const xlNorm=s=>","function xlPickSheet(","the spreadsheet cell readers"),
  slice("const PRI_H=","// ── ייבוא חוזר","the Priority importer"),
  "module.exports={priDetect,priScan,priBuild,priAutoMap,priStatus,xlRow};"
].join("\n"),ctx);
const {priDetect,priScan,priBuild,priAutoMap,priStatus,xlRow}=ctx.module.exports;

let fail=0;
const ok=(cond,what)=>{if(!cond)fail++;console.log(`  ${cond?"✓":"✗"} ${what}`)};
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// ── The same three orders, as data ───────────────────────────────────────
// Rows deliberately out of route order: the route must come from the step
// number, not from where the row happened to sit in the file.
const D=(y,m,d)=>new Date(Date.UTC(y,m-1,d));
const ROWS=[
  // wo,        qty, status,         release,       end,           pn,         desc,         seq, op,      opDesc,          wc,      rep, rem, std,   br,  price, project
  ["CLT-08236", 3,  "בתהליך ייצור",  D(2025,1,14),  D(2025,12,31), "1034H070",  "SR15 ER",    300, "AC020M","חיתוך חוטים",    "JC020M", 1,  2,  "1800", "52", 0,     "PR-0000168"],
  ["CLT-08236", 3,  "בתהליך ייצור",  D(2025,1,14),  D(2025,12,31), "1034H070",  "SR15 ER",    100, "AC005M","איסוף חומר",     "JC010M", 3,  0,  "1800", "52", 0,     "PR-0000168"],
  ["CLT-08236", 3,  "בתהליך ייצור",  D(2025,1,14),  D(2025,12,31), "1034H070",  "SR15 ER",    200, "AC010M","חיתוך כבלים",    "JC020M", 2,  1,  "1800", "52", 0,     "PR-0000168"],
  ["21410970.", 25, "MRB",           D(2026,6,10),  "",            "ET1096C300","UNIT F/ASSY",20,  "99",    "ביקורת",         "EL030",  0,  25, "5",    "51", 750,   ""],
  ["16.3.25...",200,"ממתין לכיול",   D(2025,3,16),  "",            "ET5205F750","COIL T =3.5",10,  "AC003", "איסוף חומר",     "JC010M", 0,  200,"0.01", "53", 0,     "PR-0000090"],
];
const toObj=(head,r)=>Object.fromEntries(head.map((h,i)=>[h,r[i]]));
const proj=r=>[r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[7],r[8],r[9],r[10],r[11],r[12],r[13],r[14],r[15],r[16]];

// The headers the importer was written against.
const OLD=['מספר פק"ע','כמות','סטטוס פק"ע','תאריך שחרור','ת. סיום יצור','מק"ט','תיאור מוצר','שלב בפק"ע',
  'פעולה','תאור פעולה','מרכז עבודה','כמות מדווחת','יתרה לבצוע',"ז.תקן ליח' בדק' למקט",'סניף',"מחיר אלת'א בש'ח",'פרויקט'];
// The DataSheet export, exactly as Priority writes it — including the columns the
// app does not read, in their own places, because a near-miss name among them
// (פק'ע לקוח, תאור פרויקט, ת. התחלת יצור) must not be taken for the real one.
const NEW_FULL=["פק'ע","כ. הפק'ע","פק'ע לקוח","סטטוס פק'ע",'ת. התחלת יצור','ת. סיום יצור','ת. שחרור',"מק'ט",
  'תאור מוצר','שלב','פעולה','תאור פעולה','מרכז עבודה','זמן עובד','זמן מכונה','כמות מדווחת','יתרה לבצוע',
  "ז.תקן ליח' בדק' למקט","ז.תקן ליח' בדק' בפקע",'סניף',"מס' דרישה אלת'א","מחיר אלת'א בש'ח",'פרוייקט',
  'תאור פרויקט','תהליך','תאור תהליך'];
const newRow=r=>{
  const [wo,qty,status,release,end,pn,desc,seq,op,opDesc,wc,rep,rem,std,br,price,project]=proj(r);
  return toObj(NEW_FULL,[wo,qty,"99999999",status,D(2029,10,2),end,release,pn,desc,seq,op,opDesc,wc,0,0,
    rep,rem,std,0,br,"184426528",price,project,"תיאור של "+project,"PR060M","הרכבה + חיווט"]);
};

const oldRows=ROWS.map(r=>xlRow(toObj(OLD,proj(r))));
const newRows=ROWS.map(r=>xlRow(newRow(r)));

console.log("\nזיהוי הקובץ");
const sheet=(head,rows)=>({aoa:[head,...rows.map(o=>head.map(h=>o[h]))]});
const wbOld={SheetNames:["Sheet1"],Sheets:{Sheet1:sheet(OLD,ROWS.map(r=>toObj(OLD,proj(r))))}};
const wbNew={SheetNames:["DataSheet"],Sheets:{DataSheet:sheet(NEW_FULL,ROWS.map(newRow))}};
ok(!!priDetect(wbOld),"הכותרות הישנות מזוהות כדוח Priority");
ok(!!priDetect(wbNew),"קובץ DataSheet מזוהה כדוח Priority");
ok(priDetect(wbNew)?.routes===wbNew.Sheets.DataSheet,"גיליון DataSheet נבחר כגיליון הפעולות");

console.log("\nקריאת השורות — הכותרות החדשות");
const sNew=priScan(newRows,[]),sOld=priScan(oldRows,[]);
ok(sNew.skipped===0,`אף שורה לא דולגה כ״ללא מספר פק"ע״ (דולגו: ${sNew.skipped})`);
ok(sNew.wos.length===3,`5 שורות פעולה קופלו ל-3 פק"ע (${sNew.wos.length})`);
const w=sNew.wos.find(x=>x.wo==="CLT-08236")||{};
ok(w.qty===3,"כ. הפק'ע נקרא ככמות");
ok(w.desc==="SR15 ER","תאור מוצר נקרא כתיאור");
ok(w.project==="PR-0000168","פרוייקט נקרא כפרויקט — ולא תאור פרויקט");
ok(w.release==="2025-01-14","ת. שחרור נקרא כתאריך שחרור");
ok(w.endDate==="2025-12-31","ת. סיום יצור נקרא כיעד — ולא ת. התחלת יצור");
ok(w.branch==="52","סניף נקרא");
ok(w.statusRaw==="בתהליך ייצור","סטטוס פק'ע נקרא");
ok(eq(w.ops?.map(o=>o.seq).sort((a,b)=>a-b),[100,200,300]),"שלב נקרא כמספר השלב בפק\"ע");
ok(eq(w.ops?.map(o=>o.std),[1800,1800,1800]),"זמן התקן שנכתב כטקסט נקרא כמספר");
ok(sNew.wos.find(x=>x.wo==="21410970.")?.price===750,"מחיר אלת'א נקרא");

console.log("\nהכותרות הישנות והחדשות נותנות אותה תוצאה");
ok(eq(sNew,sOld),"priScan זהה בשני הפורמטים");

console.log("\nבניית הפק\"ע");
const build=s=>priBuild(s,{projects:[],stages:[],pnStandards:[]},priAutoMap(s.ops,[],{}),{});
const bNew=build(sNew);
const o=bNew.orders.find(x=>x.woNumber==="CLT-08236")||{};
const names=new Map(bNew.newStages.map(s=>[s.id,s.name]));
ok(eq((o.stageIds||[]).map(id=>names.get(id)),["איסוף חומר","חיתוך כבלים","חיתוך חוטים"]),
  "המסלול לפי עמודת שלב (100 → 200 → 300), לא לפי סדר השורות בקובץ");
ok(o.qty===3&&o.receivedDate==="2025-01-14"&&o.targetDate==="2025-12-31","כמות ותאריכים הגיעו לפק\"ע");
const units=sid=>bNew.logs.filter(l=>l.orderId===o.id&&l.stageId===sid).reduce((a,l)=>a+(l.bulkCount||1),0);
ok(eq((o.stageIds||[]).map(units),[3,2,1]),"ההתקדמות מ-כמות מדווחת נרשמה לכל שלב (3 · 2 · 1)");
ok(bNew.orders.length===3&&bNew.stats.noBranchSkipped===0,"כל 3 הפק\"ע נבנו");
// Ids (order, stage, project) are fresh on every build; everything else must match.
const strip=b=>JSON.stringify(b.orders.map(x=>({...x,id:0,projectId:!!x.projectId,stageIds:x.stageIds.length,serials:0})));
ok(strip(bNew)===strip(build(sOld)),"הפק\"ע שנבנו זהות בשני הפורמטים");

console.log("\nסטטוסים שהופיעו לראשונה בקובץ DataSheet");
const st=s=>priStatus(s);
ok(!st("ממתין לכיול").guessed&&st("ממתין לכיול").phase==="line","ממתין לכיול — בתהליך ייצור, לא ניחוש");
ok(!st("בסגירה קבמ").guessed&&st("בסגירה קבמ").phase==="line","בסגירה קבמ — בתהליך ייצור, לא ניחוש");
ok(!st("MRB").guessed&&st("MRB").phase==="stuck"&&st("MRB").st==="blocked","MRB — עצורה, לא ״בתהליך״");
ok(!bNew.issues.some(i=>/שאינו ברשימה/.test(i.msg)),"אין בקובץ סטטוס שנכנס כניחוש");

console.log(fail?`\n✗ ${fail} בדיקות נכשלו`:"\n✓ כל הבדיקות עברו");
process.exit(fail?1:0);
