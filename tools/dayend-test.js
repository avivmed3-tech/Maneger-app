#!/usr/bin/env node
/**
 * סוף יום בלי HOLD — work still on the clock at 18:00, and the manager's fix.
 *
 * What has to hold: a job running (or on a break) at 18:00 is caught, whether it
 * is still open or was closed the next morning; one put on HOLD in time, or
 * finished, is not; a job reviewed is not caught again for the same evening; and
 * the manager's fix gives the job back with the real hours — on HOLD from when it
 * stopped, finished then, or still running — so the night is not counted as work.
 *
 * The code under test is lifted straight out of index.html.
 *
 *   npm test
 */
// The end of the day is wall-clock time on the floor.
process.env.TZ="Asia/Jerusalem";
const fs=require("fs"),vm=require("vm"),path=require("path");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");

let fail=0;
const ok=(cond,what)=>{if(!cond)fail++;console.log(`  ${cond?"✓":"✗"} ${what}`)};
const slice=(from,to,what)=>{
  const a=html.indexOf(from),b=html.indexOf(to,a);
  if(a<0||b<0){console.error(`✗ could not find ${what} in index.html`);process.exit(1)}
  return html.slice(a,b);
};
const ctx={console,module:{exports:{}}};
vm.createContext(ctx);
vm.runInContext([
  "let _n=0;const uid=()=>'id'+(++_n);",
  slice("const logKey=","\n","logKey"),
  slice("const isOnHold=","// ── ","the HOLD helpers"),
  slice("const reworkOf=","// ── הפסקות קבועות","the rework and joint-work helpers"),
  slice("const BREAK_DAYS=","// ── מחיר ליחידה","the break and end-of-day helpers"),
  "module.exports={dayEndOf,lastDayEnd,nextDayEnd,dayEndMissed,dayEndRows,dayEndGuess,dayEndFix,clipPauses,logWorkedMin,breakMinOf,isOnHold,jobState};"
].join("\n"),ctx);
const D=ctx.module.exports;

// Monday 19 October 2026, local time.
const L=(h,m=0,d=19)=>new Date(2026,9,d,h,m).getTime();
const I=ms=>new Date(ms).toISOString();
const boss={id:"m1",name:"מנהלת"};
const job=(extra)=>({id:"w1",userId:"u1",userName:"דנה",serialId:"S1",serialSn:"SN-1",stageId:"A",orderId:"o1",startTime:I(L(8)),
  endTime:null,completed:false,durationMin:0,paused:false,pauseStart:null,totalPauseMin:0,pauseLog:[],...(extra||{})});

console.log("\n── 1. when the day ends ───────────────────────────────────");
ok(D.dayEndOf(L(9))===L(18),"18:00 of the same day");
ok(D.lastDayEnd(L(17,59))===L(18,0,18)&&D.lastDayEnd(L(18))===L(18),"the last 18:00 that has passed");
ok(D.nextDayEnd(L(18))===L(18,0,20),"and the next one");

console.log("\n── 2. what is caught ──────────────────────────────────────");
ok(D.dayEndMissed(job(),L(17,59))===null,"17:59 — nothing yet");
ok(D.dayEndMissed(job(),L(18))===L(18),"still running at 18:00 — caught");
ok(D.dayEndMissed(job({paused:true,pauseStart:I(L(17,30)),pauseLog:[{start:I(L(17,30))}]}),L(20))===L(18),"on a break across 18:00 is not HOLD — caught");
const heldOk=job({paused:true,pauseStart:I(L(17)),pauseLog:[{start:I(L(17)),hold:true}],holdInfo:{held:true,heldAt:I(L(17))}});
ok(D.dayEndMissed(heldOk,L(23))===null,"put on HOLD at 17:00 — fine");
ok(D.dayEndMissed({...heldOk,paused:false,pauseStart:null,pauseLog:[{start:I(L(17)),end:I(L(8,0,20)),hold:true}],holdInfo:{held:false,heldAt:I(L(17))}},L(12,0,20))===null,
  "…and carried on from HOLD the next morning — still fine");
ok(D.dayEndMissed(job({completed:true,endTime:I(L(17,59)),durationMin:599}),L(20))===null,"finished at 17:59 — fine");
ok(D.dayEndMissed(job({completed:true,endTime:I(L(7,30,20)),durationMin:1410}),L(9,0,20))===L(18),"finished at 07:30 the next morning — the night was on the clock: caught");
ok(D.dayEndMissed(job({paused:true,pauseStart:I(L(18,30)),pauseLog:[{start:I(L(18,30)),hold:true}],holdInfo:{held:true,heldAt:I(L(18,30))}}),L(20))===L(18),
  "HOLD at 18:30 — it was still running at 18:00: caught, for the manager to confirm");
const evening=job({startTime:I(L(19))});
ok(D.dayEndMissed(evening,L(23))===null,"started at 19:00 — not this evening's");
ok(D.dayEndMissed(evening,L(18,0,20))===L(18,0,20),"but still running the next day at 18:00 — caught then");
ok(D.dayEndMissed(job({startTime:I(L(8,0,5)),completed:true,endTime:I(L(9,0,6))}),L(12))===null,"a week and more ago — not looked at any more");
ok(D.dayEndMissed(job({startTime:I(L(9)),endTime:I(L(9)),completed:true}),L(20))===null,"a sign-off with no timer has nothing to catch");

console.log("\n── 3. the list ─────────────────────────────────────────────");
const g1=job({id:"g1a",bulk:true,bulkGroupId:"G",bulkCount:2}),g2=job({id:"g1b",serialId:"S2",bulk:true,bulkGroupId:"G",bulkCount:2});
const other=job({id:"x1",userId:"u2",userName:"משה"});
const rows=D.dayEndRows([g1,g2,other,heldOk],["u1"],L(20));
ok(rows.length===1&&rows[0].logs.length===2,"a group started together is one row; only the people asked about");
ok(rows[0].at===L(18),"with the 18:00 it ran past");
ok(D.dayEndRows([g1,g2,other],null,L(20)).length===2,"no list of people means everybody");

console.log("\n── 4. what the manager's form opens with ──────────────────");
const withBreak=job({pauseLog:[{start:I(L(12)),end:I(L(12,30))},{start:I(L(19)),end:I(L(19,10))}],totalPauseMin:40});
const g=D.dayEndGuess(withBreak,L(18));
ok(g.S===L(8)&&g.E===L(18),"from the recorded start, to 18:00");
ok(g.pauseMin===30,"with the breaks before 18:00 only — 30 minutes, not 40");
ok(D.dayEndGuess(job({paused:true,pauseStart:I(L(18,20)),holdInfo:{held:true,heldAt:I(L(18,20))}}),L(18)).E===L(18,20),"stopped soon after 18:00 — that is probably when");
ok(D.dayEndGuess(job({completed:true,endTime:I(L(7,30,20))}),L(18)).E===L(18),"closed the next morning — 18:00 it is");

console.log("\n── 5. HOLD from when it really stopped ────────────────────");
const forgot=job({pauseLog:[{start:I(L(12)),end:I(L(12,30))}],totalPauseMin:30});
const hold=D.dayEndFix([forgot],["w1"],{action:"hold",startTime:I(L(8)),endTime:I(L(17,30)),pauseMin:30},boss,I(L(7,0,20)));
const h=hold.next[0];
ok(hold.before.length===1&&hold.before[0]===forgot,"the log as it was is handed back for the journal");
ok(D.isOnHold(h)&&!h.completed&&h.pauseStart===I(L(17,30)),"on HOLD from 17:30");
ok(D.logWorkedMin(h,L(7,0,20))===540,"its clock says 540 minutes (08:00–17:30, less 30) — not the night");
ok(D.breakMinOf(h)===30,"the 30 minutes are a break");
ok(D.dayEndMissed(h,L(7,0,20))===null,"and it is no longer waiting for review");
ok(h.holdInfo.review.byName==="מנהלת"&&h.holdInfo.review.was.state==="run","the review says who, and what it was");

console.log("\n── 6. finished, at the real time ──────────────────────────");
const fin=D.dayEndFix([forgot],["w1"],{action:"done",startTime:I(L(8)),endTime:I(L(16)),pauseMin:30},boss,I(L(7,0,20))).next[0];
ok(fin.completed&&fin.endTime===I(L(16))&&fin.durationMin===450,"signed at 16:00 with 450 minutes (8h less 30)");
ok(fin.serialId==="S1","still the unit's signature");
ok(D.dayEndMissed(fin,L(7,0,20))===null,"nothing left to review");
const fixLog=job({holdInfo:{rework:{reqId:"R1",serialId:"S1",fromStageId:"qc"}}});
const fixed=D.dayEndFix([fixLog],["w1"],{action:"done",startTime:I(L(8)),endTime:I(L(9)),pauseMin:0},boss,I(L(20))).next[0];
ok(fixed.serialId===null&&fixed.holdInfo.rework.serialId==="S1","a fix after inspection signs as a fix — time on its stage, not a second unit");
const closedLate=job({completed:true,endTime:I(L(7,30,20)),durationMin:1410});
const cl=D.dayEndFix([closedLate],["w1"],{action:"hold",startTime:I(L(8)),endTime:I(L(17)),pauseMin:0},boss,I(L(9,0,20))).next[0];
ok(cl.completed&&cl.durationMin===540,"a log already closed stays closed, with the real hours");

console.log("\n── 7. still running, for real ─────────────────────────────");
const run=D.dayEndFix([job()],["w1"],{action:"run",startTime:I(L(9))},boss,I(L(19))).next[0];
ok(!run.completed&&!run.paused&&run.startTime===I(L(9)),"left running, the start corrected to 09:00");
ok(D.dayEndMissed(run,L(23))===null,"this evening is reviewed");
ok(D.dayEndMissed(run,L(18,0,20))===L(18,0,20),"but still running at 18:00 tomorrow — caught again");
ok(D.dayEndFix([job()],["nope"],{action:"run"},boss,I(L(19))).before.length===0,"a job that is not there any more changes nothing");

console.log(fail?`\n✗ ${fail} failed`:"\n✓ all end-of-day checks passed");
process.exit(fail?1:0);
