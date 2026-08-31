#!/usr/bin/env node
/**
 * What the sync layer actually costs, measured rather than argued about.
 *
 * The app is a single file that runs in a browser, so this loads the real
 * <script type="text/babel"> block into a VM with just enough of a browser
 * around it — and, more to the point, a fake PostgREST that counts every byte it
 * hands back. That is the only way to answer the question that matters here:
 * how much does an idle floor cost per sweep, and how much does a tablet
 * download when it opens in the morning.
 *
 * Nothing here touches the real project. The data below is shaped and sized like
 * the production tables (2,092 פק"ע, 75,807 work logs, 1,007 standards).
 *
 *   npm test
 */
// Loads the real app script into a VM with browser stubs and a fake PostgREST,
// so the sync layer can be exercised for real rather than reasoned about.
const fs=require("fs"),vm=require("vm"),path=require("path");
const Babel=require("@babel/standalone");

const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const OPEN='<script type="text/babel">';
const s=html.indexOf(OPEN)+OPEN.length, e=html.indexOf("</script>",s);
const {code}=Babel.transform(html.slice(s,e),{presets:["react"],sourceType:"script",compact:false,comments:false,babelrc:false,configFile:false});

// ── fake PostgREST ────────────────────────────────────────────────────────
const DB={};                       // table -> [rows]
const stats={requests:0,rowsOut:0,bytesOut:0,byTable:{}};
function note(t,rows,bytes){
  stats.requests++;stats.rowsOut+=rows;stats.bytesOut+=bytes;
  const b=stats.byTable[t]||(stats.byTable[t]={req:0,rows:0,bytes:0});
  b.req++;b.rows+=rows;b.bytes+=bytes;
}
const PAGE_CAP=1000;
function handle(url,opts){
  const u=new URL(url);
  const table=u.pathname.split("/rest/v1/")[1];
  const p=u.searchParams;
  let rows=(DB[table]||[]).slice();
  const cid=p.get("company_id");
  if(cid)rows=rows.filter(r=>String(r.company_id)===cid.replace(/^eq\./,""));
  const gte=p.get("updated_at");
  if(gte)rows=rows.filter(r=>String(r.updated_at)>=decodeURIComponent(gte.replace(/^gte\./,"")));
  const inIds=p.get("id");
  if(inIds&&inIds.startsWith("in.")){
    const set=new Set(inIds.slice(4,-1).split(",").map(x=>x.replace(/^"|"$/g,"")));
    rows=rows.filter(r=>set.has(r.id));
  }
  const order=(p.get("order")||"").split(",")[0];
  if(order){const col=order.split(".")[0];rows.sort((a,b)=>String(a[col]??"")<String(b[col]??"")?-1:String(a[col]??"")>String(b[col]??"")?1:String(a.id)<String(b.id)?-1:1)}
  const total=rows.length;
  const sel=p.get("select");
  if(sel&&sel!=="*"){const cols=sel.split(",");rows=rows.map(r=>{const o={};for(const c of cols)if(c in r)o[c]=r[c];return o})}
  const range=String((opts&&opts.headers&&opts.headers.Range)||"0-"+(PAGE_CAP-1));
  const [from,to]=range.split("-").map(Number);
  const page=rows.slice(from,Math.min(to+1,from+PAGE_CAP));
  const method=(opts&&opts.method)||"GET";
  const body=method==="HEAD"?"":JSON.stringify(page);
  note(table,method==="HEAD"?0:page.length,body.length);
  return{
    ok:true,status:200,
    headers:{get:h=>h.toLowerCase()==="content-range"?`${from}-${from+page.length-1}/${total}`:null},
    json:async()=>page, text:async()=>body,
  };
}

// ── a just-enough IndexedDB, so the snapshot path can be exercised ────────
function fakeIDB(){
  const stores={};
  const fire=(o,ev,val)=>setTimeout(()=>{o.result=val;o["on"+ev]&&o["on"+ev]({target:o})},0);
  return{open(){
    const rq={result:null,onsuccess:null,onerror:null,onupgradeneeded:null};
    const db={objectStoreNames:{contains:n=>n in stores},
      createObjectStore(n){stores[n]={};return{}},
      transaction(n){
        const tx={oncomplete:null,onerror:null,onabort:null,
          objectStore(){return{
            get(k){const r={result:stores[n]?stores[n][k]:undefined};setTimeout(()=>{tx.oncomplete&&tx.oncomplete()},0);return r},
            put(v,k){stores[n][k]=structuredClone(v);setTimeout(()=>{tx.oncomplete&&tx.oncomplete()},0);return{result:k}},
            delete(k){delete stores[n][k];setTimeout(()=>{tx.oncomplete&&tx.oncomplete()},0);return{result:undefined}},
          }}};
        return tx;
      }};
    setTimeout(()=>{rq.result=db;rq.onupgradeneeded&&rq.onupgradeneeded({target:rq});rq.onsuccess&&rq.onsuccess({target:rq})},0);
    return rq;
  }};
}

// ── browser stubs ─────────────────────────────────────────────────────────
const store={};
const localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]},clear:()=>{for(const k in store)delete store[k]}};
const noop=()=>{};
const el={classList:{add:noop},parentNode:null,remove:noop,addEventListener:noop,removeEventListener:noop,style:{}};
const React={createElement:()=>null,createContext:()=>({Provider:()=>null,Consumer:()=>null}),memo:f=>f,forwardRef:f=>f,Fragment:"F",
  useState:()=>[undefined,noop],useEffect:noop,useCallback:f=>f,useRef:()=>({current:null}),useMemo:f=>f(),useContext:()=>({})};
const ctx={
  console,Promise,Date,Math,JSON,Map,Set,Array,Object,String,Number,Boolean,Error,RegExp,Symbol,
  URL,URLSearchParams,TextEncoder,TextDecoder,isFinite,isNaN,parseInt,parseFloat,encodeURIComponent,decodeURIComponent,
  setTimeout,clearTimeout,setInterval:()=>0,clearInterval:noop,queueMicrotask,structuredClone,
  React,ReactDOM:{createRoot:()=>({render:noop})},
  localStorage,indexedDB:fakeIDB(),
  crypto:{randomUUID:()=>"id_"+Math.random().toString(36).slice(2),getRandomValues:a=>a,subtle:{digest:async()=>new ArrayBuffer(32)}},
  navigator:{onLine:true,serviceWorker:undefined,userAgent:"node"},
  location:{href:"https://x/",hostname:"x",origin:"https://x"},
  document:{getElementById:()=>el,createElement:()=>el,addEventListener:noop,removeEventListener:noop,body:el,documentElement:el,visibilityState:"visible"},
  requestAnimationFrame:f=>setTimeout(f,0),
  matchMedia:()=>({matches:false,addEventListener:noop,addListener:noop}),
  fetch:async(url,opts)=>handle(url,opts),
  WebSocket:function(){this.close=noop;this.send=noop},
};
ctx.window=ctx;ctx.globalThis=ctx;ctx.self=ctx;
vm.createContext(ctx);
vm.runInContext(code,ctx,{filename:"app.js"});

function resetStats(){stats.requests=0;stats.rowsOut=0;stats.bytesOut=0;stats.byTable={}}

const run=expr=>vm.runInContext(expr,ctx);
const CID="00000000-0000-0000-0000-000000000001";
const kb=n=>(n/1024).toFixed(1)+" KB";
let fails=0;
const ok=(cond,msg)=>{console.log((cond?"  ✓ ":"  ✗ ")+msg);if(!cond)fails++};

// ── realistic-ish data: the shapes and volumes measured on the real project ──
const iso=n=>new Date(Date.UTC(2026,0,1,0,0,0)+n*1000).toISOString();
DB.orders=Array.from({length:2092},(_,i)=>({id:"o"+i,wo_number:"WO"+i,pn:"PN"+(i%400),description:"desc "+i,
  qty:10,unit_price:100,project_id:"p"+(i%47),branch:"5"+(i%9),received_date:"2026-01-01",target_date:"2026-02-01",
  stage_ids:["s1","s2"],block_id:null,serials:Array.from({length:6},(_,k)=>({id:"sr"+i+"_"+k,sn:"SN"+i+"-"+k})),
  shortages:[],defects:[],delivered_serials:[],status:"open",erp_status:"פתוחה",erp_note:null,
  company_id:CID,created_at:iso(i),updated_at:iso(i)}));
DB.work_logs=Array.from({length:75807},(_,i)=>({id:"w"+i,user_id:"u"+(i%25),user_name:"עובד מספר "+(i%25),
  serial_id:"sr"+(i%2000)+"_0",serial_sn:"SN"+(i%2000)+"-0",stage_id:"s"+(i%135),order_id:"o"+(i%2092),
  start_time:iso(i),end_time:iso(i+60),completed:true,duration_min:12,paused:false,pause_start:null,
  total_pause_min:0,pause_log:[],bulk:false,bulk_group_id:null,bulk_count:null,
  company_id:CID,created_at:iso(i),updated_at:iso(i)}));
DB.projects=Array.from({length:47},(_,i)=>({id:"p"+i,name:"פרויקט "+i,company_id:CID,created_at:iso(i),updated_at:iso(i)}));
DB.stages=Array.from({length:135},(_,i)=>({id:"s"+i,name:"שלב "+i,stage_order:i,color:"#3b82f6",price:5,hourly_rate:60,role_id:null,minutes:10,company_id:CID,created_at:iso(i),updated_at:iso(i)}));
DB.stage_blocks=[{id:"b1",name:"מסלול",stages:["s1"],company_id:CID,created_at:iso(1),updated_at:iso(1)}];
DB.custom_tasks=[{id:"t1",user_id:"u1",user_name:"א",name:"משימה",description:"",price:0,active:false,completed:false,partial:false,start_time:null,end_time:null,duration_min:0,paused:false,pause_start:null,total_pause_min:0,pause_log:[],company_id:CID,created_at:iso(1),updated_at:iso(1)}];
DB.departments=Array.from({length:2},(_,i)=>({id:"d"+i,name:"מחלקה "+i,color:"#fff",manager_id:null,branch_codes:[],company_id:CID,created_at:iso(i),updated_at:iso(i)}));
DB.daily_plans=Array.from({length:5},(_,i)=>({id:"pl"+i,user_id:"u1",user_name:"א",plan_date:"2026-01-01",order_id:"o1",stage_id:"s1",target_qty:1,serial_ids:[],note:null,done:false,created_by:null,created_by_name:null,company_id:CID,created_at:iso(i),updated_at:iso(i)}));
DB.pn_standards=Array.from({length:1007},(_,i)=>({id:"std"+i,pn:"PN"+i,stage_minutes:{s1:10},total_min:10,note:null,updated_by:null,company_id:CID,created_at:iso(i),updated_at:iso(i)}));

(async()=>{
console.log("\n── 1. cold load (no snapshot) ─────────────────────────────");
resetStats();
const full=await run("dbLoadAll()");
const coldBytes=stats.bytesOut, coldReq=stats.requests;
console.log(`  ${coldReq} requests, ${stats.rowsOut} rows, ${kb(coldBytes)}`);
ok(full.orders.length===2092,"2092 orders");
ok(full.workLogs.length===75807,"75,807 work logs");
ok(full.pnStandards.length===1007,"1007 standards (past the 1000-row page cap)");
ok(full.orders[0].companyId===CID,"companyId survives not being on the wire");
ok(full.workLogs[0].companyId===CID,"…on work logs too");
ok(!("company_id" in (DB.__probe||{})),"—");
run("commitWatermarks")(full);

console.log("\n── 2. idle sweep: nothing changed ─────────────────────────");
const prev={reconcile:false,orders:full.orders,projects:full.projects,stages:full.stages,
  stageBlocks:full.stageBlocks,workLogs:full.workLogs,customTasks:full.customTasks,
  departments:full.departments,dailyPlans:full.dailyPlans,pnStandards:full.pnStandards};
resetStats();
const idle=await run("dbLoadAll")(prev);
console.log(`  ${stats.requests} requests, ${stats.rowsOut} rows, ${kb(stats.bytesOut)}`);
ok(stats.bytesOut<3000,`idle sweep under 3 KB (was ${kb(coldBytes)} of full reads)`);
ok(idle.orders===full.orders,"orders keeps its array identity (no re-render)");
ok(idle.workLogs===full.workLogs,"workLogs keeps its array identity");
ok(idle.pnStandards===full.pnStandards,"pnStandards keeps its array identity");

console.log("\n── 3. one worker closes one stage ─────────────────────────");
DB.work_logs.push({...DB.work_logs[0],id:"w_new",updated_at:iso(999999),created_at:iso(999999),duration_min:7});
DB.orders[5]={...DB.orders[5],status:"partial",updated_at:iso(999999)};
run("commitWatermarks")(idle);
resetStats();
const after=await run("dbLoadAll")(prev);
console.log(`  ${stats.requests} requests, ${stats.rowsOut} rows, ${kb(stats.bytesOut)}`);
ok(after.workLogs.length===75808,"the new log arrived");
ok(after.workLogs!==full.workLogs,"workLogs is a new array (it changed)");
ok(after.orders.find(o=>o.id==="o5").status==="partial","the edited order arrived");
ok(after.stages===full.stages,"stages, untouched, keeps its identity");
// Nine of these are the boundary rows the ">=" watermark deliberately re-reads,
// one per table; the other two are the change.
ok(stats.rowsOut<=12,`only the rows that moved came back (${stats.rowsOut})`);

console.log("\n── 4. a row deleted on another device ─────────────────────");
DB.work_logs.splice(10,1);
DB.orders.splice(3,1);
run("commitWatermarks")(after);
const prev2={...prev,orders:after.orders,workLogs:after.workLogs,reconcile:false};
resetStats();
const missed=await run("dbLoadAll")(prev2);
ok(missed.workLogs.length===75808,"a plain delta cannot see a deletion (expected)");
resetStats();
const rec=await run("dbLoadAll")({...prev2,reconcile:true});
console.log(`  reconcile: ${stats.requests} requests, ${kb(stats.bytesOut)}`);
ok(rec.workLogs.length===75807,"reconcile removed the deleted work log");
ok(!rec.orders.some(o=>o.id==="o3"),"reconcile removed the deleted order");
ok(rec.stages===prev.stages,"tables whose counts agree are never re-read");

console.log("\n── 5. a database without the migration ────────────────────");
DB.work_logs.forEach(r=>{delete r.updated_at});
run("DELTA_OFF.work_logs=false;delete WATERMARKS.work_logs");
const degraded=await run("dbLoadAll")({...prev2,workLogs:[]});
ok(degraded.workLogs.length===75807,"falls back to a full read rather than failing");

console.log("\n── 6. the snapshot a tablet comes back to ─────────────────");
// Put the database back the way it was, then save what the app is holding.
DB.work_logs.forEach((r,i)=>{if(!r.updated_at)r.updated_at=iso(i)});
const fresh=await run("dbLoadAll()");
run("commitWatermarks")(fresh);
const rows={};for(const k of ["orders","projects","stages","stageBlocks","workLogs","customTasks","departments","dailyPlans","pnStandards"])rows[k]=fresh[k];
ok(await run("snapshotSave")(CID,rows),"snapshot written to IndexedDB");
const snap=await run("snapshotLoad")(CID);
ok(!!snap,"snapshot read back");
ok(snap&&snap.rows.workLogs.length===75807,"all 75,807 work logs survived the round trip");
ok(snap&&!!snap.watermarks.work_logs,"watermarks travel with the rows");
ok(snap&&snap.at>0,"and the time it was taken");

// A tablet opening with that snapshot asks only for what moved since.
DB.work_logs.push({...DB.work_logs[0],id:"w_next_day",updated_at:iso(1999999),created_at:iso(1999999)});
run("resetWatermarks()");
run("commitWatermarks")({watermarks:snap.watermarks});
const warmPrev={reconcile:true};for(const k in snap.rows)warmPrev[k]=snap.rows[k];
resetStats();
const warm=await run("dbLoadAll")(warmPrev);
console.log(`  warm open: ${stats.requests} requests, ${stats.rowsOut} rows, ${kb(stats.bytesOut)}`);
ok(warm.workLogs.length===75808,"the warm open has yesterday's rows plus today's change");
ok(stats.bytesOut<20000,`warm open under 20 KB, against ${kb(coldBytes)} cold`);
console.log(`\n  cold open ${kb(coldBytes)} → warm open ${kb(stats.bytesOut)}  (${Math.round(coldBytes/Math.max(stats.bytesOut,1))}x less)`);

console.log("\n── 7. a snapshot missing one collection ───────────────────");
// A stored record whose rows were partly lost must not keep the watermarks that
// went with them, or the delta returns only the tail of that table.
const half=structuredClone({cid:CID,at:Date.now(),rows:{...rows},watermarks:snap.watermarks});
delete half.rows.workLogs;
await run("idbRun")("readwrite",st=>st.put(half,run("snapKey")(CID)));
const partial=await run("snapshotLoad")(CID);
ok(partial&&!partial.watermarks.work_logs,"the orphaned work_logs watermark is dropped");
ok(partial&&!!partial.watermarks.orders,"watermarks that still have their rows are kept");
run("resetWatermarks()");
run("commitWatermarks")({watermarks:partial.watermarks});
const repaired=await run("dbLoadAll")({reconcile:false,...partial.rows});
ok(repaired.workLogs.length===DB.work_logs.length,`work_logs was read whole instead of tail-only (${repaired.workLogs.length})`);

console.log(`\n${fails?"✗ "+fails+" failed":"✓ all assertions passed"}`);
process.exit(fails?1:0);
})().catch(e=>{console.error("harness error:",e);process.exit(1)});
