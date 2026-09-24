#!/usr/bin/env node
/**
 * תוכנית העבודה — the two rules that are easy to get quietly wrong.
 *
 * 1. What a day did not finish moves to the next day. Nothing is rewritten to
 *    make that happen: the row keeps the date it was assigned on, and each screen
 *    asks for "the plans of this day" — its own, plus everything still open from
 *    before. That is one function, plansOfDay(), and everything a manager and a
 *    worker see on their boards comes out of it. A plan that stops rolling (it
 *    was signed off, its פק"ע was deleted or cancelled, its units all cleared the
 *    stage) simply disappears from tomorrow, which is the half worth pinning: a
 *    rule that never lets go turns into a screen nobody can read.
 *
 * 2. A month of scheduling arrives as a spreadsheet, and every row of it is a
 *    claim about people and פק"ע that may not be true — a name that matches two
 *    workers, a פק"ע that was never imported, a stage that is not on its route, a
 *    date Excel handed over as a serial number. buildPlanRows() has to decide all
 *    of that *before* anything is written, and say so row by row.
 *
 * The code under test is lifted straight out of index.html — no JSX in either
 * part — so the test runs the shipped source rather than a copy of it.
 *
 *   npm test
 */
const fs=require("fs"),vm=require("vm"),path=require("path");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");

// One slice of the app file, by the lines that open and close it.
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

const ctx={console,module:{exports:{}}};
vm.createContext(ctx);
// A פק"ע the ERP cancelled is read through the status dictionary, which is a
// screenful of Priority wording this test has no opinion about. Here it is a flag.
vm.runInContext("const isCancelled=o=>!!(o&&o.cancelled);",ctx);
vm.runInContext([
  line("const isoOf=d=>","isoOf"),
  line("const addDaysISO=","addDaysISO"),
  line("const woKey=","woKey"),
  slice("const uid=()=>","// ── Work-time estimation","the plan/date utilities"),
  slice("function orderRoute(order,stages){","// ── \"Has this unit finished this stage?\"","orderRoute"),
  slice("const xlNorm=s=>","function xlPickSheet(","the spreadsheet cell readers"),
  slice("const TPL_PLAN=","const PLAN_LVL=","the work-plan importer"),
  "module.exports={plansOfDay,planIsCarried,planLateDays,planPendingUnits,planHasWorkLeft,PLAN_CARRY_DAYS,PLAN_MAX_SPAN,buildPlanRows,daysHeb,isWeekend,xlRow};"
].join("\n"),ctx);
const {plansOfDay,planIsCarried,planLateDays,planPendingUnits,planHasWorkLeft,
  PLAN_CARRY_DAYS,PLAN_MAX_SPAN,buildPlanRows,daysHeb,isWeekend,xlRow}=ctx.module.exports;

let fail=0;
const ok=(cond,what)=>{if(!cond)fail++;console.log(`  ${cond?"✓":"✗"} ${what}`)};
const eq=(got,want,what)=>{
  const same=JSON.stringify(got)===JSON.stringify(want);
  if(!same)fail++;
  console.log(`  ${same?"✓":"✗"} ${what}${same?"":`   (got ${JSON.stringify(got)}, expected ${JSON.stringify(want)})`}`);
};
const D=n=>{const d=new Date("2026-03-16T00:00:00");d.setDate(d.getDate()+n);
  return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10)};
const TODAY=D(0);   // 2026-03-16, a Monday

// ── 1. מה שלא הסתיים עובר ליום הבא ────────────────────────────────────────
console.log("\n── 1. the unfinished plan rolls forward ───────────────────");
{
  const plans=[
    {id:"today",   date:TODAY,                 done:false},
    {id:"late",    date:D(-1),                 done:false},
    {id:"older",   date:D(-9),                 done:false},
    {id:"signed",  date:D(-1),                 done:true },
    {id:"ancient", date:D(-PLAN_CARRY_DAYS-1), done:false},
    {id:"future",  date:D(3),                  done:false},
  ];
  const board=plansOfDay(plans,TODAY).map(p=>p.id);
  ok(board.includes("today"),"today's own plans are on today's board");
  ok(board.includes("late")&&board.includes("older"),"yesterday's and last week's unfinished work came with them");
  ok(!board.includes("signed"),"a plan that was signed off does not come back");
  ok(!board.includes("future"),"tomorrow's plan stays on tomorrow");
  ok(!board.includes("ancient"),`nothing older than ${PLAN_CARRY_DAYS} days keeps rolling`);
  eq(plansOfDay(plans,TODAY,{carry:false}).map(p=>p.id),["today"],"carry:false is the day on its own — what a past day was actually given");
  eq(plansOfDay(plans,D(-1)).map(p=>p.id),["late","older","signed","ancient"],
    "a past day shows what it held — its own rows, and what was still open behind it");

  // The date on the row is the date it was assigned — that is the whole indicator.
  const late=plans.find(p=>p.id==="late"),own=plans.find(p=>p.id==="today");
  ok(planIsCarried(late,TODAY)&&!planIsCarried(own,TODAY),"a carried plan is the one whose date is earlier than the board's");
  eq(planLateDays(late,TODAY),1,"and it says how late it is");
  eq(planLateDays(plans.find(p=>p.id==="older"),TODAY),9,"nine days late reads as nine");
  eq([1,2,5].map(daysHeb),["יום אחד","יומיים","5 ימים"],"in Hebrew, and in the plural the language actually has");
}

// ── 2. מתי שיבוץ מפסיק לנדוד ──────────────────────────────────────────────
console.log("\n── 2. when a plan stops travelling ────────────────────────");
{
  const stageA="st-a",stageB="st-b";
  const order={id:"o1",woNumber:"WO-1",stageIds:[stageA,stageB],
    serials:[{id:"s1",sn:"A-1"},{id:"s2",sn:"A-2"},{id:"s3",sn:"A-3"}]};
  const qtyOrder={id:"o2",woNumber:"WO-2",stageIds:[stageA],serials:[],qty:40};
  const dead={id:"o3",woNumber:"WO-3",stageIds:[stageA],serials:[],cancelled:true};
  const orders=[order,qtyOrder,dead];
  const logs=[{serialId:"s1",stageId:stageA,completed:true},{serialId:"s2",stageId:stageA,completed:false}];
  const plan=(o,extra)=>Object.assign({id:"p",userId:"u1",date:D(-1),orderId:o,stageId:stageA,done:false,serialIds:[]},extra);

  eq(planPendingUnits(plan("o1"),orders,logs),2,"two of three units still owe the stage");
  eq(planPendingUnits(plan("o1",{serialIds:["s1"]}),orders,logs),0,"a plan that named one finished unit has nothing left");
  eq(planPendingUnits(plan("o1",{stageId:stageB}),orders,logs),3,"the next stage is untouched");
  eq(planPendingUnits(plan("o2"),orders,logs),null,'a פק"ע without serial numbers cannot be counted per unit');

  ok(planHasWorkLeft(plan("o1"),orders,logs),"work left → it rolls forward");
  ok(!planHasWorkLeft(plan("o1",{serialIds:["s1"]}),orders,logs),"every assigned unit signed → it stops");
  ok(planHasWorkLeft(plan("o2"),orders,logs),"counting by quantity, it rolls until somebody signs it off");
  ok(!planHasWorkLeft(plan("o3"),orders,logs),'a cancelled פק"ע takes its plan with it');
  ok(!planHasWorkLeft(plan("gone"),orders,logs),'and so does a deleted one');

  // What the boards actually pass in.
  const rolling=[plan("o1"),Object.assign(plan("o1"),{id:"p2",serialIds:["s1"]})];
  eq(plansOfDay(rolling,TODAY,{stillOpen:p=>planHasWorkLeft(p,orders,logs)}).map(p=>p.id),["p"],
    "the board carries only the plans that still have something in them");
}

// ── 3. תוכנית שלמה מאקסל ──────────────────────────────────────────────────
console.log("\n── 3. a month of scheduling out of a spreadsheet ───────────");
{
  const stages=[{id:"st-a",name:"הלחמה",order:1},{id:"st-b",name:"ביקורת",order:2}];
  const orders=[{id:"o1",woNumber:"WO-1001",pn:"ALF",stageIds:["st-a","st-b"],serials:[{id:"s1",sn:"A-1"}]},
                {id:"o2",woNumber:"WO-1002",pn:"BET",stageIds:["st-a"],serials:[]},
                {id:"o3",woNumber:"WO-DEAD",stageIds:["st-a"],serials:[],cancelled:true}];
  const workers=[{id:"u1",name:"יוסי כהן",username:"yossi",stageAccess:"all"},
                 {id:"u2",name:"דנה לוי",username:"dana",stageAccess:["st-a"]},
                 {id:"u3",name:"דנה לוי",username:"dana2",stageAccess:"all"}];
  // Rows reach the builder the way the reader hands them over: header names
  // normalised, exactly as XLSX.utils.sheet_to_json(...).map(xlRow) leaves them.
  const run=(rows,opts,extra)=>buildPlanRows(rows.map(xlRow),Object.assign(
    {workers,orders,stages,dailyPlans:[],workLogs:[],currentUser:{id:"m1",name:"מנהל"}},extra),opts||{});
  const row=o=>Object.assign({"שם עובד":"יוסי כהן",'פק"ע':"WO-1001","שלב":"הלחמה","תאריך":TODAY},o);

  const one=run([row()]);
  eq(one.stats.plans,1,"a filled row is one assignment");
  eq(one.rows[0].level,"ok","with nothing to report about it");
  eq([one.plans[0].userId,one.plans[0].orderId,one.plans[0].stageId,one.plans[0].date],["u1","o1","st-a",TODAY],
    "resolved to the worker, the פק\"ע, the stage and the day");
  eq(one.plans[0].createdByName,"מנהל","stamped with who scheduled it");

  eq(run([row({"שם עובד":"yossi"})]).plans[0].userId,"u1","a username is a name too");
  eq(run([row({"שם עובד":"יוסי"})]).rows[0].level,"warn","half a name is taken, and said out loud");
  eq(run([row({"שם עובד":"דנה לוי"})]).stats.err,1,"a name two workers answer to is refused, not guessed");
  eq(run([row({"שם עובד":"מי שלא עובד כאן"})]).stats.err,1,"somebody who is not on the list is refused");
  eq(run([row({'פק"ע':"WO-9999"})]).stats.err,1,'a פק"ע the app never imported is refused');
  eq(run([row({'פק"ע':"WO-DEAD"})]).stats.err,1,'a cancelled פק"ע is refused');
  eq(run([row({"שלב":"צביעה"})]).stats.err,1,"a stage that does not exist is refused");
  eq(run([row({'פק"ע':"WO-1002","שלב":"ביקורת"})]).stats.err,1,'a stage that is not on that פק"ע\'s route is refused');
  eq(run([row({"תאריך":""})]).stats.err,1,"a row without a date is refused");
  eq(run([row({"תאריך":"לא תאריך"})]).stats.err,1,"and so is one whose date cannot be read");

  const blank=run([row({"שלב":""})]);
  eq(blank.plans[0].stageId,"st-a","no stage named → the first one on the route that still owes units");
  eq(blank.rows[0].level,"warn","said, rather than done silently");

  const noAccess=run([row({"שם עובד":"דנה לוי","פק\"ע":"WO-1001","שלב":"ביקורת"})]);
  eq(noAccess.stats.plans,0,"an ambiguous name is still ambiguous even when the stage is fine");

  const dana=run([{"שם עובד":"dana",'פק"ע':"WO-1001","שלב":"ביקורת","תאריך":TODAY}]);
  eq([dana.stats.plans,dana.rows[0].level],[1,"warn"],"a stage the worker has no permission for is scheduled, with a warning");

  // ── dates ──
  eq(run([row({"תאריך":"18/03/2026"})]).plans[0].date,"2026-03-18","dd/mm/yyyy is read the way it is written here");
  eq(run([row({"תאריך":46097})]).plans[0].date,"2026-03-16","and so is the serial number Excel actually stores");

  // Mon 16/3 → Sun 22/3: seven days, of which Fri 20 and Sat 21 are the weekend.
  const week=run([row({"עד תאריך":D(6)})]);
  eq(week.stats.plans,5,"a range is one assignment per working day");
  eq(week.plans.map(p=>p.date).some(isWeekend),false,"Friday and Saturday are left out by default");
  eq(run([row({"עד תאריך":D(6)})],{skipWeekend:false}).stats.plans,7,"a plant that works the weekend turns that off");
  eq(run([row({"עד תאריך":D(400)})]).rows[0].msgs.some(m=>m.includes("נקצר")),true,"an end date a year out is a typo — the range is capped");
  ok(run([row({"עד תאריך":D(400)})]).stats.plans<=PLAN_MAX_SPAN+1,"and the cap holds");
  eq(run([row({"עד תאריך":D(-3)})]).rows[0].level,"warn","an end date before the start keeps the one day, and says so");

  // ── nothing is scheduled twice ──
  const existing=[{userId:"u1",date:TODAY,orderId:"o1",stageId:"st-a"}];
  const again=run([row()],{},{dailyPlans:existing});
  eq([again.stats.plans,again.rows[0].level],[0,"warn"],"a plan that is already on the board is skipped, not doubled");
  const twice=run([row(),row()]);
  eq(twice.stats.plans,1,"and the same row twice in one file is still one assignment");

  // ── the rest of the row ──
  eq(run([row({"יעד יחידות":"12","הערה":"להתחיל מהביקורת"})]).plans[0].targetQty,12,"the unit target comes through");
  eq(run([row({"יעד יחידות":""})]).plans[0].targetQty,0,"and blank means all of them");
  eq(run([row({"הערה":"בדחיפות"})]).plans[0].note,"בדחיפות","so does the note the worker will read");
  eq(run([{"שם עובד":"","פק\"ע":"","תאריך":""}]).stats.lines,0,"an empty row is not an error, it is an empty row");

  const mixed=run([row(),row({'פק"ע':"WO-9999"}),row({"תאריך":D(1)})]);
  eq([mixed.stats.ok,mixed.stats.err,mixed.stats.plans],[2,1,2],"a bad row costs its own row and nothing else");
  eq([mixed.stats.workers,mixed.stats.days],[1,2],"the summary counts people and days, not rows");
}

// ── 4. אחזור מחיקה אינו מחזיר שיבוץ שכבר בוטל ─────────────────────────────
// The sequence a manager actually ran: assign two days, delete one, undo the
// assignment, then undo the deletion. The last step used to put the deleted day
// back from its snapshot — a plan taken away twice, back on the worker's screen.
console.log("\n── 4. undoing a delete does not resurrect an undone plan ──");
{
  // The journal module as shipped, around a stub of what it talks to.
  const u=vm.createContext({console,module:{exports:{}}});
  vm.runInContext([
    "let store={};const LS={get:k=>store[k],set:(k,v)=>{store[k]=v}};",
    "let n=0;const uid=()=>'e'+(++n);const nowISO=()=>new Date().toISOString();",
    "const getCompanyId=()=>'c1';const addAuditEntry=()=>uid();const SB={patch:async()=>{}};",
    slice("const UNDO_COLL={","// ── Auth Context","the undo journal"),
    // The app side of a revert: one collection, merged by id exactly as undoApply does.
    "let plans=[];UNDO.setApplier(async(coll,restore,remove)=>{",
    "  const m=new Map(plans.map(r=>[r.id,r]));remove.forEach(id=>m.delete(id));restore.forEach(r=>m.set(r.id,r));plans=[...m.values()]});",
    "module.exports={UNDO,undoScopeText,set:p=>{plans=p},get:()=>plans.map(p=>p.id).sort()};",
  ].join("\n"),u);
  const {UNDO,undoScopeText,set,get}=u.module.exports;
  const user={id:"m1",name:"מנהל"};
  const day1={id:"p23",date:D(-1)},day2={id:"p24",date:TODAY};

  (async()=>{
    set([day1,day2]);
    const assign=UNDO.record({user,action:"שיבוץ תוכנית עבודה",changes:[{coll:"dailyPlans",before:[],after:["p23","p24"]}]});
    set([day1]);
    const del=UNDO.record({user,action:"מחיקת תוכנית עבודה",changes:[{coll:"dailyPlans",before:[day2],after:[]}]});

    ok(!UNDO.isMoot(UNDO.get(del)),"while the assignment stands, undoing the delete is a real undo");
    eq(UNDO.effect(UNDO.get(del))[0].restore.map(r=>r.id),["p24"],"and it would put the deleted day back");

    await UNDO.revert(assign);
    eq(get(),[],"undoing the assignment takes every day of it away");
    ok(UNDO.isMoot(UNDO.get(del)),"after which the delete has nothing left to undo");
    ok(/לא יוחזרו/.test(undoScopeText(UNDO.get(del))),"and the screen says why, instead of offering it");
    let refused="";
    try{await UNDO.revert(del)}catch(e){refused=e.message}
    ok(/אין מה לאחזר/.test(refused),"reverting it anyway is refused with a reason");
    eq(get(),[],"and the deleted day stays deleted — this is the regression");

    // The other order is untouched: undo the delete first, then the assignment.
    // (Fresh ids, as the app's uid() always gives — a row id is never reused.)
    const dayA={id:"q23",date:D(-1)},dayB={id:"q24",date:TODAY};
    set([dayA,dayB]);
    const a2=UNDO.record({user,action:"שיבוץ תוכנית עבודה",changes:[{coll:"dailyPlans",before:[],after:["q23","q24"]}]});
    set([dayA]);
    const d2=UNDO.record({user,action:"מחיקת תוכנית עבודה",changes:[{coll:"dailyPlans",before:[dayB],after:[]}]});
    await UNDO.revert(d2);
    eq(get(),["q23","q24"],"undoing the delete first brings the day back");
    await UNDO.revert(a2);
    eq(get(),[],"and undoing the assignment after it removes both");

    console.log(fail?`\n✗ ${fail} assertion(s) failed`:"\n✓ all assertions passed");
    process.exit(fail?1:0);
  })().catch(e=>{console.error("✗ undo test crashed:",e);process.exit(1)});
}
// The verdict is printed by section 4 once its reverts have run — a revert is
// async, and exiting here would end the test before they got the chance.
