#!/usr/bin/env node
/**
 * What a manager hears: every change in a worker's job — started, joined somebody,
 * a break and back, HOLD and on from it, finished — read off the record as it
 * arrives, and the same changes listed back in the 🔔 panel.
 *
 * What has to hold: each change is told once, as what it is; a scheduled break is
 * not news (it stops a whole department at once); and a HOLD handed to somebody
 * else is not that person "putting it on HOLD".
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
  slice("const isOnHold=","// ── ","the HOLD helpers"),
  slice("const reworkOf=","// ── הפסקות קבועות","the rework, joint-work and activity helpers"),
  slice("const BREAK_DAYS=","// ── מחיר ליחידה","the break helpers"),
  "module.exports={jobState,jobChange,activityFeed,holdHandOff,holdPickUp};"
].join("\n"),ctx);
const A=ctx.module.exports;

const T=(h,m=0)=>`2026-10-19T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00.000Z`;
const job=(extra)=>({id:"w1",userId:"u1",userName:"דנה",serialId:"S1",serialSn:"SN-1",stageId:"A",orderId:"o1",startTime:T(8),
  endTime:null,completed:false,durationMin:0,paused:false,pauseStart:null,totalPauseMin:0,pauseLog:[],...(extra||{})});
const kind=(was,w)=>{const c=A.jobChange(was,w);return c?c.kind:null};

console.log("\n── 1. each change, as what it is ──────────────────────────");
const run=job();
ok(kind("",run)==="start"&&A.jobChange("",run).at===T(8),"a new job on the clock: started, at its start");
ok(kind("",job({holdInfo:{joint:{at:T(8),with:[{userId:"u2",userName:"משה"}]}}}))==="join","started on somebody else's unit: joined them");
const brk=job({paused:true,pauseStart:T(10),pauseLog:[{start:T(10)}]});
ok(kind("run",brk)==="pause"&&A.jobChange("run",brk).at===T(10),"⏸️ a break, at when it began");
const back=job({totalPauseMin:15,pauseLog:[{start:T(10),end:T(10,15)}]});
ok(kind("pause",back)==="resume"&&A.jobChange("pause",back).at===T(10,15),"▶️ back from it, at when it ended");
const held=job({paused:true,pauseStart:T(15),pauseLog:[{start:T(15),hold:true}],holdInfo:{held:true,heldAt:T(15)}});
ok(kind("run",held)==="hold"&&kind("pause",held)==="hold","🟧 HOLD, from running or from a break");
ok(kind("hold",{...held,paused:false,pauseStart:null,holdInfo:{held:false,heldAt:T(15)},pauseLog:[{start:T(15),end:T(16),hold:true}]})==="unhold","▶️ on from HOLD");
ok(kind("run",job({completed:true,endTime:T(12),durationMin:240}))==="done","✅ finished");
ok(kind("run",job({completed:true,endTime:T(12),serialId:null,holdInfo:{joint:{share:true,serialId:"S1"}}}))==="part","👋 left a unit worked on together — their part");
ok(kind("run",run)===null,"nothing changed — nothing said");

console.log("\n── 2. what is not news ────────────────────────────────────");
const auto=job({paused:true,pauseStart:T(10),pauseLog:[{start:T(10),auto:"b1@2026-10-19",until:T(10,15)}]});
ok(A.jobState(auto)==="auto"&&kind("run",auto)===null,"a scheduled break starting");
ok(kind("auto",job({totalPauseMin:15,pauseLog:[{start:T(10),end:T(10,15),auto:"b1@2026-10-19"}]}))===null,"and ending");
ok(kind("done",run)===null,"a signature taken back from the journal");
const task={id:"t1",userId:"u1",userName:"דנה",name:"ניקיון",active:false,completed:false,startTime:null};
ok(A.jobState(task)==="idle"&&kind("",task)===null,"a task given but not started");
ok(kind("idle",{...task,active:true,startTime:T(9)})==="start","and started");

console.log("\n── 3. a HOLD handed on ────────────────────────────────────");
const boss={id:"m1",name:"מנהלת"},moshe={id:"u2",name:"משה"};
const given=A.holdHandOff([held],["w1"],moshe,boss,T(17)).next.find(w=>w.id==="w1");
ok(kind("hold",given)===null,"handed to Moshe, still on HOLD: nothing new for anybody yet");
const picked=A.holdPickUp([held],["w1"],moshe,T(17)).next.find(w=>w.id==="w1");
ok(kind("hold",picked)==="unhold"&&A.jobChange("hold",picked).at===T(17),"Moshe carries it on from the queue: on from HOLD, at that moment");

console.log("\n── 4. the list in the 🔔 panel ────────────────────────────");
const day=job({id:"d1",totalPauseMin:15,completed:true,endTime:T(16),durationMin:465,
  pauseLog:[{start:T(10),end:T(10,15)},{start:T(12),end:T(12,30),auto:"lunch@2026-10-19"}]});
const feed=A.activityFeed([day],[],null,Date.parse(T(0)),"m1");
ok(feed.map(e=>e.kind).join(",")==="done,resume,pause,start","started, a break and back, finished — newest first; the scheduled lunch is not listed");
const g=[job({id:"g1",bulkGroupId:"G"}),job({id:"g2",serialId:"S2",bulkGroupId:"G"})];
const gf=A.activityFeed(g,[],null,Date.parse(T(0)),"m1");
ok(gf.length===1&&gf[0].count===2,"a group started together is one line, of two units");
ok(A.activityFeed([day],[],null,Date.parse(T(0)),"u1").length===0,"what I did myself is not in my list");
ok(A.activityFeed([day],[],["u7"],Date.parse(T(0)),"m1").length===0,"only the people I oversee");
ok(A.activityFeed([day],[],null,Date.parse(T(11)),"m1").map(e=>e.kind).join(",")==="done","only since when I asked");
const sign=job({id:"s1",startTime:T(9),endTime:T(9),completed:true});
ok(A.activityFeed([sign],[],null,Date.parse(T(0)),"m1").map(e=>e.kind).join(",")==="done","a sign-off without a timer is only its signature");
const gk=A.activityFeed([given],[],null,Date.parse(T(0)),"m1").map(e=>e.kind);
ok(!gk.includes("hold"),"a HOLD handed over is not listed as Moshe putting it on HOLD");
const tf=A.activityFeed([],[{...task,active:false,completed:true,startTime:T(9),endTime:T(10),durationMin:60}],null,Date.parse(T(0)),"m1");
ok(tf.map(e=>e.kind).join(",")==="taskdone,task","a task: started, finished");

console.log(fail?`\n✗ ${fail} failed`:"\n✓ all activity checks passed");
process.exit(fail?1:0);
