// A throwaway Postgres for the database tests (db-test.js, erp-test.js).
//
// start() returns null when the machine has no Postgres server binaries or no
// `pg` module — the callers report that and pass, since they can prove
// nothing there. Otherwise it returns {db, q, as, svc, anon, user, stop}:
// `as(role, claims, sql, params)` runs one statement the way PostgREST would,
// under a role and a set of JWT claims, inside its own transaction.
const fs=require("fs"),os=require("os"),path=require("path");
const {execFileSync,spawnSync}=require("child_process");
const ROOT=path.join(__dirname,"..");
const SQL=f=>fs.readFileSync(path.join(ROOT,f),"utf8");

function pgBin(){
  const cands=[process.env.PG_BIN,"/usr/lib/postgresql/17/bin","/usr/lib/postgresql/16/bin","/usr/lib/postgresql/15/bin",
    "/usr/local/pgsql/bin","/opt/homebrew/bin","/usr/local/bin","/usr/bin"].filter(Boolean);
  return cands.find(d=>fs.existsSync(path.join(d,"initdb"))&&fs.existsSync(path.join(d,"pg_ctl")))||null;
}

async function start(){
  let pg;
  try{pg=require("pg")}catch{return{skip:"the pg module is not installed (npm install)"}}
  const BIN=pgBin();
  if(!BIN)return{skip:"no Postgres server binaries (initdb/pg_ctl) on this machine"};
  // initdb refuses to run as root, so as root the cluster belongs to `postgres`.
  const asRoot=process.getuid&&process.getuid()===0;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"omniview-db-"));
  const run=(cmd,args)=>{
    const full=path.join(BIN,cmd);
    const r=asRoot?spawnSync("runuser",["-u","postgres","--",full,...args],{encoding:"utf8"})
                  :spawnSync(full,args,{encoding:"utf8"});
    if(r.status!==0)throw new Error(`${cmd} failed: ${r.stderr||r.stdout}`);
  };
  if(asRoot)execFileSync("chown",["postgres",dir]);
  const port=55000+Math.floor(Math.random()*5000);
  run("initdb",["-D",path.join(dir,"data"),"-A","trust","-U","postgres","-E","UTF8","--locale=C.UTF-8"]);
  run("pg_ctl",["-D",path.join(dir,"data"),"-o",`-p ${port} -k ${dir} -c listen_addresses=''`,"-l",path.join(dir,"log"),"-w","start"]);
  let stopped=false;
  const stop=()=>{if(stopped)return;stopped=true;
    try{run("pg_ctl",["-D",path.join(dir,"data"),"-m","immediate","stop"])}catch{}
    try{fs.rmSync(dir,{recursive:true,force:true})}catch{}};
  process.on("exit",stop);

  const db=new pg.Client({host:dir,port,user:"postgres",database:"postgres"});
  await db.connect();
  const q=(text,params)=>db.query(text,params);
  // One connection, so one statement at a time — like PostgREST, each call is
  // its own transaction with its own role and claims.
  let chain=Promise.resolve();
  const as=(role,claims,text,params)=>{
    const job=chain.then(async()=>{
      await q("begin");
      try{
        await q(`set local role ${role}`);
        await q("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role,...(claims||{})})]);
        const r=await q(text,params);
        await q("commit");
        return{rows:r.rows,count:r.rowCount};
      }catch(e){await q("rollback");return{error:e.message,code:e.code}}
    });
    chain=job.catch(()=>{});
    return job;
  };
  const user=id=>({app_metadata:{app_user_id:id}});
  const svc=(text,params)=>as("service_role",{},text,params);
  const anon=(text,params)=>as("anon",{},text,params);
  // PostgREST's /rpc/<name> with a JSON body of named arguments.
  const rpc=async(name,args)=>{
    const keys=Object.keys(args||{});
    const vals=keys.map(k=>{const v=args[k];return(v!==null&&typeof v==="object"&&!Array.isArray(v))||(Array.isArray(v)&&v.some(x=>x&&typeof x==="object"))?JSON.stringify(v):v});
    const r=await svc(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(", ")}) as r`,vals);
    if(r.error)throw new Error(`${name}: ${r.error}`);
    return r.rows[0].r;
  };
  const applyBase=async()=>{
    await q(SQL("supabase/tests/00_supabase_stub.sql"));
    await q(SQL("supabase/tests/01_baseline_schema.sql"));
  };
  const applyPhase1=async()=>q(SQL("supabase/migrations/20261007150000_prepare_secure_auth_and_erp.sql"));
  const applyLockdown=async()=>q(SQL("supabase/pending/lockdown.sql"));
  return{db,q,as,svc,anon,user,rpc,stop,applyBase,applyPhase1,applyLockdown};
}

function reporter(){
  let fail=0;
  const ok=(cond,what)=>{if(!cond)fail++;console.log(`  ${cond?"✓":"✗"} ${what}`)};
  const eq=(got,want,what)=>{
    const same=JSON.stringify(got)===JSON.stringify(want);
    if(!same)fail++;
    console.log(`  ${same?"✓":"✗"} ${what}${same?"":`   (got ${JSON.stringify(got)}, expected ${JSON.stringify(want)})`}`);
  };
  const done=()=>{console.log(fail?`\n✗ ${fail} assertion(s) failed`:"\n✓ all assertions passed");return fail};
  return{ok,eq,done};
}

module.exports={start,reporter,SQL};
