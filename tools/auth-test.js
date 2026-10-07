#!/usr/bin/env node
/**
 * Signing in, end to end: the auth Edge Function's handler against the real
 * login functions in a throwaway Postgres (both migration phases applied), with
 * Supabase Auth's admin API played by an in-memory fake.
 *
 *   npm test        (or: node tools/auth-test.js)
 */
const H=require("./pg-harness");
const {ok,eq,done}=H.reporter();
const A="00000000-0000-0000-0000-000000000001";

(async()=>{
  const {createHandler,gotrueAdmin,authEmail}=await import("../supabase/functions/auth/handler.mjs");

  console.log("\n── Supabase Auth over HTTP ────────────────────────────────");
  {
    let calls=0;const waits=[];
    const fake=async(url,opts)=>{calls++;
      const status=calls<3?429:200;
      return new Response(JSON.stringify(status===200?{access_token:"t",refresh_token:"r",expires_in:3600}:{msg:"rate"}),{status});
    };
    const g=gotrueAdmin({url:"https://x",serviceKey:"k",fetchImpl:fake,sleep:async ms=>{waits.push(ms)}});
    const s=await g.signIn("a@b.invalid","pw");
    eq([s&&s.access_token,calls,waits.length],["t",3,2],"a sign-in turned away by the rate limit is waited out and retried");
    const g2=gotrueAdmin({url:"https://x",serviceKey:"k",fetchImpl:async()=>new Response('{"error":"invalid_grant"}',{status:400})});
    eq(await g2.signIn("a@b.invalid","pw"),null,"wrong credentials are a plain no, not an error");
    const e=await authEmail("Ab_1");
    ok(/^u-ab1-[0-9a-f]{8}@users\.omniview\.invalid$/.test(e),"the Auth address is derived from the user id, on an undeliverable domain");
    ok(e!==await authEmail("ab1"),"…and two ids that differ only in case get different addresses");
  }

  const pg=await H.start();
  if(pg.skip){console.log(`○ auth-test database part skipped — ${pg.skip}`);process.exit(done()?1:0)}
  const {q,as,rpc}=pg;
  await pg.applyBase();
  const crypto=require("crypto"),sha=s=>crypto.createHash("sha256").update(s).digest("hex");
  await q(`insert into app_users(id,username,password_hash,password_plain,role,name,company_id) values
     ('a_admin','admin',$2,'admin123','admin','מנהל',$1),('a_w1','dana',$3,null,'worker','דנה',$1)`,[A,sha("admin123"),sha("1234")]);
  await q(`insert into orders(id,wo_number,company_id) values ('o1','WO-1',$1)`,[A]);
  await pg.applyPhase1();
  await pg.applyLockdown();

  // Supabase Auth, in memory.
  const auth={users:new Map(),created:0,updated:0};
  const gotrue={
    async createUser(u){
      if([...auth.users.values()].some(x=>x.email===u.email))throw Object.assign(new Error("A user with this email address has already been registered"),{status:422});
      const id=crypto.randomUUID();auth.users.set(id,{id,...u});auth.created++;return{id};
    },
    async updateUser(id,u){const x=auth.users.get(id);Object.assign(x,u);auth.updated++;return x},
    async findUserIdByEmail(email){return([...auth.users.values()].find(x=>x.email===email)||{}).id||null},
    async signIn(email,password){
      const x=[...auth.users.values()].find(u=>u.email===email&&u.password===password);
      if(!x)return null;
      return{access_token:JSON.stringify({sub:x.id,role:"authenticated",app_metadata:x.app_metadata}),refresh_token:"r-"+x.id,expires_in:3600};
    },
  };
  const handle=createHandler({rpc,gotrue,log:{error(){}}});
  const post=async(route,body)=>{
    const r=await handle(new Request(`https://x.supabase.co/functions/v1/auth${route}`,{method:"POST",
      headers:{"content-type":"application/json"},body:JSON.stringify(body)}));
    return{status:r.status,body:await r.json(),cors:r.headers.get("access-control-allow-origin")};
  };

  console.log("\n── login ──────────────────────────────────────────────────");
  {
    const r=await post("/login",{username:"admin",password:"admin123"});
    eq([r.status,r.body.ok,r.body.user.id,r.cors],[200,true,"a_admin","*"],"the right password signs in (from the browser — CORS allowed)");
    ok(r.body.session.access_token&&r.body.session.refresh_token&&r.body.session.expires_at>0,"…with a session to keep");
    const u=[...auth.users.values()][0];
    ok(u.email.endsWith("@users.omniview.invalid")&&u.app_metadata.app_user_id==="a_admin","an Auth account is created for the user, carrying their app id");
    ok(u.password!=="admin123","…whose password is not the user's");
    const claims=JSON.parse(r.body.session.access_token);
    const seen=await as("authenticated",claims,"select id from orders");
    eq(seen.rows.map(x=>x.id),["o1"],"the token it hands out opens the company's data");
    await post("/login",{username:"admin",password:"admin123"});
    eq(auth.created,1,"the next login reuses the same Auth account");
    const old=await post("/login",{username:"dana",password:"1234"});
    eq(old.status,200,"an account that only ever had the old hash signs in too");
  }
  {
    const r=await post("/login",{username:"dana",password:"wrong"});
    eq([r.status,r.body.error,r.body.attempts],[401,"bad_credentials",1],"a wrong password → 401, attempt 1");
    ok(/שגויים/.test(r.body.message),"…with a message the floor can read");
    for(let i=0;i<4;i++)await post("/login",{username:"dana",password:"wrong"});
    const l=await post("/login",{username:"dana",password:"1234"});
    eq([l.status,l.body.error],[423,"locked"],"five wrong passwords lock the account");
    eq(auth.users.size,2,"no session or account came out of the failed attempts");
    const n=await post("/login",{username:"ghost",password:"x"});
    eq(n.status,401,"an unknown user → the same 401");
  }
  {
    const id=[...auth.users.values()].find(x=>x.app_metadata.app_user_id==="a_admin").id;
    auth.users.get(id).password="tampered";
    const r=await post("/login",{username:"admin",password:"admin123"});
    eq([r.status,auth.updated>0],[200,true],"an Auth account that drifted is repaired on the next login");
    await q("update private.user_secrets set auth_user_id=null where app_user_id='a_admin'");
    const r2=await post("/login",{username:"admin",password:"admin123"});
    eq([r2.status,auth.created],[200,2],"an Auth account created but never recorded is found again, not duplicated");
  }

  console.log("\n── sign-up ────────────────────────────────────────────────");
  {
    const r=await post("/register",{company_name:"מפעל חדש",admin_name:"רות",username:"ruth",password:"Strong-Pw1"});
    eq([r.status,r.body.user.role],[200,"admin"],"a new company signs up and its admin is signed in");
    const claims=JSON.parse(r.body.session.access_token);
    const mine=await as("authenticated",claims,"select count(*)::int n from orders");
    eq(mine.rows[0].n,0,"…and sees an empty company, not anyone else's");
    eq((await post("/register",{company_name:"x",admin_name:"x",username:"ruth",password:"Strong-Pw1"})).status,409,"a taken username → 409");
    eq((await post("/register",{company_name:"x",admin_name:"x",username:"z",password:"short"})).status,400,"a short password → 400");
  }
  {
    const r=await handle(new Request("https://x/functions/v1/auth/login",{method:"OPTIONS"}));
    eq(r.status,204,"the browser's CORS preflight is answered");
    eq((await handle(new Request("https://x/functions/v1/auth/login",{method:"POST",body:"{"}))).status,400,"a body that is not JSON → 400");
  }

  await pg.db.end();
  process.exit(done()?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
