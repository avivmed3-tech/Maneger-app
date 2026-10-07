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
// `scanned` is what the database pays for a page: an offset is walked past row by
// row before the page itself is read, so page N of an offset read costs N pages.
const stats={requests:0,rowsOut:0,bytesOut:0,scanned:0,byTable:{}};
function note(t,rows,bytes,scanned){
  stats.requests++;stats.rowsOut+=rows;stats.bytesOut+=bytes;stats.scanned+=scanned;
  const b=stats.byTable[t]||(stats.byTable[t]={req:0,rows:0,bytes:0,scanned:0});
  b.req++;b.rows+=rows;b.bytes+=bytes;b.scanned+=scanned;
}
const PAGE_CAP=1000;
// The filters the app sends, the way PostgREST reads them: col=op.value, any
// number of them on one column, and or=(col.op."value",…) with quoted values.
const cmp=(a,b)=>a<b?-1:a>b?1:0;
function match(val,expr){
  if(expr==="is.null")return val==null;
  if(expr==="not.is.null")return val!=null;
  const m=/^(eq|gt|gte|lt|lte|in)\.([\s\S]*)$/.exec(expr);
  if(!m)throw new Error("fake PostgREST: unknown filter "+expr);
  const [,op,arg]=m;
  if(op==="in")return new Set(arg.slice(1,-1).split(",").map(x=>x.replace(/^"|"$/g,""))).has(String(val));
  if(val==null)return false;
  const c=cmp(String(val),arg);
  return op==="eq"?c===0:op==="gt"?c>0:op==="gte"?c>=0:op==="lt"?c<0:c<=0;
}
function orTerms(s){
  const out=[];let cur="",q=false;
  for(let i=0;i<s.length;i++){
    const ch=s[i];
    if(q&&ch==="\\"){cur+=s[++i];continue}
    if(ch==='"'){q=!q;continue}
    if(!q&&ch===","){out.push(cur);cur="";continue}
    cur+=ch;
  }
  out.push(cur);
  return out.map(t=>{const i=t.indexOf(".");return{col:t.slice(0,i),expr:t.slice(i+1)}});
}
function handle(url,opts){
  const u=new URL(url);
  const table=u.pathname.split("/rest/v1/")[1];
  const p=u.searchParams;
  let rows=(DB[table]||[]).slice();
  for(const [k,v] of p.entries()){
    if(k==="select"||k==="order")continue;
    if(k==="or"){
      if(!/^\(.*\)$/.test(v))throw new Error("fake PostgREST: bad or= "+v);
      const terms=orTerms(v.slice(1,-1));
      rows=rows.filter(r=>terms.some(t=>match(r[t.col],t.expr)));
      continue;
    }
    rows=rows.filter(r=>match(r[k],v));
  }
  // NULLs last, as Postgres sorts them ascending.
  const order=(p.get("order")||"").split(",").filter(Boolean).map(o=>o.split(".")[0]);
  if(order.length)rows.sort((a,b)=>{
    for(const col of order){
      const x=a[col],y=b[col];
      if(x==null||y==null){if(x==null&&y==null)continue;return x==null?1:-1}
      const c=cmp(String(x),String(y));if(c)return c;
    }
    return 0;
  });
  const total=rows.length;
  const sel=p.get("select");
  if(sel&&sel!=="*"){const cols=sel.split(",");rows=rows.map(r=>{const o={};for(const c of cols)if(c in r)o[c]=r[c];return o})}
  const range=String((opts&&opts.headers&&opts.headers.Range)||"0-"+(PAGE_CAP-1));
  const [from,to]=range.split("-").map(Number);
  const page=rows.slice(from,Math.min(to+1,from+PAGE_CAP));
  const method=(opts&&opts.method)||"GET";
  const body=method==="HEAD"?"":JSON.stringify(page);
  note(table,method==="HEAD"?0:page.length,body.length,method==="HEAD"?0:from+page.length);
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
// Hooks that actually hold state. Sections 1-7 never call a component, so this
// costs them nothing — but section 8 runs App()'s own body, and for that the
// useState cells have to survive and the effects have to be catchable. Effects
// are collected rather than run: the boot effect is the only one that test wants
// to fire, and firing the other twenty-one would open sockets and timers.
const hooks={cells:[],slot:0,effects:[],
  reset(){this.cells=[];this.slot=0;this.effects=[]}};
const React={createElement:()=>null,createContext:()=>({Provider:()=>null,Consumer:()=>null}),memo:f=>f,forwardRef:f=>f,Fragment:"F",
  useState(init){const i=hooks.slot++;
    if(!(i in hooks.cells))hooks.cells[i]={v:typeof init==="function"?init():init,init:typeof init==="function"?undefined:init};
    const c=hooks.cells[i];
    return[c.v,x=>{c.v=typeof x==="function"?x(c.v):x}]},
  useRef(init){const i=hooks.slot++;if(!(i in hooks.cells))hooks.cells[i]={v:{current:init}};return hooks.cells[i].v},
  useEffect(fn){hooks.effects.push(fn)},
  useCallback:f=>f,useMemo:f=>f(),useContext:()=>({})};
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
  // Indirected so section 8 can hold the network open and watch what the app
  // does while it is still waiting.
  fetch:async(url,opts)=>ctx.fetch_(url,opts),
  WebSocket:function(){this.close=noop;this.send=noop},
  // App's body reads Notification.permission while initialising its state.
  Notification:{permission:"default"},
  CustomEvent:function(type){this.type=type},
  addEventListener:noop,removeEventListener:noop,dispatchEvent:noop,
};
ctx.fetch_=(url,opts)=>handle(url,opts);
ctx.window=ctx;ctx.globalThis=ctx;ctx.self=ctx;
vm.createContext(ctx);
vm.runInContext(code,ctx,{filename:"app.js"});

function resetStats(){stats.requests=0;stats.rowsOut=0;stats.bytesOut=0;stats.scanned=0;stats.byTable={}}

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
// A plan the manager deleted, on the same pass. Plans are what a worker is
// told to do, so they are watched on every sweep rather than every five minutes.
DB.daily_plans.splice(0,1);
resetStats();
const missed=await run("dbLoadAll")(prev2);
ok(missed.workLogs.length===75808,"a plain delta cannot see a deletion (expected)");
ok(missed.dailyPlans.length===4&&!missed.dailyPlans.some(p=>p.id==="pl0"),
   "…but a deleted שיבוץ is caught on a plain sweep, without waiting for the reconcile");
// A second one straight after: the ten-minute throttle on the id read is for
// work_logs' 2 MB, and must not hold a plan back.
DB.daily_plans.splice(0,1);
resetStats();
const again=await run("dbLoadAll")({...prev2,dailyPlans:missed.dailyPlans});
ok(again.dailyPlans.length===3,"and the next deletion a moment later is caught too (no throttle on a small table)");
ok(stats.bytesOut<3000,`at the cost of a few ids (${kb(stats.bytesOut)})`);
ok(again.workLogs===prev2.workLogs,"the big tables are still left alone between reconciles");
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

console.log("\n── 8. the boot path (what the app actually runs) ──────────");
// Everything above calls the sync layer directly. This section runs App()'s own
// boot effect instead, because the bug it guards against was never in the sync
// layer: snapshotSave, snapshotLoad and the watermarks all worked exactly as
// sections 6 and 7 show, and the boot path simply never asked them to do
// anything. A device whose user only ever looked at the floor stored no
// snapshot, and re-read all 75,807 work logs on every open.

// The app debounces its snapshot write by eight seconds and its save by four.
// Rather than wait them out, long timers are parked here and fired on demand;
// the short ones the fake IndexedDB runs on stay real.
const parked=new Map();let parkId=1;
const realTimeout=setTimeout;
ctx.setTimeout=(fn,ms,...a)=>{if(ms>=1000){const id=parkId++;parked.set(id,fn);return id}return realTimeout(fn,ms,...a)};
ctx.clearTimeout=id=>{if(typeof id==="number"&&parked.has(id))parked.delete(id);else clearTimeout(id)};
const fireParked=()=>{const fns=[...parked.values()];parked.clear();fns.forEach(f=>{try{f()}catch{}})};
// Long enough for the boot chain plus the fake IndexedDB, which answers on a
// zero-delay timer of its own.
const settle=async(n=12)=>{for(let i=0;i<n;i++)await new Promise(r=>realTimeout(r,5))};

const PFX=run("LS_PREFIX");
const clearSnapshot=()=>run("idbRun")("readwrite",st=>st.delete(run("snapKey")(CID)));
// Mounts App once and returns the boot effect, found by a string only it
// contains rather than by its position in a list of twenty-two.
const mountApp=()=>{
  hooks.reset();
  run("App")();
  const boot=hooks.effects.find(f=>/sb_migrated/.test(String(f)));
  // The only piece of App state that starts out true is `loading`, which is what
  // holds the splash up; asserting that keeps this from silently watching the
  // wrong cell if another flag is ever added.
  const lit=hooks.cells.filter(c=>c.init===true);
  return{boot,loading:lit[0],unique:lit.length===1};
};

// ── a cold boot must leave a snapshot behind ──────────────────────────────
await clearSnapshot();
store[PFX+"sb_migrated"]=JSON.stringify(true);
delete store[PFX+"session_company"];
run("resetWatermarks()");run("SYNC.reset()");
let m=mountApp();
ok(!!m.boot,"the boot effect was found");
ok(m.unique,"`loading` is the one App flag that starts true");
m.boot();
await settle();
ok(m.loading.v===false,"the splash comes down when the cold read lands");
ok(!(await run("snapshotLoad")(CID)),"nothing is written before the debounce");
fireParked();
await settle();
const booted=await run("snapshotLoad")(CID);
ok(!!booted,"the cold boot wrote a snapshot — this is the regression");
ok(booted&&booted.rows.workLogs.length===DB.work_logs.length,
   `all ${DB.work_logs.length} work logs reached IndexedDB`);
ok(booted&&!!booted.watermarks.work_logs,"with the watermark that makes the next open a delta");

// ── a warm boot must not wait for the network to draw the screen ──────────
// The snapshot is already in state by then; holding the splash up for a delta
// that normally returns nothing was the whole of the wait on a phone.
let release;const gate=new Promise(r=>{release=r});
ctx.fetch_=async(url,opts)=>{await gate;return handle(url,opts)};
store[PFX+"session_company"]=JSON.stringify(CID);
run("resetWatermarks()");run("SYNC.reset()");
m=mountApp();
m.boot();
await settle();
ok(m.loading.v===false,"warm boot: the app is on screen while the read is still in flight");
release();
await settle();
ok(m.loading.v===false,"and stays there once the read lands");

// The same gate, with no snapshot to seed from: the splash must still wait,
// or the early release is unconditional rather than earned.
await clearSnapshot();
let release2;const gate2=new Promise(r=>{release2=r});
ctx.fetch_=async(url,opts)=>{await gate2;return handle(url,opts)};
run("resetWatermarks()");run("SYNC.reset()");
m=mountApp();
m.boot();
await settle();
ok(m.loading.v===true,"cold boot with no snapshot still waits — the release is earned, not automatic");
release2();
await settle();
ok(m.loading.v===false,"and comes down when the read finally lands");
ctx.fetch_=(url,opts)=>handle(url,opts);

console.log("\n── 9. an import the database refused one row of ───────────");
// What happened in production: a Priority file whose empty date cells came in as
// the text "1900-01-00". Postgres refuses a date that does not exist, PostgREST
// refuses the whole request over it, and the save re-sent the same batch every
// four seconds for as long as the computer stayed open. The server ended up
// holding no פק"ע at all — every phone showed zero — while the computer that
// imported them showed all of them, and would have lost every one on its next
// reload.
const xlDate=run("xlDate"),orderToDb=run("orderToDb");
ok(xlDate("1900-01-00")==="","the text Excel writes for an empty date is no date");
ok(xlDate("00/01/1900")==="","…nor is the same day written the other way round");
ok(xlDate("2026-02-31")===""&&xlDate("31/02/2026")==="","a day the month does not have is no date");
ok(xlDate(0)===""&&xlDate(new Date(1899,11,30))==="","serial 0, as a number or as a Date, is no date");
ok(xlDate("2026-03-15")==="2026-03-15"&&xlDate("15/03/2026")==="2026-03-15"&&xlDate(46096)==="2026-03-15",
   "real dates still read, in every shape they arrive in");
const stuck=orderToDb({id:"x",woNumber:"W",receivedDate:"1900-01-00",targetDate:"2026-02-30"});
ok(stuck.received_date===null&&stuck.target_date===null,
   "a row already holding an impossible day is sent with no date rather than refused");
ok(orderToDb({id:"x",woNumber:"W",receivedDate:"2026-03-15",targetDate:"2026-04-01T00:00:00Z"}).target_date==="2026-04-01",
   "a real one goes out as the day it is");

// A fake PostgREST that writes, and refuses what Postgres would refuse.
const posts={n:0};
const refuseIf={orders:r=>r.wo_number==="WO-DUP"?{code:"23505",message:"duplicate key value violates unique constraint"}:
  [r.received_date,r.target_date].some(d=>d!=null&&!/^\d{4}-\d{2}-\d{2}$/.test(d)||/-00$/.test(d||""))?
    {code:"22008",message:`date/time field value out of range: "${r.received_date}"`}:null};
let down=false;
const writable=(url,opts)=>{
  if(!opts||opts.method!=="POST")return handle(url,opts);
  posts.n++;(posts.tables||(posts.tables=[])).push(new URL(url).pathname.split("/rest/v1/")[1]);
  const table=new URL(url).pathname.split("/rest/v1/")[1];
  if(down)return{ok:false,status:503,text:async()=>"upstream connect error"};
  const rows=JSON.parse(opts.body);
  const bad=rows.map(r=>refuseIf[table]&&refuseIf[table](r)).find(Boolean);
  if(bad)return{ok:false,status:bad.code==="23505"?409:400,text:async()=>JSON.stringify({...bad,details:null,hint:null})};
  const t=DB[table]||(DB[table]=[]);
  const at=new Date().toISOString();
  for(const r of rows){
    const i=t.findIndex(x=>x.id===r.id);
    const row={...(i>=0?t[i]:{created_at:at}),...r,updated_at:at};
    if(i>=0)t[i]=row;else t.push(row);
  }
  return{ok:true,status:201,text:async()=>""};
};
ctx.fetch_=writable;

// One refused row in a batch of two hundred, in an import of a thousand.
run("SYNC.reset()");
DB.orders=[];
const imported=Array.from({length:1000},(_,i)=>({id:"imp"+i,woNumber:i===437?"WO-DUP":"WO-I"+i,pn:"PN",qty:1,
  receivedDate:"2026-03-01",targetDate:"2026-04-01",stageIds:[],serials:[]}));
const told=[];
run("(f=>{SB_REFUSED=f})")((table,list)=>told.push(...list.map(x=>x.row.wo_number)));
posts.n=0;
let threw=null;
try{await run("SB.upsertChanged")("orders",imported.map(orderToDb))}catch(e){threw=e}
ok(!threw,"the save completes — one refused row no longer fails it");
ok(DB.orders.length===999,`every other פק"ע reached the server (${DB.orders.length} of 999)`);
ok(told.length===1&&told[0]==="WO-DUP","and the one that did not is named, so a person can fix it");
// Five batches, plus two requests per halving of the one that held it.
ok(posts.n<=25,`finding it took ${posts.n} requests, not a re-send every four seconds`);
posts.n=0;
await run("SB.upsertChanged")("orders",imported.map(orderToDb));
ok(posts.n===0,"the next save does not offer the refused row again while it is unchanged");
await run("SB.upsertChanged")("orders",[{...imported[437],woNumber:"WO-I437"}].map(orderToDb));
ok(DB.orders.length===1000,"once it is fixed, it goes out and lands");
// A refusal about the request rather than a row is still a failed save, retried whole.
down=true;threw=null;
try{await run("SB.upsertChanged")("orders",[{...imported[1],qty:2}].map(orderToDb))}catch(e){threw=e}
ok(!!threw,"a server that is down still fails the save, so it is retried");
down=false;
run("(f=>{SB_REFUSED=f})")(null);

// ── the reload that used to lose the import ───────────────────────────────
// The computer is holding the import in its snapshot: the פק"ע carry no
// companyId, because they were made here and never read back, and one of them
// still has the date that was refused. The server holds none of them.
//
// Two roads lead back from a reload. In production the server *had* held the
// previous פק"ע until the import replaced them, so the snapshot carries a
// watermark for orders, the read is a delta, and it is the deletion check that
// finds a thousand rows missing from the server. Without a watermark the read is
// a full one, which used to replace the table outright. Both used to lose the
// import; both are run.
const oldOrders=Array.from({length:50},(_,i)=>({id:"old"+i,wo_number:"OLD"+i,company_id:CID,created_at:iso(i),updated_at:iso(i)}));
const ordersCell=()=>hooks.cells.find(c=>Array.isArray(c.v)&&c.v.some(o=>o&&o.id==="imp0"));
for(const road of ["delta","full"]){
  DB.orders=road==="delta"?oldOrders.slice():[];
  parked.clear();
  run("resetWatermarks()");run("SYNC.reset()");
  const seen=await run("dbLoadAll()");
  run("commitWatermarks")(seen);
  // The "replace" import: the old פק"ע are deleted on the server, the new ones
  // never arrive.
  DB.orders=[];
  const held={};for(const k of ["orders","projects","stages","stageBlocks","workLogs","customTasks","departments","dailyPlans","pnStandards"])held[k]=seen[k];
  held.orders=imported.map((o,i)=>i===3?{...o,receivedDate:"1900-01-00"}:i===437?{...o,woNumber:"WO-I437"}:o);
  await run("snapshotSave")(CID,held);
  ok(road==="delta"?!!run("WATERMARKS.orders"):!run("WATERMARKS.orders"),`${road}: the snapshot ${road==="delta"?"has":"has no"} orders watermark`);
  run("resetWatermarks()");run("SYNC.reset()");
  // Section 4 paid for an id sweep of orders moments ago, and its ten-minute
  // throttle would skip the very check this road is about.
  run("for(const k in LAST_ID_SWEEP)delete LAST_ID_SWEEP[k]");
  store[PFX+"session_company"]=JSON.stringify(CID);
  posts.n=0;
  m=mountApp();
  m.boot();
  await settle(30);
  ok(!!ordersCell()&&ordersCell().v.length===1000,
     `${road}: after the reload the computer still holds all 1000 imported פק"ע (${ordersCell()?ordersCell().v.length:0})`);
  fireParked();
  await settle(60);
  ok(DB.orders.length===1000,`${road}: and sends them — the server now holds ${DB.orders.length} of 1000`);
  ok((DB.orders.find(r=>r.id==="imp3")||{}).received_date===null,`${road}: the one with the impossible day went with no date`);
  ok(DB.orders.every(r=>r.company_id===CID),`${road}: under the company it was imported into`);
  // app_users is not in this fake database, so the boot seeds the demo team —
  // that is the boot's own business and not part of the question here.
  const sent=posts.tables.slice(-posts.n).filter(t=>t!=="app_users"&&t!=="departments");
  ok(sent.length===5&&sent.every(t=>t==="orders"),
     `${road}: only the missing פק"ע were sent, nothing the server already held (${sent.join(",")||"nothing"})`);
}

// ── …without bringing back what was deleted elsewhere ──────────────────────
// The rule above — no companyId means "never saved" — has one way to go wrong: a
// row that *was* saved, on a phone put away before it read the row back, and then
// deleted from another device. Sent again on the next open, it would come back to
// life. So the snapshot stamps every row the server has accepted.
run("SYNC.reset()");
const planToDb=run("planToDb");
const mk=(id,extra)=>({id,userId:"u1",userName:"א",date:"2026-01-01",orderId:"o1",stageId:"s1",targetQty:1,...extra});
const sentPlan=mk("pl_sent"),unsentPlan=mk("pl_unsent"),readPlan=mk("pl_read",{companyId:CID});
run("SYNC.mark")("daily_plans",[planToDb(sentPlan)]);
const stamped=run("stampSent")("daily_plans",[sentPlan,unsentPlan,readPlan],CID);
ok(stamped[0].companyId===CID,"a row the server accepted is stored as the server's");
ok(!stamped[1].companyId,"one it never accepted is stored as unsaved");
ok(stamped[2]===readPlan,"one read from the server is stored untouched");
ok(!sentPlan.companyId,"and the row in the app's state is not changed");
const plain=[unsentPlan,readPlan];
ok(run("stampSent")("daily_plans",plain,CID)===plain,"nothing to stamp → the same array, nothing copied");

// The phone opens again. The office deleted the שיבוץ meanwhile.
DB.orders=imported.map(o=>({...orderToDb(o),created_at:iso(1),updated_at:iso(1)}));
DB.daily_plans=DB.daily_plans.filter(p=>p.id!=="pl_sent");
parked.clear();
run("resetWatermarks()");run("SYNC.reset()");
const seen2=await run("dbLoadAll()");
run("commitWatermarks")(seen2);
const held2={};for(const k of ["orders","projects","stages","stageBlocks","workLogs","customTasks","departments","dailyPlans","pnStandards"])held2[k]=seen2[k];
held2.dailyPlans=[...seen2.dailyPlans,...stamped.slice(0,2)];
await run("snapshotSave")(CID,held2);
run("resetWatermarks()");run("SYNC.reset()");
posts.n=0;posts.tables=[];
m=mountApp();
m.boot();
await settle(30);
fireParked();
await settle(60);
const plansCell=hooks.cells.find(c=>Array.isArray(c.v)&&c.v.some(p=>p&&p.date&&p.userId&&"targetQty" in p));
ok(!!plansCell&&!plansCell.v.some(p=>p.id==="pl_sent"),"the שיבוץ deleted elsewhere is gone from the phone");
ok(!DB.daily_plans.some(p=>p.id==="pl_sent"),"…and was not sent back to the server");
ok(DB.daily_plans.some(p=>p.id==="pl_unsent"),"while the one that never reached the server is sent now");

console.log("\n── 10. a burst of realtime messages ───────────────────────");
// When the computer finally saved the import, every phone that was open got one
// realtime message per פק"ע. Each was applied on its own — a merge of the whole
// collection, a render of the whole app and the offline copy written again — and
// two thousand of them froze a phone for minutes, stuck on ⏳ and showing none
// of them. The socket handler now queues and applies a burst in one pass.
ctx.fetch_=writable;
store[PFX+"session"]=JSON.stringify({id:"admin",username:"admin",companyId:CID});
store[PFX+"users"]=JSON.stringify([{id:"admin",username:"admin",role:"admin",name:"מנהל",active:true,companyId:CID}]);
const sockets=[];
ctx.WebSocket=function(){this.send=()=>{};this.close=()=>{};sockets.push(this)};
m=mountApp();
const live=hooks.effects.find(f=>/realtime\/v1\/websocket/.test(String(f)));
ok(!!live,"the realtime effect was found");
const stop=live();
const sock=sockets[sockets.length-1];
ok(!!sock,"and it opened a socket");
sock.onopen();
for(const t of ["orders","work_logs"])
  sock.onmessage({data:JSON.stringify({event:"phx_reply",topic:"realtime:public:"+t,payload:{status:"ok",response:{postgres_changes:[{table:t}]}}})});
let ordersWrites=0;
const realSet=localStorage.setItem;
localStorage.setItem=(k,v)=>{if(k===PFX+"orders")ordersWrites++;return realSet(k,v)};
const burst=imported.map(o=>({...orderToDb(o),updated_at:iso(5000000)}));
const t0=Date.now();
for(const rec of burst)
  sock.onmessage({data:JSON.stringify({event:"postgres_changes",topic:"realtime:public:orders",
    payload:{data:{type:"INSERT",table:"orders",schema:"public",record:rec}}})});
await settle(60);
localStorage.setItem=realSet;
const shown=hooks.cells.find(c=>Array.isArray(c.v)&&c.v.some(o=>o&&o.id==="imp0"));
ok(!!shown&&shown.v.length===1000,`all ${burst.length} rows from the burst are on screen (${shown?shown.v.length:0})`);
ok(ordersWrites<=3,`applied in one pass, not one per message (${ordersWrites} writes of the offline copy for ${burst.length} messages, ${Date.now()-t0} ms)`);
// A row saved and then deleted inside the same burst ends up deleted.
sock.onmessage({data:JSON.stringify({event:"postgres_changes",topic:"realtime:public:orders",payload:{data:{type:"INSERT",table:"orders",record:{...burst[0],id:"flash",updated_at:iso(5000001)}}}})});
sock.onmessage({data:JSON.stringify({event:"postgres_changes",topic:"realtime:public:orders",payload:{data:{type:"DELETE",table:"orders",old_record:{id:"flash"}}}})});
sock.onmessage({data:JSON.stringify({event:"postgres_changes",topic:"realtime:public:orders",payload:{data:{type:"DELETE",table:"orders",old_record:{id:"imp5"}}}})});
await settle(60);
const settled=hooks.cells.find(c=>Array.isArray(c.v)&&c.v.some(o=>o&&o.id==="imp0"));
ok(!settled.v.some(o=>o.id==="flash"),"a row added and deleted in one burst is not left behind");
ok(!settled.v.some(o=>o.id==="imp5")&&settled.v.length===999,"and a plain delete in a burst still lands");
if(typeof stop==="function")stop();
ctx.fetch_=(url,opts)=>handle(url,opts);

console.log("\n── 11. a read already running ─────────────────────────────");
// After a Priority import of 13,882 פק"ע and 106,998 progress records, a phone
// opened on yesterday's snapshot and began reading all of them — and then the
// sweep two seconds later began the same read again, and so did every tap on
// refresh, every return to the app, every logout and login. Seventeen reads in
// ten minutes, 129 pages between them, and not one of them finished. A sweep
// now leaves a running read alone, and a refresh waits for it.
let openGate;const gate3=new Promise(r=>{openGate=r});
const starts={};
// A read starts on its first page: row 0, and no cursor saying where the page
// before it ended (a keyset page is always row 0 too — it is the cursor that
// moves). The NULL tail of a full read is part of the same read.
const firstPage=(url,opts)=>{
  const rng=opts&&opts.headers&&opts.headers.Range;
  return!!rng&&rng.startsWith("0-")&&!(opts&&opts.method)&&!/[?&](or=|id=gt\.)|=is\.null/.test(url);
};
ctx.fetch_=async(url,opts)=>{
  const t=new URL(url).pathname.split("/rest/v1/")[1];
  if(firstPage(url,opts))starts[t]=(starts[t]||0)+1;
  await gate3;return handle(url,opts);
};
// The header is only drawn once the splash is down, so render a second time with
// `loading` cleared and pick the refresh handler off the props it is given.
let tapRefresh=null;
m=mountApp();
m.loading.v=false;hooks.slot=0;hooks.effects=[];
const realCE=React.createElement;
React.createElement=(type,props)=>{if(props&&typeof props.onRefresh==="function")tapRefresh=props.onRefresh;return null};
run("App")();
React.createElement=realCE;
ok(typeof tapRefresh==="function","the header's refresh button was found");
const sweepLoop=hooks.effects.find(f=>/realtime\/v1\/websocket/.test(String(f)));
const running=run("dbLoadAll()");
ok(run("dbReadBusy()"),"a read on its way is seen as one");
const stopLoop=sweepLoop();
fireParked();
await settle();
ok(starts.work_logs===1,`the sweep does not start a second read beside it (${starts.work_logs} read of work_logs)`);
const taps=[tapRefresh(),tapRefresh(),tapRefresh()];
ok(taps[0]===taps[1]&&taps[1]===taps[2],"three taps on refresh are one refresh");
fireParked();
await settle();
ok(starts.work_logs===1,`and the refresh waits instead of racing it (${starts.work_logs} read of work_logs)`);
openGate();
await running;
await taps[0];
ok(starts.work_logs===2,`once it lands, the refresh reads — once (${starts.work_logs} reads of work_logs)`);
ok(!run("dbReadBusy()"),"and nothing is left marked as running");
fireParked();
await settle(40);
ok(starts.work_logs===3,`with nothing running, the sweep reads again (${starts.work_logs} reads of work_logs)`);
if(typeof stopLoop==="function")stopLoop();
ctx.fetch_=(url,opts)=>handle(url,opts);

console.log("\n── 12. the morning after a replace import ─────────────────");
// What happened in production. A Priority import replaced every פק"ע (13,882) and
// every progress record (106,998). A phone holding yesterday's copy had to read
// all of them again as a delta, six offset pages at a time: the deep pages cost
// the database a second and a half each, went past its three-second limit as
// soon as a few phones did it at once, and one failed page threw away the whole
// sweep — including the שיבוץ the department manager had just made, which sat on
// the server and never reached the worker. Scaled down here to 1,500 פק"ע and
// 30,000 records, written in batches of 300 that share a timestamp, as an
// import's upserts do.
ctx.fetch_=(url,opts)=>handle(url,opts);
const KEYS=["orders","projects","stages","stageBlocks","workLogs","customTasks","departments","dailyPlans","pnStandards"];
const at=n=>new Date(Date.UTC(2026,9,7,5,38,0)+n*7).toISOString();
const mkOrder=(id,i,t)=>({id,wo_number:"FT2-"+id,pn:"PN"+(i%40),description:"",qty:10,unit_price:0,project_id:"p1",branch:"53",
  received_date:null,target_date:null,stage_ids:["s1","s2"],block_id:null,serials:[{id:id+"s1",sn:"1"}],shortages:[],defects:[],
  delivered_serials:[],status:"partial",erp_status:"ממתין ליצור",erp_note:null,company_id:CID,created_at:t,updated_at:t});
const mkLog=(id,i,t)=>({id,user_id:"u"+(i%9),user_name:"עובדת",serial_id:null,serial_sn:null,stage_id:"s1",order_id:"n"+(i%1500),
  start_time:t,end_time:t,completed:true,duration_min:0,paused:false,pause_start:null,total_pause_min:0,pause_log:[],
  bulk:true,bulk_group_id:null,bulk_count:1,hold_info:null,company_id:CID,created_at:t,updated_at:t});
// Yesterday: what the phone went to sleep holding.
DB.orders=Array.from({length:300},(_,i)=>mkOrder("y"+i,i,iso(i)));
DB.work_logs=Array.from({length:2000},(_,i)=>mkLog("old"+i,i,iso(i)));
DB.daily_plans=[];
run("resetWatermarks()");run("SYNC.reset()");run("for(const k in LAST_ID_SWEEP)delete LAST_ID_SWEEP[k]");
const yday=await run("dbLoadAll()");
run("commitWatermarks")(yday);
const ydayWm={...run("WATERMARKS")};
const heldY={reconcile:false};for(const k of KEYS)heldY[k]=yday[k];
// The import. Ids are scrambled against the timestamps, so the tie-break on id
// is what decides the order inside a batch — and a page ends in mid-batch.
const IMPORT=30000,BATCH=300;
DB.orders=Array.from({length:1500},(_,i)=>mkOrder("n"+i,i,at(Math.floor(i/BATCH))));
DB.work_logs=Array.from({length:IMPORT},(_,i)=>mkLog("L"+((i*7919)%IMPORT),i,at(10+Math.floor(i/BATCH))));
const serverLogIds=new Set(DB.work_logs.map(r=>r.id));
// …and an hour later, the department manager's שיבוץ.
DB.daily_plans.push({id:"plan_ofir",user_id:"ko75x6a",user_name:"ילנה",plan_date:"2026-10-07",order_id:"n7",stage_id:"s1",
  target_qty:10,serial_ids:[],note:null,done:false,created_by:"19v6ezm",created_by_name:"אופיר",company_id:CID,
  created_at:at(500),updated_at:at(500)});
const newLogs=list=>list.filter(w=>w.id.startsWith("L"));

// ── what the old paging cost the database ─────────────────────────────────
const deltaQ=`select=${run("COLS").work_logs}&company_id=eq.${CID}&updated_at=gte.${encodeURIComponent(ydayWm.work_logs)}&${run("DELTA_ORDER")}`;
resetStats();
const byOffset=await run("SB.getAll")("work_logs",deltaQ);
const offsetScanned=stats.scanned;
ok(byOffset.length===IMPORT,`(offset paging reads the ${IMPORT} rows too)`);

// ── the first sweep: everything small lands, work_logs comes in part ──────
resetStats();
const s1=await run("dbLoadAll")(heldY);
ok(s1.dailyPlans.some(p=>p.id==="plan_ofir"),"the שיבוץ reaches the phone on the first sweep");
ok(s1.orders.filter(o=>o.id.startsWith("n")).length===1500,'so do all 1,500 imported פק"ע');
ok(s1.more===true,"work_logs is not all there yet, and the sweep says so");
ok(newLogs(s1.workLogs).length===20*1000,`it brought twenty pages of it (${newLogs(s1.workLogs).length})`);
ok(!!s1.watermarks.work_logs&&s1.watermarks.work_logs>ydayWm.work_logs,"and moved the work_logs watermark past them");
const ks1=stats.byTable.work_logs.scanned;
run("commitWatermarks")(s1);
const held1={reconcile:false};for(const k of KEYS)held1[k]=s1[k];
resetStats();
const s2=await run("dbLoadAll")(held1);
const ksAll=ks1+stats.byTable.work_logs.scanned;
ok(!s2.more,"the next sweep finishes it");
const got=newLogs(s2.workLogs);
ok(got.length===IMPORT&&new Set(got.map(w=>w.id)).size===IMPORT,`every imported record, once (${got.length})`);
ok(got.every(w=>serverLogIds.has(w.id)),"and only those");
console.log(`  database rows walked to deliver ${IMPORT} records: by offset ${offsetScanned}, by keyset ${ksAll}`);
ok(ksAll<=IMPORT+2*BATCH,`keyset: no page walks past rows it does not return (${ksAll})`);
ok(offsetScanned>10*ksAll,`offset paging walked ${Math.round(offsetScanned/ksAll)}× as many rows for the same read`);
run("commitWatermarks")(s2);
// Yesterday's records are gone from the server; the reconcile takes them off.
const heldR={reconcile:true};for(const k of KEYS)heldR[k]=s2[k];
run("for(const k in LAST_ID_SWEEP)delete LAST_ID_SWEEP[k]");
const s3=await run("dbLoadAll")(heldR);
ok(s3.workLogs.length===IMPORT&&s3.workLogs.every(w=>serverLogIds.has(w.id)),"after the reconcile the phone holds exactly what the server does");

// ── a page that fails half way ────────────────────────────────────────────
const timeout={ok:false,status:500,text:async()=>JSON.stringify({code:"57014",message:"canceling statement due to statement timeout"})};
let wlPages=0,failAt=5;
const wlUrls=[];
ctx.fetch_=(url,opts)=>{
  if(/\/work_logs\?/.test(url)&&!(opts&&opts.method)){wlUrls.push(url);if(++wlPages===failAt)return timeout}
  return handle(url,opts);
};
run("resetWatermarks()");run("commitWatermarks")({watermarks:ydayWm});run("SYNC.reset()");
const f1=await run("dbLoadAll")(heldY);
ok(f1.dailyPlans.some(p=>p.id==="plan_ofir"),"a work_logs page past the time limit no longer holds back the שיבוץ");
ok(f1.orders.filter(o=>o.id.startsWith("n")).length===1500,'…nor the פק"ע');
ok(!!f1.failed&&f1.failed.length===1&&f1.failed[0].t==="work_logs"&&f1.failed[0].progress===true,"the failure is reported, as one that got somewhere");
ok(newLogs(f1.workLogs).length===4000,`the four pages read before it are kept (${newLogs(f1.workLogs).length})`);
ok(f1.more===true,"and the sweep is told to carry on");
run("commitWatermarks")(f1);
wlUrls.length=0;failAt=-1;
const held3={reconcile:false};for(const k of KEYS)held3[k]=f1[k];
resetStats();
const f2=await run("dbLoadAll")(held3);
const resumedFrom=decodeURIComponent((/updated_at=gte\.([^&]+)/.exec(wlUrls[0])||[])[1]||"");
ok(resumedFrom===f1.watermarks.work_logs,"the next sweep starts where the failure stopped it, not at yesterday");
run("commitWatermarks")(f2);
const held4={reconcile:false};for(const k of KEYS)held4[k]=f2[k];
const f3=await run("dbLoadAll")(held4);
const reread=stats.byTable.work_logs.rows-(IMPORT-4000);
ok(reread<=2*BATCH,`and reads only what is left — ${reread} rows read twice, against 4,000 had it started over`);
ok(newLogs(f3.workLogs).length===IMPORT&&new Set(newLogs(f3.workLogs).map(w=>w.id)).size===IMPORT,"until all of it is in, once");

// A failure on the very first page: nothing to keep, everything else still lands.
wlPages=0;failAt=1;
run("resetWatermarks()");run("commitWatermarks")({watermarks:ydayWm});run("SYNC.reset()");
const g1=await run("dbLoadAll")(heldY);
ok(g1.dailyPlans.some(p=>p.id==="plan_ofir"),"a work_logs read that fails at once still lets the שיבוץ through");
ok(g1.workLogs===heldY.workLogs,"work_logs stays what the phone held, untouched");
ok(!!g1.failed&&g1.failed[0].progress===false&&!g1.watermarks.work_logs,"reported as a failure that got nowhere, its watermark left alone");
// With nothing held to fall back on there is nothing to show either, so a cold
// read still fails whole — as it always did.
wlPages=0;failAt=1;
let coldErr=null;
try{await run("dbLoadAll()")}catch(e){coldErr=e}
ok(!!coldErr,"a cold read (nothing held) still fails as a whole");
ctx.fetch_=(url,opts)=>handle(url,opts);

// ── full reads walk by keyset too, NULLs included ─────────────────────────
DB.daily_plans.push({...DB.daily_plans[0],id:"plan_null",created_at:null});
const orderUrls=[];
ctx.fetch_=(url,opts)=>{if(/\/orders\?/.test(url))orderUrls.push(decodeURIComponent(url));return handle(url,opts)};
run("resetWatermarks()");run("SYNC.reset()");
resetStats();
const cold=await run("dbLoadAll()");
ok(cold.orders.length===1500&&new Set(cold.orders.map(o=>o.id)).size===1500,'a full read of 1,500 פק"ע across pages: all of them, once');
ok(orderUrls.every(u=>/select=[^&]*created_at/.test(u)),"the cursor column is asked for with them");
ok(cold.dailyPlans.filter(p=>p.id==="plan_null").length===1,"a row with no created_at is read, once");
ok(cold.workLogs.length===IMPORT,`work_logs whole (${cold.workLogs.length})`);
ok(stats.byTable.work_logs.scanned<=IMPORT+1000,`with no offset walked past (${stats.byTable.work_logs.scanned} rows for ${IMPORT})`);
ctx.fetch_=(url,opts)=>handle(url,opts);
DB.daily_plans=DB.daily_plans.filter(p=>p.id!=="plan_null");

// ── the sweep loop itself ─────────────────────────────────────────────────
// The app, not just the sync layer: the sweep applies what did land, even though
// a table failed, and comes straight back for the rest.
run("resetWatermarks()");run("commitWatermarks")({watermarks:ydayWm});run("SYNC.reset()");
wlPages=0;failAt=3;
ctx.fetch_=(url,opts)=>{
  if(/\/work_logs\?/.test(url)&&!(opts&&opts.method)&&++wlPages===failAt)return timeout;
  return handle(url,opts);
};
// Which delay each sweep re-arms itself with.
const armed=[];
const parkSet=ctx.setTimeout;
ctx.setTimeout=(fn,ms,...a)=>{if(fn&&fn.name==="poll")armed.push(ms);return parkSet(fn,ms,...a)};
const quiet=async()=>{await settle(5);while(run("dbReadBusy()"))await settle(5);await settle(10)};
parked.clear();
m=mountApp();
const loop=hooks.effects.find(f=>/realtime\/v1\/websocket/.test(String(f)));
const stopLoop2=loop();
fireParked();
await quiet();
const plansNow=hooks.cells.find(c=>Array.isArray(c.v)&&c.v.some(p=>p&&p.id==="plan_ofir"));
ok(!!plansNow,"the sweep put the שיבוץ on screen while work_logs was failing");
const logsNow=()=>hooks.cells.find(c=>Array.isArray(c.v)&&c.v.some(w=>w&&typeof w.id==="string"&&w.id.startsWith("L")&&"stageId" in w));
ok(!!logsNow()&&newLogs(logsNow().v).length===2000,`with the two pages that came before the failure (${logsNow()?newLogs(logsNow().v).length:0})`);
ok(armed[armed.length-1]===1500,`and comes back for the rest in a moment, not at the next interval (${armed[armed.length-1]} ms)`);
for(let i=0;i<6&&!(logsNow()&&newLogs(logsNow().v).length===IMPORT);i++){fireParked();await quiet()}
ok(!!logsNow()&&newLogs(logsNow().v).length===IMPORT,`a few sweeps later all ${IMPORT} are on screen (${logsNow()?newLogs(logsNow().v).length:0})`);
ok(armed[armed.length-1]>1500,`and once it is all in, the sweep goes back to its usual pace (${armed[armed.length-1]} ms)`);
if(typeof stopLoop2==="function")stopLoop2();
ctx.setTimeout=parkSet;
ctx.fetch_=(url,opts)=>handle(url,opts);

// A server that cannot parse the cursor filters must not leave a phone with
// nothing: the read falls back to offset paging, slower and still whole.
ctx.fetch_=(url,opts)=>/[?&]or=/.test(url)
  ?{ok:false,status:400,text:async()=>JSON.stringify({code:"PGRST100",message:"\"failed to parse logic tree\""})}
  :handle(url,opts);
run("resetWatermarks()");run("commitWatermarks")({watermarks:ydayWm});run("SYNC.reset()");
const fb=await run("dbLoadAll")(heldY);
ok(!fb.failed&&newLogs(fb.workLogs).length===IMPORT,`a server that refuses the cursor still gets read, by offset (${newLogs(fb.workLogs).length})`);
ok(run("SB_KEYSET_OFF")===true,"and the session stays on offset paging from then on");
run("SB_KEYSET_OFF=false");
ctx.fetch_=(url,opts)=>handle(url,opts);

console.log(`\n${fails?"✗ "+fails+" failed":"✓ all assertions passed"}`);
process.exit(fails?1:0);
})().catch(e=>{console.error("harness error:",e);process.exit(1)});
