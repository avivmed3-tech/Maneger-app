#!/usr/bin/env node
/**
 * How a spreadsheet cell becomes a number — the part that decided הכנסה ממומשת.
 *
 * The reader used to be `Number(String(v).replace(/[^\d.\-]/g,""))`: keep the
 * digits, drop the rest. That is fine for "1,234 ₪" and ruinous for a cell that
 * is not a number, because scraping digits always yields *a* number.
 *
 * The workbook is read with cellDates:true, so a column Excel has a date format
 * on arrives as a JS Date. String(date) is
 * "Thu Jan 25 1900 00:00:00 GMT+0220 (Israel Standard Time)" — and its digits
 * scrape to 2619000000000220, a value that was sitting in the production orders
 * table on the day this test was written. Ninety פק"ע were priced like that, and
 * the dashboard multiplied each by the units that had finished. הכנסה ממומשת
 * read ₪1,604,276,474,982,000 beside a ₪706,388 forecast.
 *
 * So this pins both halves: real prices still parse, and nothing that is not a
 * price is ever turned into one.
 *
 *   npm test
 */
const fs=require("fs"),vm=require("vm"),path=require("path");

// The parser is plain ES — lifted straight out of the app file, no JSX in it.
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const FROM="const XL_EPOCH=Date.UTC(1899,11,30);";
const TO="const xlBool=";
const a=html.indexOf(FROM), b=html.indexOf(TO,a);
if(a<0||b<0){console.error("✗ could not find the number reader in index.html");process.exit(1)}
const ctx={module:{exports:{}}};
vm.createContext(ctx);
vm.runInContext(html.slice(a,b)+"\nmodule.exports={xlNum};",ctx);
const {xlNum}=ctx.module.exports;

let fail=0;
const eq=(got,want,what)=>{
  const ok=Math.abs(got-want)<1e-6;
  if(!ok)fail++;
  console.log(`  ${ok?"✓":"✗"} ${what} → ${got}${ok?"":`   (expected ${want})`}`);
};
// What the old reader did, kept so the regression stays legible.
const scraped=v=>{const n=Number(String(v).replace(/[^\d.\-]/g,""));return isFinite(n)?n:0};
const serial=n=>Math.round((Date.UTC(1899,11,30)+n*864e5-Date.UTC(1899,11,30))/864e5);

console.log("\n── a price column with a date format on it ────────────────");
{
  // cellDates hands back a Date in local time; the serial has to survive the trip.
  const cell=new Date(1900,0,25);            // Excel serial 26
  eq(xlNum(cell),26,"the serial the cell actually holds");
  const before=scraped(cell);
  console.log(`  · the old reader made this ${before} — the shape found in production`);
  if(!/^\d{15,16}$/.test(String(before))){fail++;console.log("  ✗ expected the old reader to produce a 15-16 digit number")}
}

console.log("\n── prices that must keep working ─────────────────────────");
eq(xlNum(1234.56),1234.56,"a plain number");
eq(xlNum(0),0,"zero");
eq(xlNum("1,234.56"),1234.56,"comma thousands");
eq(xlNum("1.234,56"),1234.56,"the other convention");
eq(xlNum("₪ 75,473.70"),75473.7,"currency symbol and spaces");
eq(xlNum("‏1,050‎"),1050,"RTL direction marks around it");
eq(xlNum("(1,234)"),-1234,"accounting negative");
eq(xlNum("1234-"),-1234,"the trailing minus some ERPs write");
eq(xlNum("1 234 567 890"),1234567890,"space-grouped digits");
eq(xlNum(""),0,"a blank cell");
eq(xlNum(null),0,"an empty cell");

console.log("\n── and nothing else may become a number ──────────────────");
for(const junk of ["ET1019C710-001","802-4417-01-000","לא ידוע","12/2024","abc123","-","N/A"]){
  eq(xlNum(junk),0,`"${junk}"`);
}

console.log("\n── the ceiling the dashboard applies on top ──────────────");
{
  // Even if something impossible does get in, one row may not decide a KPI.
  const m=/const MAX_UNIT_PRICE=([\de+]+);/.exec(html);
  if(!m){fail++;console.log("  ✗ MAX_UNIT_PRICE is gone")}
  else{
    const max=Number(m[1]);
    const ok=max>0&&max<=1e9;
    if(!ok)fail++;
    console.log(`  ${ok?"✓":"✗"} a unit price over ₪${max.toLocaleString()} is read as "not priced"`);
  }
}

console.log(fail?`\n✗ ${fail} assertion(s) failed\n`:"\n✓ all assertions passed\n");
process.exit(fail?1:0);
