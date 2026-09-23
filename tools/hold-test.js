#!/usr/bin/env node
/**
 * HOLD — work stopped in the middle of a stage and, maybe, handed to somebody else.
 *
 * The part that is easy to get quietly wrong is the arithmetic of the handover:
 * the unit must come out *not* done, each worker must keep exactly the minutes
 * they put in, and the unit — once somebody signs it — must count once, not
 * once per person who touched it.
 *
 * Also guards the source itself: index.html is the app, and build.js rewrites it
 * in place. A compiled copy committed by mistake has no source in it at all
 * (that is how PR #49 lost thirteen thousand lines), so the first check here is
 * that the JSX is still in the file.
 *
 * The code under test is lifted straight out of index.html.
 *
 *   npm test
 */
const fs=require("fs"),vm=require("vm"),path=require("path");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");

let fail=0;
const ok=(cond,what)=>{if(!cond)fail++;console.log(`  ${cond?"✓":"✗"} ${what}`)};

console.log("\n── 0. the source is still the source ──────────────────────");
ok(html.includes('<script type="text/babel">'),"index.html still carries its JSX (not a compiled build)");
ok(!/<script defer src="\.\/app\.js/.test(html),"index.html does not point at a generated app.js");
if(fail){console.log(`\n✗ ${fail} failed`);process.exit(1)}

const slice=(from,to,what)=>{
  const a=html.indexOf(from),b=html.indexOf(to,a);
  if(a<0||b<0){console.error(`✗ could not find ${what} in index.html`);process.exit(1)}
  return html.slice(a,b);
};
const ctx={console,module:{exports:{}}};
vm.createContext(ctx);
vm.runInContext([
  "let _n=0;const uid=()=>'id'+(++_n);",
  slice("function buildLogIndex(workLogs){","const buildDoneIndex=","buildLogIndex"),
  slice("const logKey=","\n",'logKey'),
  slice("const isQtyLog=","\n","isQtyLog"),
  slice("const isQtyRun=","\n","isQtyRun"),
  slice("const isOnHold=","// ── ","the HOLD helpers"),
  "module.exports={buildLogIndex,isQtyLog,isOnHold,isHoldSegment,holdCarryMin,holdShares,logWorkedMin,holdHandOff};"
].join("\n"),ctx);
const H=ctx.module.exports;

const T=h=>`2026-09-22T${String(h).padStart(2,"0")}:00:00.000Z`;
const dana={id:"u1",name:"דנה"},moshe={id:"u2",name:"משה"},boss={id:"m1",name:"מנהלת"};
// Dana started at 08:00, took a 30-minute break, and put the unit on HOLD at 11:00.
const held={id:"L1",userId:dana.id,userName:dana.name,serialId:"S1",serialSn:"SN-1",stageId:"st1",orderId:"o1",
  startTime:T(8),endTime:null,completed:false,durationMin:0,paused:true,pauseStart:T(11),totalPauseMin:30,
  pauseLog:[{start:T(9),end:"x"},{start:T(11),hold:true}],holdInfo:{held:true,heldAt:T(11)}};

console.log("\n── 1. on HOLD ─────────────────────────────────────────────");
ok(H.isOnHold(held),"the log reads as on HOLD");
ok(H.logWorkedMin(held,Date.parse(T(20)))===150,"her clock stopped at HOLD: 3h − 30' break = 150'");
ok(H.buildLogIndex([held]).running.has("S1|st1"),"the unit stays off everybody's queue while it waits");

console.log("\n── 2. the manager hands it to Moshe ───────────────────────");
const r=H.holdHandOff([held],["L1"],moshe,boss,T(20));
const moved=r.next.find(w=>w.id==="L1"),seg=r.next.find(w=>H.isHoldSegment(w));
ok(r.next.length===2,"one open log and one segment");
ok(moved.userId===moshe.id&&H.isOnHold(moved),"the open log is Moshe's now, still on HOLD");
ok(H.holdCarryMin(moved)===150,"it carries Dana's 150 minutes");
ok(H.logWorkedMin(moved,Date.parse(T(20)))===0,"Moshe's own clock starts at zero");
ok(seg&&seg.userId===dana.id&&seg.durationMin===150&&seg.completed,"Dana keeps a completed segment of 150'");
const idx=H.buildLogIndex(r.next);
ok(!idx.done.has("S1|st1"),"the segment does NOT mark the unit as done");
ok(idx.running.has("S1|st1"),"the unit is still running (Moshe's)");
ok(!H.isQtyLog(seg),"the segment is not mistaken for a quantity sign-off");
const again=H.holdHandOff(r.next,["L1"],moshe,boss,T(21));
ok(again.next===r.next,"handing it to the person who already holds it changes nothing");

console.log("\n── 3. Moshe finishes: the unit counts once ────────────────");
const fin={...moved,completed:true,paused:false,durationMin:50,holdInfo:{...moved.holdInfo,held:false}};
const logs=[fin,seg];
const share=H.holdShares(logs);
ok(Math.abs(share(fin)-50/200)<1e-9,"Moshe is credited 50/200 of the unit");
ok(Math.abs(share(seg)-150/200)<1e-9,"Dana is credited 150/200 of the unit");
ok(Math.abs(share(fin)+share(seg)-1)<1e-9,"together: exactly one unit");
ok(H.buildLogIndex(logs).done.has("S1|st1"),"the stage is done once Moshe signs it");
ok(H.holdShares([seg])(seg)===0,"before anyone signs, a segment stands for no unit yet");

console.log(fail?`\n✗ ${fail} failed`:"\n✓ all HOLD checks passed");
process.exit(fail?1:0);
