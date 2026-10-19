#!/usr/bin/env node
/**
 * עבודה משותפת — two people (or more) on one unit, on the same stage, at once.
 *
 * What has to hold: each person keeps exactly the minutes they put in; the stage
 * gets all of them together; and the unit is signed — and counted, and paid —
 * once, whether the stage is closed for everybody at once or people leave one by
 * one and the last one signs it.
 *
 * The code under test is lifted straight out of index.html.
 *
 *   npm test
 */
const fs=require("fs"),vm=require("vm"),path=require("path");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");

let fail=0;
const ok=(cond,what)=>{if(!cond)fail++;console.log(`  ${cond?"✓":"✗"} ${what}`)};
const near=(a,b)=>Math.abs(a-b)<1e-9;
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
  slice("const reworkOf=","// ── הפסקות קבועות","the rework and joint-work helpers"),
  slice("function stageMinutesFor(","function orderRoute(","stageMinutesFor"),
  slice("function orderRoute(","const logKey=","orderRoute"),
  slice("const pnKey=","\n","pnKey"),
  slice("const stdStageMin=","\n","stdStageMin"),
  slice("function timeSamples(","// Mean / median","timeSamples"),
  "module.exports={buildLogIndex,isQtyLog,isOnHold,isTimeOnly,holdShares,logWorkedMin,canJoin,jointPartners,jointClose,jointMinutes,"+
    "isJointShare,jointOf,reworkOf,buildReworkIndex,reworkMinutes,reworkFinish,timeSamples};"
].join("\n"),ctx);
const J=ctx.module.exports;

const T=(h,m=0)=>`2026-10-19T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00.000Z`;
const ms=(h,m=0)=>Date.parse(T(h,m));
const dana={id:"u1",name:"דנה"},moshe={id:"u2",name:"משה"},rina={id:"u3",name:"רינה"};
const open=(id,who,startH,extra)=>({id,userId:who.id,userName:who.name,serialId:"S1",serialSn:"SN-1",stageId:"st1",orderId:"o1",
  startTime:T(startH),endTime:null,completed:false,durationMin:0,paused:false,pauseStart:null,totalPauseMin:0,pauseLog:[],...(extra||{})});
const joinOf=(id,who,startH,withWho)=>open(id,who,startH,{holdInfo:{joint:{at:T(startH),with:withWho.map(u=>({userId:u.id,userName:u.name}))}}});
// What handleEndWork does to a log it signs.
const sign=(w,h)=>J.reworkFinish({...w,completed:true,endTime:T(h),durationMin:J.logWorkedMin(w,ms(h))});
const order={id:"o1",woNumber:"WO-1",pn:"PN-1",serials:[{id:"S1",sn:"SN-1"}],stageIds:["st1"]};
const stage={id:"st1",name:"הרכבה",order:1,minutes:60};

console.log("\n── 1. somebody is on the unit — and it can be joined ──────");
const L1=open("L1",dana,8);
ok(J.canJoin(L1),"a unit on a timer of its own can be joined");
ok(!J.canJoin({...L1,bulkGroupId:"g1"}),"a unit running in a group cannot — the group moves as one");
ok(!J.canJoin({...L1,paused:true,pauseStart:T(9),holdInfo:{held:true}}),"a unit on HOLD is carried on from HOLD, not joined");
const L2=joinOf("L2",moshe,9,[dana]);
const both=[L1,L2];
ok(J.jointPartners(both,"S1","st1",moshe.id).map(w=>w.id).join()==="L1","Moshe works with Dana");
ok(J.jointPartners(both,"S1","st1",dana.id).map(w=>w.id).join()==="L2","and Dana with Moshe");
ok(J.buildLogIndex(both).running.has("S1|st1")&&!J.buildLogIndex(both).done.has("S1|st1"),"the unit is running, not done");

console.log("\n── 2. Moshe leaves first: only his part ───────────────────");
const p=J.jointClose(both,"L2","part",moshe,T(10));
const share=p.next.find(w=>w.id==="L2");
ok(p.before.length===1&&p.before[0].id==="L2","only his log closes");
ok(share.completed&&share.serialId===null&&J.isJointShare(share),"it closes as his share — no serial");
ok(share.durationMin===60&&share.userId===moshe.id,"with his 60 minutes, on his name");
ok(J.jointOf(share).serialId==="S1","the unit is kept on the share");
ok(J.isTimeOnly(share)&&!J.isQtyLog(share),"time only — never a unit, never a quantity sign-off");
ok(!J.buildLogIndex(p.next).done.has("S1|st1")&&J.buildLogIndex(p.next).running.has("S1|st1"),"the unit is still not done — Dana is still on it");
ok(!J.jointOf(share).closedById,"he closed it himself, so nobody else is named");
const last=J.jointClose(p.next,"L1","part",dana,T(11));
ok(last.before.length===0,"Dana is alone now — there is no part to leave, she signs");

console.log("\n── 3. Dana signs: the unit counts once, the stage gets both ─");
const logsA=p.next.map(w=>w.id==="L1"?sign(w,11):w);
const dA=logsA.find(w=>w.id==="L1");
ok(dA.durationMin===180&&dA.serialId==="S1","Dana's own 180 minutes, on the signature");
ok(logsA.filter(w=>w.completed&&w.serialId==="S1").length===1,"one signature on the unit");
const shA=J.holdShares(logsA);
ok(near(shA(dA),0.75)&&near(shA(share),0.25),"the unit is shared by their minutes: ¾ Dana, ¼ Moshe");
ok(near(shA(dA)+shA(share),1),"and adds up to one unit");
ok(J.jointMinutes(logsA).get("S1|st1")===60,"the stage carries Moshe's 60 beside Dana's signature");
const smp=J.timeSamples(logsA,[order],[stage],[],new Map());
ok(smp.length===1,"one sample of זמן בפועל for the unit — not one per person");
ok(smp[0].min===240&&smp[0].together===60,"the stage took 240 minutes in all: 180 + 60");

console.log("\n── 4. the stage is done — for everybody at once ───────────");
const a=J.jointClose(both,"L1","all",dana,T(11));
const mShare=a.next.find(w=>w.id==="L2");
ok(a.before.length===1&&a.before[0].id==="L2","Moshe's log is the one that closes here; Dana's is signed by the caller");
ok(a.next.find(w=>w.id==="L1")===L1,"Dana's log is left as it was for the signature");
ok(J.isJointShare(mShare)&&mShare.durationMin===120,"Moshe gets his 120 minutes (09:00–11:00)");
ok(J.jointOf(mShare).closedById===dana.id&&J.jointOf(mShare).closedByName==="דנה","and it says Dana closed it");
const logsB=a.next.map(w=>w.id==="L1"?sign(w,11):w);
ok(J.buildLogIndex(logsB).done.has("S1|st1")&&!J.buildLogIndex(logsB).running.has("S1|st1"),"the unit is done, and nobody is left on it");
ok(J.timeSamples(logsB,[order],[stage],[],new Map())[0].min===300,"the stage took 300 minutes: 180 + 120");

console.log("\n── 5. a partner stopped when it closes ────────────────────");
const onBreak={...L2,paused:true,pauseStart:T(10,30),pauseLog:[{start:T(10,30)}]};
const b=J.jointClose([L1,onBreak],"L1","all",dana,T(11)).next.find(w=>w.id==="L2");
ok(b.durationMin===90,"on a break since 10:30: his time stops there — 90 minutes");
ok(b.totalPauseMin===30&&b.pauseLog[0].end===T(11)&&!b.paused,"and the break is closed at 11:00, 30 minutes");
const onHold={...L2,paused:true,pauseStart:T(10),pauseLog:[{start:T(10),hold:true}],holdInfo:{...L2.holdInfo,held:true,heldAt:T(10)}};
ok(J.jointPartners([L1,onHold],"S1","st1",dana.id).length===1,"a partner on HOLD is still on the unit");
const h=J.jointClose([L1,onHold],"L1","all",dana,T(11)).next.find(w=>w.id==="L2");
ok(h.durationMin===60&&h.holdInfo.held===false&&h.holdInfo.holdMin===60,"on HOLD since 10:00: 60 minutes of work, and the hour after is HOLD, not a break");

console.log("\n── 6. three people ────────────────────────────────────────");
const L3=joinOf("L3",rina,10,[dana,moshe]);
const three=J.jointClose([L1,L2,L3],"L1","all",dana,T(12));
ok(three.before.length===2,"both partners close as shares");
const logsC=three.next.map(w=>w.id==="L1"?sign(w,12):w);
const shC=J.holdShares(logsC),get=id=>logsC.find(w=>w.id===id);
ok(get("L2").durationMin===180&&get("L3").durationMin===120,"Moshe 180, Rina 120");
ok(near(shC(get("L1"))+shC(get("L2"))+shC(get("L3")),1),"the unit is still exactly one unit between the three");
ok(J.timeSamples(logsC,[order],[stage],[],new Map())[0].min===240+180+120,"the stage: 240 + 180 + 120");

console.log("\n── 7. a fix after inspection, worked on together ──────────");
const req={req:true,id:"R1",serialId:"S1",toStageId:"st1",fromStageId:"qc",at:T(7),note:"",byName:"מבקר"};
const ret={id:"R1",userId:"u9",userName:"מבקר",serialId:null,serialSn:"SN-1",stageId:"qc",orderId:"o1",startTime:T(7),endTime:T(7),completed:true,durationMin:0,holdInfo:{rework:req}};
const passed={id:"P0",userId:"u1",userName:"דנה",serialId:"S1",stageId:"st1",orderId:"o1",startTime:T(5),endTime:T(6),completed:true,durationMin:60};
const fx=r=>({rework:{reqId:"R1",serialId:"S1",fromStageId:"qc",note:"",byName:"מבקר",at:T(7)},...(r||{})});
const F1=open("F1",dana,8,{holdInfo:fx()}),F2=joinOf("F2",moshe,8,[dana]);F2.holdInfo={...F2.holdInfo,...fx()};
const fp=J.jointClose([passed,ret,F1,F2],"F2","part",moshe,T(9));
ok(J.buildReworkIndex(fp.next).has("S1"),"Moshe leaving his part does not close the request — Dana is still fixing");
const fs2=fp.next.find(w=>w.id==="F2");
ok(J.reworkOf(fs2)&&J.reworkOf(fs2).serialId==="S1"&&J.reworkOf(fs2).count===1,"his share is still a share of the fix, of that unit");
const fDone=fp.next.map(w=>w.id==="F1"?sign(w,10):w);
ok(!J.buildReworkIndex(fDone).has("S1"),"Dana signs the fix: the request is closed");
ok(J.reworkMinutes(fDone).get("S1|st1")===120+60,"the stage gets both fixes' minutes: 120 + 60");
ok(fDone.filter(w=>w.completed&&w.serialId==="S1").length===1,"and the stage is still signed once — the original pass");

console.log(fail?`\n✗ ${fail} failed`:"\n✓ all joint-work checks passed");
process.exit(fail?1:0);
