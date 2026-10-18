#!/usr/bin/env node
/**
 * הפסקות קבועות — fixed breaks a manager sets, that stop and restart the work on
 * their own.
 *
 * What has to hold: work running when the break starts stops at the hour the
 * schedule names, and starts again at its end; doing it twice, or from two
 * devices, writes the same thing once; a break no screen was on for is still taken
 * off the clock afterwards; and work that was already stopped, or started during
 * the break, is left alone.
 *
 * The code under test is lifted straight out of index.html.
 *
 *   npm test
 */
// The schedule is wall-clock time on the floor.
process.env.TZ="Asia/Jerusalem";
const fs=require("fs"),vm=require("vm"),path=require("path"),assert=require("assert");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");

let fail=0;
const ok=(cond,what)=>{if(!cond)fail++;console.log(`  ${cond?"✓":"✗"} ${what}`)};
const same=(a,b)=>{try{assert.deepStrictEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));return true}catch{return false}};
const slice=(from,to,what)=>{
  const a=html.indexOf(from),b=html.indexOf(to,a);
  if(a<0||b<0){console.error(`✗ could not find ${what} in index.html`);process.exit(1)}
  return html.slice(a,b);
};
const ctx={console,module:{exports:{}}};
vm.createContext(ctx);
vm.runInContext([
  slice("const userDeptId=","// Who may open user management","userDeptId"),
  slice("const isOnHold=","\n","isOnHold"),
  slice("const logWorkedMin=","// A manager hands work on HOLD","logWorkedMin"),
  slice("const BREAK_DAYS=","// ── מחיר ליחידה","the break helpers"),
  "module.exports={breakSchedulesFor,breakWindows,applyBreaks,autoBreakOf,logWorkedMin,BREAK_GRACE_MS};"
].join("\n"),ctx);
const B=ctx.module.exports;

// Sunday 18 October 2026, local time.
const L=(h,m=0,d=18)=>new Date(2026,9,d,h,m).getTime();
const I=ms=>new Date(ms).toISOString();
const morning={id:"b1",name:"הפסקת בוקר",start:"10:00",end:"10:15",days:[0,1,2,3,4]};
const wins=(s,now,from=L(0))=>B.breakWindows([s],from,now);
const job=(extra)=>({id:"w1",userId:"u1",serialId:"S1",stageId:"A",startTime:I(L(8)),completed:false,
  paused:false,pauseStart:null,totalPauseMin:0,pauseLog:[],...(extra||{})});
const at=(rec,now,s=morning)=>B.applyBreaks(rec,wins(s,now),now);

console.log("\n── 1. when the breaks are ─────────────────────────────────");
const w=wins(morning,L(12));
ok(w.length===1&&w[0].start===L(10)&&w[0].end===L(10,15),"Sunday 10:00–10:15");
ok(w[0].key==="b1@2026-10-18","keyed by schedule and day");
ok(B.breakWindows([{...morning,days:[5]}],L(0),L(23)).length===0,"a Friday-only break does not happen on Sunday");
ok(B.breakWindows([{...morning,days:[]}],L(0),L(23)).length===1,"no days chosen reads as א–ה");
const night=B.breakWindows([{id:"n",start:"23:50",end:"00:20",days:[0,1,2,3,4,5,6]}],L(0,5),L(1));
ok(night.length===1&&night[0].start===L(23,50,17)&&night[0].end===L(0,20),"a break across midnight belongs to the day it starts on");

console.log("\n── 2. running work stops, and starts again ────────────────");
const j=job();
ok(at(j,L(9,59))===j,"09:59 — nothing yet");
const p=at(j,L(10,0,18)+30000);
ok(p.paused&&p.pauseStart===I(L(10)),"10:00:30 — stopped, at 10:00 sharp");
ok(p.pauseLog.length===1&&p.pauseLog[0].auto==="b1@2026-10-18"&&p.pauseLog[0].until===I(L(10,15)),"marked as the scheduled break, with when it ends");
ok(B.autoBreakOf(p)&&B.autoBreakOf(p).name==="הפסקת בוקר","the screen can tell it is the scheduled break");
ok(at(p,L(10,5))===p,"10:05 — written once, not again");
const back=at(p,L(10,16));
ok(!back.paused&&back.totalPauseMin===15&&back.pauseLog[0].end===I(L(10,15)),"10:16 — back to work, 15 minutes off the clock");
ok(!B.autoBreakOf(back),"no longer on a break");
ok(at(back,L(10,20))===back,"and left alone after that");
ok(B.logWorkedMin(back,L(12))===225,"08:00–12:00 with the break: 225 minutes of work");

console.log("\n── 3. nobody's screen was on ──────────────────────────────");
const late=at(job(),L(11));
ok(!late.paused&&late.totalPauseMin===15,"caught up at 11:00: the 15 minutes come off all the same");
ok(late.pauseLog.length===1&&late.pauseLog[0].start===I(L(10))&&late.pauseLog[0].end===I(L(10,15)),"written as the break it was, already closed");
ok(same(late,at(at(job(),L(10,1)),L(11))),"the same record as if it had been done on time");
ok(at(late,L(11,30))===late,"and only once");

console.log("\n── 4. left alone ──────────────────────────────────────────");
const coffee=job({paused:true,pauseStart:I(L(9,55)),pauseLog:[{start:I(L(9,55))}]});
ok(at(coffee,L(10,5))===coffee&&at(coffee,L(10,30))===coffee,"already on a break of their own at 10:00");
const latecomer=job({startTime:I(L(10,5))});
ok(at(latecomer,L(10,10))===latecomer&&at(latecomer,L(11))===latecomer,"started during the break: somebody chose to work");
const held=job({paused:true,pauseStart:I(L(9)),pauseLog:[{start:I(L(9)),hold:true}],holdInfo:{held:true}});
ok(at(held,L(10,5))===held,"on HOLD");
const doneJob=job({completed:true,endTime:I(L(9,30))});
ok(at(doneJob,L(10,5))===doneJob,"finished before the break");
const idleTask={id:"t1",userId:"u1",active:false,completed:false,startTime:null,paused:false,totalPauseMin:0,pauseLog:[]};
ok(at(idleTask,L(10,5))===idleTask,"a משימה nobody started");
const offSched={...morning,active:false};
ok(B.breakSchedulesFor({id:"u1",departmentId:"d1"},[{id:"d1",breakSchedules:[offSched]}]).length===0,"a schedule switched off");

console.log("\n── 5. the worker steps in ─────────────────────────────────");
// Back to work by hand at 10:07 — what handleResumeWork writes.
const p2=at(job(),L(10,1));
const resumed={...p2,paused:false,pauseStart:null,totalPauseMin:7,pauseLog:[{...p2.pauseLog[0],end:I(L(10,7))}]};
ok(at(resumed,L(10,10))===resumed&&at(resumed,L(10,20))===resumed,"resumed by hand mid-break: not stopped again");
// Stopped by hand at 10:10 while nobody had applied the break yet; still stopped at 10:30.
const manual=job({paused:true,pauseStart:I(L(10,10)),pauseLog:[{start:I(L(10,10))}]});
const m2=at(manual,L(10,30));
ok(m2.totalPauseMin===10&&m2.paused&&m2.pauseStart===I(L(10,10)),"caught up: 10:00–10:10 is the scheduled break, the rest is theirs");
ok(m2.pauseLog.length===2&&!m2.pauseLog[1].end&&m2.pauseLog[0].auto,"their own pause is still the open one, last in the list");
// …and they come back at 10:40: 10 + 30 = 40 minutes stopped in all.
ok(m2.totalPauseMin+30===40,"nothing counted twice: 10:00–10:40 is 40 minutes off the clock");
// Went on to another job during the break: this one waits for them.
const kept=B.applyBreaks(p2,wins(morning,L(10,20)),L(10,20),true);
ok(kept===p2&&B.autoBreakOf(kept),"busy with something else when it ends: it stays stopped, as after a break by hand");

console.log("\n── 6. two devices ─────────────────────────────────────────");
const g=B.BREAK_GRACE_MS;
// The manager's device looks at 10:00:30 as if it were two minutes earlier.
const j6=job();
ok(at(j6,L(10,0)+30000-g)===j6,"a manager's device leaves the first two minutes to the worker's");
const fromWorker=at(job(),L(10,0)+30000),fromManager=at(job(),L(10,2)+30000-g);
ok(same(fromWorker,fromManager),"whichever device writes it, it writes the same thing");
ok(at(fromWorker,L(10,2)+30000-g)===fromWorker,"and the second one writes nothing");

console.log("\n── 7. whose breaks ────────────────────────────────────────");
const deps=[{id:"d1",managerId:"m1",breakSchedules:[morning]},{id:"d2",breakSchedules:[{id:"b2",start:"12:00",end:"12:30",userIds:["u1","u9"]}]}];
ok(B.breakSchedulesFor({id:"u1",departmentId:"d1"},deps).map(s=>s.id).join()==="b1,b2","the department's break, and one set for them by name");
ok(B.breakSchedulesFor({id:"u2",departmentId:"d1"},deps).map(s=>s.id).join()==="b1","a colleague gets only the department's");
ok(B.breakSchedulesFor({id:"m1"},deps).map(s=>s.id).join()==="b1","the department's manager is in the department");
ok(B.breakSchedulesFor({id:"u3",departmentId:""},deps).length===0,"no department, not named: no fixed breaks — ⏸️ by hand, as before");
const two=B.breakWindows(B.breakSchedulesFor({id:"u1",departmentId:"d1"},deps),L(0),L(13));
const lunch=B.applyBreaks(job(),two,L(13));
ok(lunch.totalPauseMin===45&&lunch.pauseLog.length===2,"both of their breaks come off the clock: 15 + 30");

if(fail){console.log(`\n✗ ${fail} failed`);process.exit(1)}
console.log("\n✓ all break checks passed");
