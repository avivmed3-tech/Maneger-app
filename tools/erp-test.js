#!/usr/bin/env node
/**
 * The Engini endpoint, end to end: HTTP request in, rows in Postgres out.
 *
 * The erp Edge Function's handler is the same module the Edge runtime serves;
 * here it is called directly with web-standard Requests, and its database
 * calls go to a throwaway Postgres carrying the real migrations (both phases).
 * What is pinned down is what the business asked for:
 *
 *   • Engini's batches land exactly like a Priority Excel file — the import
 *     code is lifted from index.html, and --check fails if the copy is stale;
 *   • sending the same thing twice changes nothing, a פק"ע is never created
 *     twice, and only what changed is written;
 *   • every stage signed in the app goes back to Priority on the matching
 *     operation with its times, and Priority's count of it is never credited
 *     to the app a second time.
 *
 *   npm test        (or: node tools/erp-test.js)
 */
const path=require("path"),{spawnSync}=require("child_process");
const H=require("./pg-harness");
const {ok,eq,done}=H.reporter();

const chk=spawnSync(process.execPath,[path.join(__dirname,"build-erp-core.js"),"--check"],{encoding:"utf8"});
ok(chk.status===0,"supabase/functions/erp/core.mjs is the import code index.html runs today");
if(chk.status!==0)console.log(chk.stderr);

const A="00000000-0000-0000-0000-000000000001";

(async()=>{
  const pg=await H.start();
  if(pg.skip){console.log(`○ erp-test skipped — ${pg.skip}`);process.exit(done()?1:0)}
  const {q,as,user,rpc}=pg;
  await pg.applyBase();
  await q(`insert into app_users(id,username,password_hash,role,name,company_id) values
     ('a_admin','admin','x','admin','מנהל',$1),('a_w1','dana','x','worker','דנה',$1)`,[A]);
  await q(`insert into stages(id,name,stage_order,company_id) values ('s_chk','בדיקה',1,$1)`,[A]);
  await pg.applyPhase1();
  await pg.applyLockdown();

  const {createHandler}=await import("../supabase/functions/erp/handler.mjs");
  const quiet={warn(){},error(){}};
  const handle=createHandler({rpc,log:quiet});
  const key=(await as("authenticated",user("a_admin"),"select erp_create_key() as k")).rows[0].k;
  const call=async(method,route,body,headers)=>{
    const r=await handle(new Request(`https://x.supabase.co/functions/v1/erp${route}`,{method,
      headers:{"content-type":"application/json","x-api-key":key,...(headers||{})},
      body:body===undefined?undefined:(typeof body==="string"?body:JSON.stringify(body))}));
    return{status:r.status,body:await r.json()};
  };
  const orders=async()=>(await q("select id,wo_number,status,erp_status,qty,stage_ids,serials,defects from orders where company_id=$1 order by wo_number",[A])).rows;
  const erpLogs=async(oid)=>(await q("select id,stage_id,serial_id,bulk_count from work_logs where order_id=$1 and user_id='priority_import' order by id",[oid])).rows;

  // A Priority report the way Engini would send it: one row per operation.
  const op=(wo,o)=>({wo,pn:"PN-"+wo,description:"מוצר "+wo,branch:"53",project:"P-7",qty:3,unit_price:120,
    release_date:"2026-09-01",end_date:"2026-11-30",status:"בתהליך ייצור",...o});
  const route=(wo,status,rep=[2,0,0],extra)=>[
    op(wo,{op_seq:10,op_code:"110",op_name:"הרכבה מכנית",work_center:"W1",reported_qty:rep[0],remaining_qty:3-rep[0],std_min_per_unit_pn:12,status,...extra}),
    op(wo,{op_seq:20,op_code:"120",op_name:"בדיקה",work_center:"W2",reported_qty:rep[1],remaining_qty:3-rep[1],std_min_per_unit_pn:5,status,...extra}),
    op(wo,{op_seq:30,op_code:"130",op_name:"אריזה",work_center:"W3",reported_qty:rep[2],remaining_qty:3-rep[2],status,...extra}),
  ];
  const serials=wo=>[1,2,3].map(i=>({wo,pn:"PN-"+wo,sn:`${wo}-SN${i}`}));
  const batch1={batch_ref:"t1",operations:[...route("WO-1","בתהליך ייצור"),
      ...route("WO-2","נסגרה",[3,3,3]),
      ...route("WO-3","פקע COC"),
      ...route("WO-4","שוחררה",[0,0,0],{branch:"0"}),
      ...route("WO-5","מבוטלת")],
    serials:serials("WO-1")};

  console.log("\n── who may call ───────────────────────────────────────────");
  eq((await call("GET","/health",undefined,{"x-api-key":""})).status,401,"no key → 401");
  eq((await call("GET","/health",undefined,{"x-api-key":"ov_nope"})).status,401,"a wrong key → 401");
  const h=await call("GET","/health");
  eq([h.status,h.body.company_id],[200,A],"the right key → its company");
  const viaBearer=await handle(new Request("https://x/functions/v1/erp/health",{headers:{authorization:`Bearer ${key}`}}));
  eq(viaBearer.status,200,"the key also works as a Bearer token");

  console.log("\n── Priority → the app ─────────────────────────────────────");
  {
    const r=await call("POST","/work-orders",batch1);
    eq(r.status,200,"a batch is accepted");
    eq([r.body.added,r.body.updated],[2,0],"two פק\"ע open: the live one and the closed one");
    eq([r.body.skipped.coc,r.body.skipped.no_branch,r.body.skipped.cancelled],[1,1,1],"COC, no-branch and cancelled ones are left out, as in the Excel import");
    eq(r.body.new_stages,2,"operations with no stage of that name become stages; בדיקה lands on the existing one");
    const os=await orders();
    eq(os.map(o=>[o.wo_number,o.status,o.erp_status]),[["WO-1","partial","בתהליך ייצור"],["WO-2","complete","נסגרה"]],"with their statuses translated");
    const o1=os[0];
    eq(o1.serials.map(s=>s.sn),["WO-1-SN1","WO-1-SN2","WO-1-SN3"],"the serial numbers Priority issued are on the פק\"ע");
    eq(o1.stage_ids.length,3,"and its route is its own three operations, in order");
    eq(o1.stage_ids[1],"s_chk","…the existing בדיקה stage among them");
    const l1=await erpLogs(o1.id);
    eq(l1.length,2,"two units reported on the first operation arrive as progress");
    const opsRows=(await q("select stage_id,op_code,op_seq::int,work_center from erp_order_ops where order_id=$1 order by op_seq",[o1.id])).rows;
    eq(opsRows.map(x=>x.op_code),["110","120","130"],"every stage remembers its Priority operation");
    const std=(await q("select stage_minutes from pn_standards where pn='PN-WO-1'")).rows[0];
    ok(std&&Object.values(std.stage_minutes).includes(12),"the standard times come in as well");
    const map=(await q("select stage_map from erp_connections where company_id=$1",[A])).rows[0].stage_map;
    eq(Object.keys(map).length,3,"the operation→stage mapping is remembered for the next batch");
  }
  {
    const r=await call("POST","/work-orders",batch1);
    eq([r.body.added,r.body.updated,r.body.logs_written,r.body.logs_dropped,r.body.unchanged],[0,0,0,0,2],
       "the same batch again changes nothing at all");
    eq((await orders()).length,2,"no פק\"ע was created twice");
  }
  {
    const b={operations:route(" wo-1 ","בעיה הנדסית",[2,1,0]).map(x=>({...x,status_note:"ממתין לשרטוט"})),serials:serials("WO-1")};
    const r=await call("POST","/work-orders",b);
    eq([r.body.added,r.body.updated],[0,1],"a changed פק\"ע is updated in place — matched on its number, spaces and case aside");
    const o1=(await orders())[0];
    eq([o1.status,o1.erp_status],["blocked","בעיה הנדסית"],"its new status is taken");
    const l=await erpLogs(o1.id);
    eq(l.length,3,"and its progress redrawn: 2 + 1 units");
    ok(r.body.changes.some(c=>c.fields.includes("התקדמות")),"the response says what changed");
  }
  {
    await q("update orders set defects='[{\"id\":\"d1\",\"title\":\"שריטה\"}]' where wo_number='WO-1'");
    await call("POST","/work-orders",{operations:route("WO-1","בתהליך ייצור",[2,1,0]),serials:serials("WO-1")});
    const o1=(await orders())[0];
    eq([o1.status,o1.defects.length],["partial",1],"what the floor recorded on a פק\"ע (a תקלה) survives the ERP's update");
  }
  {
    const r=await call("POST","/work-orders",{operations:route("WO-2","מבוטלת",[3,3,3])});
    eq(r.body.updated,1,"a פק\"ע Priority cancelled is marked, not deleted");
    eq((await orders())[1].erp_status,"מבוטלת","…and hidden by the app from then on");
  }

  console.log("\n── what Engini can get wrong ──────────────────────────────");
  eq((await call("POST","/work-orders",{operations:[]})).status,400,"an empty batch → 400");
  eq((await call("POST","/work-orders","{not json")).status,400,"a body that is not JSON → 400");
  eq((await call("POST","/work-orders",{operations:Array.from({length:5001},()=>op("WO-9",{}))})).status,413,"more than 5,000 rows → 413, split it");
  eq((await call("POST","/work-orders",{operations:[{pn:"x"}]})).status,400,"rows without a work-order number → 400");
  await rpc("svc_erp_lock",{p_company:A,p_holder:"someone-else",p_seconds:60});
  const busy=await call("POST","/work-orders",batch1);
  eq([busy.status,busy.body.retry_after],[409,5],"a second batch while one is being written → 409, retry");
  await rpc("svc_erp_unlock",{p_company:A,p_holder:"someone-else"});
  eq((await call("GET","/nowhere")).status,404,"an unknown route → 404");

  console.log("\n── the app → Priority (two-way) ───────────────────────────");
  await as("authenticated",user("a_admin"),"select erp_update_settings(true,null,null)");
  const o1=(await orders())[0];
  const st1=o1.stage_ids[0];
  {
    // Dana signs off unit 3 on the first operation — a unit Priority has not seen.
    const sn3=o1.serials[2];
    const w=await as("authenticated",user("a_w1"),`insert into work_logs(id,user_id,user_name,serial_id,serial_sn,stage_id,order_id,
      start_time,end_time,completed,duration_min,total_pause_min,company_id) values
      ('wd1','a_w1','דנה',$1,$2,$3,$4,'2026-10-07T08:00:00Z','2026-10-07T08:50:00Z',true,42,8,$5)`,[sn3.id,sn3.sn,st1,o1.id,A]);
    ok(!w.error,"a worker signs off a stage in the app");
    const r=await call("GET","/sign-offs?limit=10");
    eq(r.body.events.length,1,"Engini collects one sign-off");
    const e=r.body.events[0];
    eq([e.type,e.wo_number,e.operation.code,e.operation.seq,e.serial_number,e.quantity,Number(e.duration_min),Number(e.pause_min),e.worker_name],
       ["sign","WO-1","110",10,"WO-1-SN3",1,42,8,"דנה"],"…on Priority's operation 110 of WO-1, for unit SN3, 42 net minutes, by דנה");
    eq((await call("GET","/sign-offs")).body.events.length,0,"while Engini is on it, it is not handed out again");
    const a=await call("POST","/sign-offs/ack",{acks:[{event_id:e.event_id,ok:true,priority_ref:"PR-1"}]});
    eq(a.body.acked,1,"Engini reports it taken");
  }
  {
    // Priority now counts 3 on that operation: its own 2 plus Dana's.
    const r=await call("POST","/work-orders",{operations:route("WO-1","בתהליך ייצור",[3,1,0]),serials:serials("WO-1")});
    eq(r.status,200,"Priority's next report comes in");
    const l=(await erpLogs(o1.id)).filter(x=>x.stage_id===st1);
    eq(l.length,2,"its 3 on that operation are taken as 2 of its own — Dana's unit is not counted twice");
    ok(!l.some(x=>x.serial_id===o1.serials[2].id),"…and neither lands on the unit Dana signed");
    const again=await call("POST","/work-orders",{operations:route("WO-1","בתהליך ייצור",[3,1,0]),serials:serials("WO-1")});
    eq([again.body.updated,again.body.logs_written,again.body.logs_dropped],[0,0,0],"sending it again changes nothing");
  }
  {
    const r=await call("POST","/work-orders",{operations:route("WO-1","נסגרה",[3,3,3]),serials:serials("WO-1")});
    eq(r.status,200,"Priority closes the פק\"ע");
    const l=await erpLogs(o1.id);
    const byStage=s=>l.filter(x=>x.stage_id===s).length;
    eq([byStage(o1.stage_ids[0]),byStage(o1.stage_ids[1]),byStage(o1.stage_ids[2])],[2,3,3],
       "every stage is complete — the first by Priority's two plus Dana's one");
  }
  {
    await as("authenticated",user("a_w1"),"delete from work_logs where id='wd1'");
    const r=await call("GET","/sign-offs");
    const u=r.body.events[0];
    eq([u.type,u.reverses_event_id>0,u.priority_ref,u.serial_number],["unsign",true,"PR-1","WO-1-SN3"],
       "deleting the sign-off in the app sends its reversal, naming what Priority recorded");
    const a=await call("POST","/sign-offs/ack",{acks:[{event_id:u.event_id,ok:false,error:"Priority: report is locked",retry:false}]});
    eq(a.body.failed,1,"Engini can report a failure");
    const st=(await as("authenticated",user("a_admin"),"select erp_status() as s")).rows[0].s;
    eq(st.problems[0].error,"Priority: report is locked","…which the admin sees in the app");
    const rt=(await as("authenticated",user("a_admin"),"select erp_retry_failed() as n")).rows[0].n;
    eq(rt,1,"…and can send again");
    eq((await call("GET","/sign-offs")).body.events.length,1,"…and Engini gets it again");
  }
  {
    await q(`insert into orders(id,wo_number,company_id,stage_ids) values ('manual','M-1',$1,'["s_chk"]')`,[A]);
    await as("authenticated",user("a_w1"),`insert into work_logs(id,user_id,user_name,stage_id,order_id,completed,duration_min,company_id)
      values ('wm','a_w1','דנה','s_chk','manual',true,5,$1)`,[A]);
    const st=(await as("authenticated",user("a_admin"),"select erp_status() as s")).rows[0].s;
    ok(st.problems.some(p=>p.status==="unmapped"&&p.wo_number==="M-1"),"a sign-off on a פק\"ע Priority never sent is held, and shown as not linked");
    ok(!(await call("GET","/sign-offs")).body.events.some(e=>e.wo_number==="M-1"),"…and never handed to Engini");
  }

  await pg.db.end();
  process.exit(done()?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
