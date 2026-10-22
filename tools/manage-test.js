#!/usr/bin/env node
/**
 * A manager opens a job of their people — running, on HOLD or finished — sees it
 * day by day, corrects its hours, and moves it on for a worker who forgot to.
 *
 * What has to hold: the days, starts, stops and breaks read off the record as
 * they happened; an edit that changes nothing changes no figure, and one that
 * does keeps every total consistent (worked minutes, breaks, HOLD); a scheduled
 * break taken off stays off; a change of state lands at the moment the manager
 * names, never before what is already on the record, and leaves the job exactly as
 * if its worker had pressed the button then; a unit somebody else is still on is
 * finished as a share, not signed twice.
 *
 * The code under test is lifted straight out of index.html.
 *
 *   npm test
 */
// Days are wall-clock days on the floor.
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
  slice("const isQtyRun=","\n","isQtyRun"),
  slice("const isOnHold=","// ── ","the HOLD helpers"),
  slice("const reworkOf=","// ── הפסקות קבועות","the rework and joint-work helpers"),
  slice("const BREAK_DAYS=","// ── מחיר ליחידה","the break, end-of-day and manager helpers"),
  "module.exports={jobStops,jobDays,jobEditBase,jobEditCheck,jobEditNet,jobEdit,jobSetState,jobSig,jobEarliest,isNoTimer,",
  "  applyBreaks,breakWindows,dayEndMissed,logWorkedMin,breakMinOf,breakCountOf,isOnHold,jobState,isJointShare,holdHandOff,holdCarryMin};"
].join("\n"),ctx);
const M=ctx.module.exports;

// Monday 19 October 2026, local time.
const L=(h,m=0,d=19)=>new Date(2026,9,d,h,m).getTime();
const I=ms=>new Date(ms).toISOString();
const boss={id:"m1",name:"מנהלת"};
const job=(extra)=>({id:"w1",userId:"u1",userName:"דנה",serialId:"S1",serialSn:"SN-1",stageId:"A",orderId:"o1",startTime:I(L(8)),
  endTime:null,completed:false,durationMin:0,paused:false,pauseStart:null,totalPauseMin:0,pauseLog:[],...(extra||{})});
const NOW=L(20,0,20);   // Tuesday 20:00

console.log("\n── 1. the job day by day ──────────────────────────────────");
// Mon 08:00 start, 10:00–10:15 break, 17:00 HOLD, Tue 08:00 back, 12:00–12:30 break, 15:00 done.
const twoDays=job({completed:true,endTime:I(L(15,0,20)),
  pauseLog:[{start:I(L(10)),end:I(L(10,15))},{start:I(L(17)),end:I(L(8,0,20)),hold:true},{start:I(L(12,0,20)),end:I(L(12,30,20))}],
  totalPauseMin:15+15*60+30,holdInfo:{holdMin:15*60}});
twoDays.durationMin=Math.round((L(15,0,20)-L(8))/60000)-twoDays.totalPauseMin;
const days=M.jobDays(twoDays,NOW);
ok(days.length===2,"two days of work — the night on HOLD is not a day of it");
ok(days[0].from===L(8)&&days[0].to===L(17)&&days[0].workMin===8*60+45&&days[0].breakMin===15,
  "Monday: 08:00–17:00, 8:45 of work, a 15-minute break");
ok(days[1].from===L(8,0,20)&&days[1].to===L(15,0,20)&&days[1].workMin===6*60+30&&days[1].breakMin===30,
  "Tuesday: 08:00–15:00, 6:30 of work, a 30-minute break");
ok(days[0].workMin+days[1].workMin===twoDays.durationMin,"the days add up to the job's minutes");
const k0=days[0].items.map(i=>i.kind).join(","),k1=days[1].items.map(i=>i.kind).join(",");
ok(k0==="start,stop,stop"&&k1==="back,stop,end","Monday: start, break, HOLD · Tuesday: back from it, break, done");
ok(days[0].items[2].stop.hold&&days[0].items[2].stop.e===L(8,0,20),"the HOLD says when it ended");

const weekend=job({paused:true,pauseStart:I(L(14,0,23)),pauseLog:[{start:I(L(14,0,23)),hold:true}],holdInfo:{held:true,heldAt:I(L(14,0,23))},startTime:I(L(9,0,23))});
const wd=M.jobDays(weekend,L(10,0,26));
ok(wd.length===1&&wd[0].workMin===300,"on HOLD over the weekend: only Friday is a day of work");
ok(wd[0].items[1].stop.open&&wd[0].items.length===2,"…with the HOLD still open, and no 'still working'");
const running=job({pauseLog:[{start:I(L(10)),end:I(L(10,20))}],totalPauseMin:20});
const rd=M.jobDays(running,L(12));
ok(rd.length===1&&rd[0].workMin===220&&rd[0].items[rd[0].items.length-1].kind==="now","running: up to now, and it says so");
// Finished in the middle of a break (the pause entry never closed).
const midBreak=job({completed:true,endTime:I(L(12)),paused:true,pauseStart:I(L(11,30)),durationMin:210,pauseLog:[{start:I(L(11,30))}]});
const mb=M.jobDays(midBreak,NOW);
ok(mb[0].workMin===210&&mb[0].breakMin===30,"finished during a break: the break runs to the end, and is not work");

console.log("\n── 2. the editor opens with the record as it is ───────────");
const b2=M.jobEditBase(twoDays,NOW);
ok(b2.pauses.length===3&&b2.open===null&&b2.endTime===twoDays.endTime,"three stops, the end, nothing open");
ok(b2.extraMin===0&&M.jobEditNet(b2,NOW)===twoDays.durationMin,"nothing unaccounted for — the same minutes");
ok(M.jobEditCheck(b2,NOW)==="","and nothing wrong with it");
const legacy=job({completed:true,endTime:I(L(16)),totalPauseMin:45,durationMin:435,pauseLog:[{start:I(L(12)),end:I(L(12,30))}]});
const bl=M.jobEditBase(legacy,NOW);
ok(bl.extraMin===15,"15 minutes of pause recorded with no times of their own are kept apart");
const r0=M.jobEdit([legacy],["w1"],bl,boss,I(NOW)).next[0];
ok(r0.durationMin===435&&r0.totalPauseMin===45,"saved as it opened: not a minute moves");
const bm=M.jobEditBase(midBreak,NOW);
ok(bm.pauses.length===1&&bm.pauses[0].end===I(L(12))&&M.jobEditNet(bm,NOW)===210,"finished during a break: that break closes at the end");
const held=job({paused:true,pauseStart:I(L(17)),pauseLog:[{start:I(L(12)),end:I(L(12,30))},{start:I(L(17)),hold:true}],totalPauseMin:30,holdInfo:{held:true,heldAt:I(L(17))}});
const bh=M.jobEditBase(held,NOW);
ok(bh.open&&bh.open.hold&&bh.open.start===I(L(17))&&bh.pauses.length===1,"on HOLD: the HOLD is the open stop, the break a closed one");
ok(M.jobEditNet(bh,NOW)===M.logWorkedMin(held,NOW),"…and the minutes are its clock's");
const sig=job({completed:true,startTime:I(L(9)),endTime:I(L(9)),durationMin:40,serialId:null,bulkCount:5});
ok(M.isNoTimer(sig)&&M.jobEditBase(sig,NOW).noTimer,"a signature with typed-in minutes has only its minutes to edit");
ok(M.jobEdit([sig],["w1"],{noTimer:true,minutes:55},boss,I(NOW)).next[0].durationMin===55,"…and they change");

console.log("\n── 3. the manager corrects the hours ──────────────────────");
const f=JSON.parse(JSON.stringify(b2));
f.endTime=I(L(14,0,20));                                   // finished at 14:00, not 15:00
f.pauses[0].end=I(L(10,30));                               // the first break was 30 minutes
f.pauses.push({start:I(L(13,0,20)),end:I(L(13,10,20))});   // and one more, not recorded
ok(M.jobEditCheck(f,NOW)==="","a sound correction");
const ed=M.jobEdit([twoDays],["w1"],f,boss,I(NOW));
const e1=ed.next[0];
ok(ed.before[0]===twoDays,"the log as it was is handed back for the journal");
ok(e1.endTime===I(L(14,0,20))&&e1.pauseLog.length===4,"the new end, and all four stops in order");
ok(e1.totalPauseMin===30+15*60+30+10&&e1.holdInfo.holdMin===15*60,"pause minutes add up — the HOLD kept apart");
ok(e1.durationMin===Math.round((L(14,0,20)-L(8))/60000)-e1.totalPauseMin,"the worked minutes follow");
ok(M.breakMinOf(e1)===70&&M.breakCountOf(e1)===3,"three breaks, 70 minutes — the night is not a break");
ok(e1.holdInfo.review.action==="edit"&&e1.holdInfo.review.byName==="מנהלת"&&e1.holdInfo.review.was.durationMin===twoDays.durationMin,
  "the review says who, and what it was");
const bad=(patch,what,want)=>{const g=JSON.parse(JSON.stringify(b2));patch(g);const e=M.jobEditCheck(g,NOW);ok(e&&(!want||e.includes(want)),`${what} — "${e}"`)};
bad(g=>{g.endTime=I(L(7))},"the end before the start","הסיום");
bad(g=>{g.endTime=I(L(9,0,21))},"the end in the future","בעתיד");
bad(g=>{g.pauses[0].end=I(L(9,59))},"a break that ends before it begins","הפסקה 1");
bad(g=>{g.pauses[2].end=I(L(16,0,20))},"a break past the end","אחרי סיום העבודה");
bad(g=>{g.pauses.push({start:I(L(10,10)),end:I(L(10,20))})},"two breaks at once","חופפות");
bad(g=>{g.pauses.push({start:"",end:""})},"a break with no times","חסרה");
// Open, on HOLD: the HOLD moved to when it really began.
const fh=JSON.parse(JSON.stringify(bh));fh.open.start=I(L(16));
const eh=M.jobEdit([held],["w1"],fh,boss,I(NOW)).next[0];
ok(M.isOnHold(eh)&&eh.pauseStart===I(L(16))&&eh.holdInfo.heldAt===I(L(16)),"on HOLD from 16:00 — the clock stops there");
ok(M.logWorkedMin(eh,NOW)===8*60-30,"its clock says 7:30 (08:00–16:00, less the break)");
ok(M.dayEndMissed(eh,NOW)===null,"and nothing waits for the end-of-day review");

console.log("\n── 4. a scheduled break taken off stays off ───────────────");
const sch=[{id:"b1",name:"בוקר",start:"10:00",end:"10:15",days:[1]}];
const wins=M.breakWindows(sch,L(8),L(12));
const withAuto=M.applyBreaks(job(),wins,L(12));
ok(withAuto.pauseLog.length===1&&withAuto.totalPauseMin===15,"the clock wrote the 10:00 break");
const fa=M.jobEditBase(withAuto,L(12));fa.pauses=[];
const ea=M.jobEdit([withAuto],["w1"],fa,boss,I(L(12))).next[0];
ok(ea.pauseLog.length===0&&ea.totalPauseMin===0,"the manager takes it off — the worker worked through it");
ok(M.applyBreaks(ea,wins,L(12,5))===ea,"and the clock does not write it again");

console.log("\n── 5. moved on for a worker who forgot ────────────────────");
// Went home at 17:00 without HOLD; the manager sees it at 20:00.
const forgot=job({pauseLog:[{start:I(L(12)),end:I(L(12,30))}],totalPauseMin:30});
const h1=M.jobSetState([forgot],["w1"],"hold",I(L(17)),boss,I(L(20)),"run");
const H=h1.next[0];
ok(!h1.error&&M.isOnHold(H)&&H.pauseStart===I(L(17))&&H.holdInfo.heldAt===I(L(17))&&H.holdInfo.heldByName==="מנהלת","on HOLD from 17:00, by the manager");
ok(M.logWorkedMin(H,L(20))===8*60+30,"its clock stopped at 17:00 — 8:30, not the evening");
ok(M.dayEndMissed(H,L(20))===null,"not running at 18:00 any more — nothing to review");
ok(H.holdInfo.review.action==="set-hold"&&H.holdInfo.review.upTo===forgot.startTime,"the review says what was done — and reviews no hours");
const back=M.jobSetState([H],["w1"],"run",I(L(8,0,20)),boss,I(L(8,5,20)),"hold").next[0];
ok(!M.isOnHold(back)&&!back.paused&&back.totalPauseMin===30+15*60&&back.holdInfo.holdMin===15*60,"back from HOLD at 08:00 — the night is HOLD, not a break");
ok(M.breakMinOf(back)===30,"the break is still 30 minutes");
const done=M.jobSetState([back],["w1"],"done",I(L(11,0,20)),boss,I(L(14,0,20)),"run").next[0];
ok(done.completed&&done.endTime===I(L(11,0,20))&&done.durationMin===8*60+30+3*60,"✅ at 11:00: 11:30 of work in all");
const brk=M.jobSetState([forgot],["w1"],"pause",I(L(15)),boss,I(L(15,40)),"run").next[0];
ok(brk.paused&&!M.isOnHold(brk)&&brk.pauseStart===I(L(15))&&M.jobState(brk)==="pause","⏸️ a break from 15:00");
const rs=M.jobSetState([brk],["w1"],"run",I(L(15,20)),boss,I(L(15,40)),"pause").next[0];
ok(!rs.paused&&rs.totalPauseMin===50&&rs.pauseLog[1].end===I(L(15,20)),"▶️ back at 15:20 — 20 more minutes of break");
const fromHold=M.jobSetState([H],["w1"],"done",I(L(7,0,20)),boss,I(L(9,0,20)),"hold").next[0];
ok(fromHold.completed&&fromHold.durationMin===8*60+30&&fromHold.holdInfo.held===false,"✅ straight from HOLD: the HOLD is not work");

console.log("\n── 6. what is refused ─────────────────────────────────────");
ok(M.jobSetState([forgot],["w1"],"hold",I(L(11)),boss,I(L(20)),"run").error==="early","before the last thing on the record (the 12:30 return)");
ok(M.jobSetState([forgot],["w1"],"hold",I(L(21)),boss,I(L(20)),"run").error==="time","in the future");
ok(M.jobSetState([brk],["w1"],"hold",I(L(16)),boss,I(L(20)),"run").error==="changed","the job has moved on since the manager looked");
ok(M.jobSetState([H],["w1"],"pause",I(L(19)),boss,I(L(20)),"hold").error==="changed","HOLD straight to a break is not a move");
ok(M.jobSetState([twoDays],["w1"],"hold",I(L(16,0,20)),boss,I(NOW)).error==="gone","a finished job is not moved");
const other=job({id:"w2",serialId:"S2",serialSn:"SN-2"});
ok(M.jobSetState([H,other],["w1"],"run",I(L(20)),boss,I(L(20,1))).error==="busy","back to work while another job of theirs runs — no");
ok(!M.jobSetState([H,{...other,paused:true,pauseStart:I(L(19)),pauseLog:[{start:I(L(19))}]}],["w1"],"run",I(L(20)),boss,I(L(20,1))).error,
  "…but one on a break is fine");
const same=M.jobSetState([forgot],["w1"],"hold",I(L(12,30)-20000),boss,I(L(20)),"run");
ok(!same.error&&same.next[0].pauseStart===I(L(12,30)),"within the minute of the last thing on the record: that moment");
ok(M.jobSig(H)!==M.jobSig(forgot)&&M.jobEdit([H],["w1"],bh,boss,I(NOW),{w1:M.jobSig(forgot)}).error==="changed",
  "an edit opened on an older picture of the job is not written");

console.log("\n── 7. scheduled breaks after the job really stopped ───────");
const late=M.applyBreaks(job(),M.breakWindows([{id:"b1",start:"16:00",end:"16:15",days:[1]}],L(8),L(17)),L(17));
ok(late.pauseLog.length===1&&late.totalPauseMin===15,"the clock wrote a 16:00 break on a job nobody was at");
ok(M.jobEarliest(late,"hold")===L(8)&&M.jobEarliest(late,"run")===L(16,15),"it does not stand in the way of a HOLD from earlier");
const lh=M.jobSetState([late],["w1"],"hold",I(L(15)),boss,I(L(17)),"run").next[0];
ok(lh.pauseLog.length===1&&lh.pauseLog[0].hold&&lh.totalPauseMin===0&&M.logWorkedMin(lh,L(17))===7*60,"HOLD from 15:00: the break after it is gone, 7 hours of work");
const mid=M.jobSetState([late],["w1"],"done",I(L(16,5)),boss,I(L(17)),"run").next[0];
ok(mid.pauseLog[0].end===I(L(16,5))&&mid.totalPauseMin===5&&mid.durationMin===8*60,"✅ at 16:05, in the break: it is cut there");
const inBreak=M.applyBreaks(job(),M.breakWindows([{id:"b1",start:"16:00",end:"16:30",days:[1]}],L(8),L(16,10)),L(16,10));
ok(M.jobState(inBreak)==="auto","right now in a scheduled break");
const ib=M.jobSetState([inBreak],["w1"],"hold",I(L(15,30)),boss,I(L(16,10)),"auto").next[0];
ok(M.isOnHold(ib)&&ib.pauseLog.length===1&&M.logWorkedMin(ib,L(16,10))===7*60+30,"HOLD from 15:30: the break it is in now goes too");

console.log("\n── 8. a group, and a unit worked on together ──────────────");
const g1=job({id:"g1",bulk:true,bulkGroupId:"G",bulkCount:2}),g2=job({id:"g2",serialId:"S2",serialSn:"SN-2",bulk:true,bulkGroupId:"G",bulkCount:2});
const gh=M.jobSetState([g1,g2],["g1","g2"],"hold",I(L(16)),boss,I(L(20)),"run");
ok(gh.before.length===2&&gh.next.every(w=>M.isOnHold(w)&&w.pauseStart===I(L(16))),"a group started together moves together");
const fg=M.jobEditBase(g1,L(20));fg.startTime=I(L(9));
ok(M.jobEdit([g1,g2],["g1","g2"],fg,boss,I(L(20))).next.every(w=>w.startTime===I(L(9))),"and is corrected together");
const me=job(),mate=job({id:"w9",userId:"u2",userName:"משה",holdInfo:{joint:{at:I(L(9)),with:[{userId:"u1"}]}},startTime:I(L(9))});
const jd=M.jobSetState([me,mate],["w1"],"done",I(L(16)),boss,I(L(20)),"run").next;
ok(M.isJointShare(jd[0])&&jd[0].serialId===null&&jd[0].durationMin===8*60,"somebody else still on the unit: finished as the worker's share, 8 hours");
ok(!jd[0].holdInfo.joint.closedById&&jd[0].holdInfo.review.action==="set-done","…not 'signed by somebody else' — the manager's review says it");
ok(!jd[1].completed&&jd[1].serialId==="S1","the other one is still on it, to sign the stage");

const run10=job({serialId:null,serialSn:null,bulk:true,bulkCount:10});
const q7=M.jobSetState([run10],["w1"],"done",I(L(12)),boss,I(L(13)),"run",7).next[0];
ok(q7.completed&&q7.bulkCount===7&&q7.durationMin===240,"a quantity run finished on 7 of its 10 units books 7");
ok(M.jobSetState([run10],["w1"],"done",I(L(12)),boss,I(L(13)),"run").next[0].bulkCount===10,"…and, not asked, all 10");
ok(M.jobSetState([run10],["w1"],"done",I(L(12)),boss,I(L(13)),"run",12).next[0].bulkCount===10,"…never more than it was opened for");

console.log("\n── 9. a share of a unit handed on from HOLD ───────────────");
// Dana put in 08:00–12:00 and went on HOLD; it was handed to Moshe.
const dana=job({paused:true,pauseStart:I(L(12)),pauseLog:[{start:I(L(12)),hold:true}],holdInfo:{held:true,heldAt:I(L(12))}});
const moshe={id:"m2",name:"משה"};
const ho=M.holdHandOff([dana],["w1"],moshe,boss,I(L(13)));
const seg=ho.segs[0],moved=ho.next.find(w=>w.id==="w1");
ok(seg.durationMin===240&&M.holdCarryMin(moved)===240,"the 4 hours Dana put in are a segment, and ride on the handed-on log");
const fs2=M.jobEditBase(seg,NOW);fs2.endTime=I(L(11));
const es=M.jobEdit(ho.next,[seg.id],fs2,boss,I(NOW));
const seg2=es.next.find(w=>w.id===seg.id),moved2=es.next.find(w=>w.id==="w1");
ok(seg2.durationMin===180&&M.holdCarryMin(moved2)===180,"corrected to 08:00–11:00: the segment and the carry both say 3 hours");
ok(moved2.holdInfo.prev[0].min===180&&es.carried.length===1&&es.carried[0]===moved,"…the list of who worked follows, and the log it touched is handed back for the journal");

console.log(fail?`\n✗ ${fail} failed`:"\n✓ all manager checks passed");
process.exit(fail?1:0);
