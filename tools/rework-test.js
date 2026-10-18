#!/usr/bin/env node
/**
 * תיקון לאחר ביקורת — a unit an inspection sends back to an earlier stage.
 *
 * What has to hold: the inspection does not count as passed; the unit waits at
 * the stage it was sent back to, and only there; the stage is not signed again —
 * the fix is time, added to that stage's time and never a second unit; and once
 * the fix is signed the unit is back in line for the inspection.
 *
 * The code under test is lifted straight out of index.html.
 *
 *   npm test
 */
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
  slice("function buildLogIndex(workLogs){","const buildDoneIndex=","buildLogIndex"),
  slice("const isQtyLog=","\n","isQtyLog"),
  slice("const isOnHold=","// ── ","the HOLD helpers"),
  slice("const reworkOf=","// ── הפסקות קבועות","the rework helpers"),
  slice("function stageMinutesFor(","function orderRoute(","stageMinutesFor"),
  slice("function orderRoute(","const logKey=","orderRoute"),
  slice("const pnKey=","\n","pnKey"),
  slice("const stdStageMin=","\n","stdStageMin"),
  slice("function timeSamples(","// Mean / median","timeSamples"),
  "module.exports={buildLogIndex,isQtyLog,holdShares,holdHandOff,isHoldSegment,reworkOf,isReworkReq,isReworkFix,isTimeOnly,buildReworkIndex,reworkAttach,reworkFinish,reworkMinutes,reworkReturn,reworkTargets,orderRoute,timeSamples};"
].join("\n"),ctx);
const R=ctx.module.exports;

const T=(h,m=0)=>`2026-10-18T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00.000Z`;
const dana={id:"u1",name:"דנה"},moshe={id:"u2",name:"משה"},shira={id:"u3",name:"שירה"};
const stages=[{id:"A",name:"הרכבה",order:1},{id:"B",name:"הלחמה",order:2},{id:"C",name:"ביקורת סופית",order:3,inspection:true},{id:"D",name:"אריזה",order:4}];
const order={id:"o1",woNumber:"WO-1",pn:"PN-1",stageIds:["A","B","C","D"],serials:[{id:"S1",sn:"SN-1"},{id:"S2",sn:"SN-2"},{id:"S3",sn:"SN-3"}]};
const log=(id,u,serial,stage,start,end,min,extra)=>({id,userId:u.id,userName:u.name,serialId:serial,serialSn:serial?"SN-"+serial.slice(1):null,stageId:stage,orderId:"o1",
  startTime:start,endTime:end,completed:!!end,durationMin:min,paused:false,pauseStart:null,totalPauseMin:0,pauseLog:[],...(extra||{})});
const signedA=log("a1",dana,"S1","A",T(7),T(7,30),30);
const signedB=log("b1",moshe,"S1","B",T(8),T(8,40),40);
const inspecting=log("c1",shira,"S1","C",T(10),null,0);

console.log("\n── 1. the inspection finds a problem ──────────────────────");
const r=R.reworkReturn([signedA,signedB,inspecting],[{serialId:"S1",serialSn:"SN-1",logId:"c1"}],
  {orderId:"o1",fromStageId:"C",toStageId:"A",note:"הלחמה קרה"},shira,T(10,20));
const ret=r.next.find(w=>w.id==="c1");
ok(r.next.length===3&&r.before.length===1&&!r.made.length,"the inspection that ran becomes the return — no extra record");
ok(ret.completed&&ret.serialId===null&&ret.durationMin===20,"closed with the inspector's 20 minutes and no serial");
ok(R.isReworkReq(ret)&&R.reworkOf(ret).toStageId==="A"&&R.reworkOf(ret).note==="הלחמה קרה","it carries the request: back to הרכבה, with what was found");
ok(!R.isQtyLog(ret)&&R.isTimeOnly(ret),"it is time, not a signature of any kind");
let idx=R.buildLogIndex(r.next);
ok(!idx.done.has("S1|C")&&!idx.running.has("S1|C"),"the inspection is not passed — and nobody is on it");
ok(idx.done.has("S1|A")&&idx.done.has("S1|B"),"הרכבה and הלחמה stay signed");
let open=R.buildReworkIndex(r.next);
ok(open.get("S1")&&open.get("S1").toStageId==="A"&&open.get("S1").fromStageId==="C","the unit waits for a fix at הרכבה");
ok(R.holdShares(r.next)(ret)===0,"the return stands for no unit in the reports");

console.log("\n── 2. the fix ─────────────────────────────────────────────");
const startAtB=R.reworkAttach(log("x1",moshe,"S1","B",T(11),null,0),open);
ok(!R.reworkOf(startAtB),"a start at another stage is not the fix");
const fix=R.reworkAttach(log("f1",dana,"S1","A",T(11),null,0),open);
ok(R.isReworkFix(fix)&&R.reworkOf(fix).reqId===open.get("S1").id,"a start at הרכבה answers the request");
let logs=[...r.next,fix];
ok(R.buildLogIndex(logs).running.has("S1|A"),"while it runs, the unit is off everybody else's queue");
ok(R.buildReworkIndex(logs).has("S1"),"the request is still open until the fix is signed");
const fixed=R.reworkFinish({...fix,completed:true,endTime:T(11,15),durationMin:15});
ok(fixed.serialId===null&&R.reworkOf(fixed).serialId==="S1"&&R.reworkOf(fixed).count===1,"signed: no serial, the unit kept on the note");
ok(!R.isQtyLog(fixed),"and not mistaken for a quantity signature");
logs=[...r.next,fixed];
ok(R.buildReworkIndex(logs).size===0,"the request is closed");
idx=R.buildLogIndex(logs);
ok(idx.done.has("S1|A")&&!idx.done.has("S1|C"),"הרכבה was not signed again; the unit is back in line for the inspection");
const share=R.holdShares(logs);
ok(share(fixed)===0&&share(signedA)===1,"the fix is no unit; dana's original signature still is one");
ok(R.reworkMinutes(logs).get("S1|A")===15,"15 minutes of fixing on הרכבה");
const passed=log("c2",shira,"S1","C",T(12),T(12,10),10);
logs.push(passed);
const samples=R.timeSamples(logs,[order],stages,[],new Map());
const sA=samples.filter(x=>x.stageId==="A"),sC=samples.filter(x=>x.stageId==="C");
ok(sA.length===1&&sA[0].min===45&&sA[0].fix===15,"הרכבה took 30 + 15 = 45 minutes on this unit — one sample, not two");
ok(sC.length===1&&sC[0].min===10,"the inspection is measured by the one that passed it");
ok(samples.length===3,"no sample for the return or for the fix themselves");

console.log("\n── 3. sent back without a timer ───────────────────────────");
const q=R.reworkReturn([signedA,signedB],[{serialId:"S1",serialSn:"SN-1"}],{orderId:"o1",fromStageId:"C",toStageId:"B",note:""},shira,T(10));
const made=q.made[0];
ok(q.made.length===1&&made.id===q.ids[0]&&made.durationMin===0&&made.completed&&made.serialId===null,"a return of its own, with no minutes");
ok(made.userId===shira.id&&made.stageId==="C"&&R.reworkOf(made).toStageId==="B","the inspector's, at the inspection, back to הלחמה");
ok(R.buildReworkIndex(q.next).get("S1").toStageId==="B","the unit waits at הלחמה");
const replay=R.reworkReturn([signedA,signedB],[{serialId:"S1",serialSn:"SN-1"}],{orderId:"o1",fromStageId:"C",toStageId:"B"},shira,T(10),q);
ok(replay.made[0].id===made.id&&R.reworkReturn(q.next,[{serialId:"S1"}],{orderId:"o1",fromStageId:"C",toStageId:"B"},shira,T(10),q).next.length===q.next.length,"replaying the plan writes the very rows the journal recorded, never twice");
// The inspection signed after all (a manager's ✍️): nothing is left waiting.
ok(R.buildReworkIndex([...q.next,log("c9",shira,"S1","C",T(11),T(11),0)]).size===0,"an inspection signed after the return closes it");

console.log("\n── 4. one unit of a group fails ───────────────────────────");
const g=(id,s)=>log(id,shira,s,"C",T(10),null,0,{bulk:true,bulkGroupId:"G",bulkCount:3});
const grp=[g("g1","S1"),g("g2","S2"),g("g3","S3")];
const gr=R.reworkReturn(grp,[{serialId:"S2",serialSn:"SN-2",logId:"g2"}],{orderId:"o1",fromStageId:"C",toStageId:"B"},shira,T(10,30));
const g2=gr.next.find(w=>w.id==="g2");
ok(g2.completed&&g2.bulkGroupId===null&&g2.bulkCount===null,"the failed unit leaves the group, without a count");
ok(gr.next.filter(w=>w.bulkGroupId==="G"&&!w.completed).length===2,"the other two carry on in the inspection");
ok(R.buildReworkIndex(gr.next).has("S2")&&!R.buildReworkIndex(gr.next).has("S1"),"only SN-2 goes back");

console.log("\n── 5. a fix put on HOLD and finished by someone else ──────");
const o5=R.buildReworkIndex(r.next);
const heldFix={...R.reworkAttach(log("f5",dana,"S1","A",T(11),null,0),o5),paused:true,pauseStart:T(11,20),pauseLog:[{start:T(11,20),hold:true}]};
heldFix.holdInfo={...heldFix.holdInfo,held:true,heldAt:T(11,20)};
const h=R.holdHandOff([...r.next,heldFix],["f5"],moshe,moshe,T(13));
const moved=h.next.find(w=>w.id==="f5"),seg=h.next.find(w=>R.isHoldSegment(w));
ok(R.isReworkFix(moved)&&R.reworkOf(moved).reqId===R.reworkOf(heldFix).reqId,"the open fix moves to משה still marked as the fix");
ok(seg&&R.reworkOf(seg)&&seg.durationMin===20,"דנה keeps her 20 minutes, marked as fixing");
ok(R.buildReworkIndex(h.next).has("S1"),"her share does not close the request");
const done5=R.reworkFinish({...moved,completed:true,paused:false,durationMin:10,holdInfo:{...moved.holdInfo,held:false}});
const l5=[...h.next.filter(w=>w.id!=="f5"),done5];
ok(R.buildReworkIndex(l5).size===0,"signed by משה: closed");
ok(R.reworkMinutes(l5).get("S1|A")===30,"the fix took 20 + 10 = 30 minutes, counted once");
ok(R.holdShares(l5)(seg)===0&&R.holdShares(l5)(done5)===0,"and neither of them is a unit");

console.log("\n── 6. where a unit can go back to ─────────────────────────");
const route=R.orderRoute(order,stages);
ok(R.reworkTargets(route,"C").map(s=>s.id).join()==="B,A","from ביקורת סופית: הלחמה (the one before), then הרכבה");
ok(R.reworkTargets(route,"A").length===0,"from the first stage: nowhere");

if(fail){console.log(`\n✗ ${fail} failed`);process.exit(1)}
console.log("\n✓ all rework checks passed");
