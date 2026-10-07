#!/usr/bin/env node
/**
 * The database side of the secure-auth and Priority ⇄ Engini work, run against
 * a real Postgres rather than reasoned about.
 *
 * A throwaway cluster is started in a temp directory, given just enough of a
 * Supabase project (roles, auth.jwt(), Vault — supabase/tests/00_supabase_stub.sql)
 * and the production schema as it stood before this work
 * (01_baseline_schema.sql). Then the two phases are applied in order and each
 * is checked for what it promises:
 *
 *   phase 1 (prepare)  — today's client keeps working exactly as before; the new
 *                        login, password and Engini functions work beside it.
 *   phase 2 (lockdown) — the public key opens nothing, a signed-in user sees and
 *                        changes only their own company, and a work-order number
 *                        cannot exist twice.
 *
 * Needs the Postgres server binaries (initdb / pg_ctl). Where they are not
 * installed the test says so and passes — it cannot prove anything there.
 *
 *   npm test        (or: node tools/db-test.js)
 */
const crypto=require("crypto");
const H=require("./pg-harness");
const {ok,eq,done}=H.reporter();
const sha=s=>crypto.createHash("sha256").update(s).digest("hex");

const A="00000000-0000-0000-0000-000000000001";
const B="00000000-0000-0000-0000-0000000000b2";

(async()=>{
  const pg=await H.start();
  if(pg.skip){console.log(`○ db-test skipped — ${pg.skip}`);process.exit(0)}
  const {db,q,as,svc,anon,user}=pg;
  await pg.applyBase();

  // ── a company as it looks today ────────────────────────────────────────
  await q(`insert into companies(id,name,slug) values ($1,'Company B','company-b')`,[B]);
  const U=(id,username,pw,role,cid,dept,{plain=true}={})=>q(
    `insert into app_users(id,username,password_hash,password_plain,role,name,company_id,department_id)
     values ($1,$2,$3,$4,$5,$1,$6,$7)`,[id,username,sha(pw),plain?pw:null,role,cid,dept||null]);
  await U("a_admin","admin","admin123","admin",A);
  await U("a_mgr","avi","1234","dept_manager",A,"dA1");
  await U("a_w1","dana","1234","worker",A,"dA1");
  await U("a_w2","itay","1234","worker",A,"dA2");
  await U("a_view","viewer","1234","viewer",A);
  await U("a_old","oldtimer","Secret9!","worker",A,"dA1",{plain:false});
  await U("b_admin","boss_b","bpass","admin",B);
  await q(`insert into departments(id,name,manager_id,company_id) values ('dA1','הרכבה','a_mgr',$1),('dA2','בדיקות',null,$1)`,[A]);
  await q(`insert into stages(id,name,stage_order,company_id) values ('s1','הרכבה מכנית',1,$1),('s2','בדיקה',2,$1),('sb','B stage',1,$2)`,[A,B]);
  await q(`insert into orders(id,wo_number,pn,qty,stage_ids,serials,company_id) values
     ('oA1','WO-100','PN-1',2,'["s1","s2"]','[{"id":"oA1s1","sn":"SN1"},{"id":"oA1s2","sn":"SN2"}]',$1),
     ('oB1','WO-100','PN-B',1,'["sb"]','[]',$2)`,[A,B]);

  console.log("\n── phase 1: prepare ───────────────────────────────────────");
  await pg.applyPhase1();

  // Today's client: anon key, compares hashes it reads, writes what it likes.
  {
    const r=await anon("select id,password_hash from app_users where username='dana'");
    eq(r.rows&&r.rows.length,1,"the old client can still read its users with the anon key");
    const w=await anon("update orders set status='partial' where id='oA1'");
    eq(w.count,1,"…and still save a פק\"ע");
  }

  // Login through the server.
  {
    const r=await svc("select svc_login('dana','1234') as r");
    const res=r.rows[0].r;
    ok(res.ok===true,"svc_login: a correct password signs in");
    ok(!("password_hash" in res.user)&&!("password_plain" in res.user),"the profile it returns carries no password field");
    ok(typeof res.auth.secret==="string"&&res.auth.secret.length>=32,"and an Auth secret that is not the user's password");
    const again=(await svc("select svc_login('dana','1234') as r")).rows[0].r;
    eq(again.auth.secret,res.auth.secret,"the Auth secret is stable between logins");
    const old=(await svc("select svc_login('oldtimer','Secret9!') as r")).rows[0].r;
    ok(old.ok===true,"an account with only the old hash still signs in");
    const kept=(await q("select pw_enc is not null as enc, legacy_sha256 from private.user_secrets where app_user_id='a_old'")).rows[0];
    ok(kept.enc&&kept.legacy_sha256===null,"…and from then on is kept encrypted, the old hash dropped");
    const bad=(await svc("select svc_login('dana','nope') as r")).rows[0].r;
    eq([bad.ok,bad.error,bad.attempts],[false,"bad_credentials",1],"a wrong password counts an attempt");
    for(let i=0;i<4;i++)await svc("select svc_login('dana','nope')");
    const locked=(await svc("select svc_login('dana','1234') as r")).rows[0].r;
    eq([locked.ok,locked.error],[false,"locked"],"five wrong passwords lock the account, even against the right one");
    await q("update app_users set locked_until=null, login_attempts=0 where id='a_w1'");
    const ghost=(await svc("select svc_login('nobody','x') as r")).rows[0].r;
    eq(ghost.error,"bad_credentials","an unknown user gets the same answer as a wrong password");
  }

  // The old client changing a password in the meantime is not lost.
  {
    await anon("update app_users set password_hash=$1, password_plain='NewPw1' where id='a_w2'",[sha("NewPw1")]);
    const n=(await svc("select svc_login('itay','NewPw1') as r")).rows[0].r;
    const o=(await svc("select svc_login('itay','1234') as r")).rows[0].r;
    eq([n.ok,o.ok],[true,false],"a password changed by the old client works at once, and the old one stops");
  }

  // Who may set and see passwords.
  {
    const r1=await as("authenticated",user("a_admin"),"select set_user_password('a_w1','Fresh-1')");
    ok(!r1.error,"an admin sets a password in their company");
    eq((await svc("select svc_login('dana','Fresh-1') as r")).rows[0].r.ok,true,"…and it is the password from then on");
    const legacy=(await q("select password_hash, password_plain from app_users where id='a_w1'")).rows[0];
    eq([legacy.password_hash===sha("Fresh-1"),legacy.password_plain],[true,"Fresh-1"],"until phase 2 the old columns follow, so old devices still log in");
    const r2=await as("authenticated",user("a_admin"),"select set_user_password('b_admin','x')");
    ok(/not allowed/.test(r2.error||""),"never in another company");
    const r3=await as("authenticated",user("a_mgr"),"select set_user_password('a_w1','Mgr-1')");
    ok(!r3.error,"a department manager sets one for their own department");
    const r4=await as("authenticated",user("a_mgr"),"select set_user_password('a_w2','x')");
    ok(/not allowed/.test(r4.error||""),"…not for another department");
    const r5=await as("authenticated",user("a_mgr"),"select set_user_password('a_admin','x')");
    ok(/not allowed/.test(r5.error||""),"…and never for an admin");
    const r6=await as("authenticated",user("a_w2"),"select set_user_password('a_w1','x')");
    ok(/not allowed/.test(r6.error||""),"a worker cannot set someone else's");
    const r7=await as("authenticated",user("a_w2"),"select set_user_password('a_w2','Mine-2')");
    ok(!r7.error,"anyone can set their own");
    const r8=await as("authenticated",{},"select set_user_password('a_w2','x')");
    ok(/not signed in/.test(r8.error||""),"a token with no app user cannot");

    const seen=await as("authenticated",user("a_admin"),"select id,password from reveal_user_passwords() order by id");
    const map=Object.fromEntries((seen.rows||[]).map(r=>[r.id,r.password]));
    eq([map.a_w1,map.a_w2,map.b_admin],["Mgr-1","Mine-2",undefined],"an admin sees the passwords in their company, and only there");
    const mgr=await as("authenticated",user("a_mgr"),"select id from reveal_user_passwords() order by id");
    eq((mgr.rows||[]).map(r=>r.id),["a_mgr","a_old","a_w1"],"a department manager sees their own department");
    const wk=await as("authenticated",user("a_w1"),"select id from reveal_user_passwords()");
    eq((wk.rows||[]).length,0,"a worker sees none");
    const an=await anon("select * from reveal_user_passwords()");
    ok(/permission denied/.test(an.error||""),"the anon key cannot even call it");
  }

  // The service functions are out of reach of the public key and of users.
  {
    const a=await anon("select svc_login('admin','admin123')");
    ok(/permission denied/.test(a.error||""),"anon cannot call svc_login");
    const u=await as("authenticated",user("a_admin"),"select svc_login('admin','admin123')");
    ok(/permission denied/.test(u.error||""),"nor can a signed-in user");
    const d=await as("authenticated",user("a_admin"),"select private.pw_decrypt(pw_enc) from private.user_secrets");
    ok(/permission denied/.test(d.error||""),"nobody reads the encrypted passwords table");
    const k=await as("authenticated",user("a_admin"),"select private.pw_key()");
    ok(/permission denied/.test(k.error||""),"nor the key");
  }

  // Sign-up.
  {
    const r=(await svc("select svc_register('Acme בע\"מ','Ruth','ruth','Pw-123456') as r")).rows[0].r;
    ok(r.ok&&r.user.role==="admin","svc_register creates a company and its admin");
    const sub=(await q("select plan,status from subscriptions where company_id=$1",[r.user.company_id])).rows[0];
    eq([sub.plan,sub.status],["free","trial"],"…on a trial plan");
    eq((await svc("select svc_login('ruth','Pw-123456') as r")).rows[0].r.ok,true,"…who can sign in");
    const dup=(await svc("select svc_register('Other','X','ruth','Pw-123456') as r")).rows[0].r;
    eq(dup.error,"username_taken","a taken username is refused");
  }

  console.log("\n── phase 1: Priority ⇄ Engini ─────────────────────────────");
  let key;
  {
    const w=await as("authenticated",user("a_w1"),"select erp_create_key()");
    ok(/admins only/.test(w.error||""),"only an admin can create the Engini key");
    key=(await as("authenticated",user("a_admin"),"select erp_create_key() as k")).rows[0].k;
    ok(/^ov_[0-9a-f]{64}$/.test(key),"an admin gets a key, shown once");
    const auth=(await svc("select svc_erp_auth($1) as r",[key])).rows[0].r;
    eq(auth&&auth.company_id,A,"the key identifies its company");
    eq((await svc("select svc_erp_auth('ov_wrong') as r")).rows[0].r,null,"a wrong key identifies nobody");
    const stored=(await q("select key_hash from erp_connections where company_id=$1",[A])).rows[0].key_hash;
    ok(stored===sha(key)&&!stored.includes(key),"only the key's hash is stored");
    eq((await svc("select svc_erp_lock($1,'h1',60) as l",[A])).rows[0].l,true,"a batch takes the company's lock");
    eq((await svc("select svc_erp_lock($1,'h2',60) as l",[A])).rows[0].l,false,"a second batch at the same time is turned away");
    await svc("select svc_erp_unlock($1,'h1')",[A]);
    eq((await svc("select svc_erp_lock($1,'h2',60) as l",[A])).rows[0].l,true,"and gets it once the first lets go");
    await svc("select svc_erp_unlock($1,'h2')",[A]);
  }

  // Sign-offs → outbox.
  const outbox=async()=>(await q("select id,event_type,status,work_log_id,payload,reverses_id from erp_outbox order by id")).rows;
  {
    await anon(`insert into work_logs(id,user_id,user_name,serial_id,serial_sn,stage_id,order_id,start_time,end_time,completed,duration_min,company_id)
                values ('wl0','a_w1','דנה','oA1s1','SN1','s1','oA1',now()-interval '30 min',now(),true,25,$1)`,[A]);
    eq((await outbox()).length,0,"while two-way is off, a sign-off queues nothing");
    await as("authenticated",user("a_admin"),"select erp_update_settings(true,null,null)");
    await anon(`insert into work_logs(id,user_id,user_name,serial_id,serial_sn,stage_id,order_id,start_time,completed,company_id)
                values ('wl1','a_w1','דנה','oA1s2','SN2','s1','oA1',now()-interval '40 min',false,$1)`,[A]);
    eq((await outbox()).length,0,"starting work is not a sign-off");
    await anon("update work_logs set completed=true,end_time=now(),duration_min=32,total_pause_min=8 where id='wl1'");
    let ev=await outbox();
    eq(ev.map(e=>[e.event_type,e.status]),[["sign","unmapped"]],"signing off queues one event — held until Priority's operation for the stage is known");
    eq([ev[0].payload.wo_number,ev[0].payload.serial_number,ev[0].payload.quantity,Number(ev[0].payload.duration_min),Number(ev[0].payload.minutes_per_unit),ev[0].payload.stage_name],
       ["WO-100","SN2",1,32,32,"הרכבה מכנית"],"…carrying the פק\"ע, the unit, its net minutes and the stage");
    await anon(`insert into work_logs(id,user_id,user_name,stage_id,order_id,completed,company_id) values ('wlp','priority_import','ייבוא Priority','s1','oA1',true,$1)`,[A]);
    eq((await outbox()).length,1,"Priority's own progress records never go back to it");
    await anon(`insert into work_logs(id,user_id,user_name,stage_id,order_id,completed,company_id) values ('wlB','b_admin','B','sb','oB1',true,$1)`,[B]);
    eq((await outbox()).length,1,"another company's sign-offs are not queued for this one");

    const ap=(await svc("select svc_erp_apply($1,$2) as r",[A,JSON.stringify({order_ops:[
      {order_id:"oA1",stage_id:"s1",wo_number:"WO-100",op_code:"OP10",op_seq:10,op_name:"הרכבה",work_center:"WC1"}]})])).rows[0].r;
    eq(ap.requeued_sign_offs,1,"once a batch tells which operation that is, the held sign-off is released");
    ev=await outbox();
    eq([ev[0].status,ev[0].payload.operation.code],["pending","OP10"],"…with Priority's operation on it");

    const took=(await svc("select svc_erp_outbox_take($1,50) as r",[A])).rows[0].r;
    eq(took.map(e=>[Number(e.event_id),e.type]),[[Number(ev[0].id),"sign"]],"Engini takes it");
    eq((await svc("select svc_erp_outbox_take($1,50) as r",[A])).rows[0].r.length,0,"…and it is not handed out twice while in flight");
    const ack=(await svc("select svc_erp_outbox_ack($1,$2) as r",[A,JSON.stringify([{event_id:ev[0].id,ok:true,priority_ref:"REP-77"}])])).rows[0].r;
    eq(ack.acked,1,"Engini acknowledges it");

    await anon("update work_logs set completed=false,end_time=null where id='wl1'");
    ev=await outbox();
    const un=ev[ev.length-1];
    eq([un.event_type,un.status,Number(un.reverses_id),un.payload.priority_ref],["unsign","pending",Number(ev[0].id),"REP-77"],
       "re-opening a reported sign-off queues its reversal, naming what Priority recorded");
    await anon("update work_logs set completed=true,end_time=now(),duration_min=33 where id='wl1'");
    await anon("update work_logs set completed=false,end_time=null where id='wl1'");
    ev=await outbox();
    eq(ev.slice(-1).map(e=>[e.event_type,e.status]),[["sign","cancelled"]],"a sign-off taken back before it was delivered is simply cancelled");
    await anon("update work_logs set completed=true,end_time=now(),duration_min=34 where id='wl1'");
    const n0=(await outbox()).length;
    await anon("update work_logs set pause_log='[{\"x\":1}]' where id='wl1'");
    eq((await outbox()).length,n0,"touching a signed record without changing what was reported queues nothing");
    await anon("delete from work_logs where id='wl1'");
    ev=await outbox();
    eq(ev.slice(-1).map(e=>[e.event_type,e.status]),[["sign","cancelled"]],"deleting it before delivery cancels it too");

    // a group of units started together
    await anon(`insert into work_logs(id,user_id,user_name,serial_id,stage_id,order_id,bulk_group_id,completed,duration_min,company_id) values
       ('g1','a_w1','דנה','oA1s1','s2','oA1','G',false,0,$1),('g2','a_w1','דנה','oA1s2','s2','oA1','G',false,0,$1)`,[A]);
    await anon("update work_logs set completed=true,duration_min=40 where bulk_group_id='G'");
    ev=await outbox();
    eq(ev.slice(-2).map(e=>[e.payload.group_size,Number(e.payload.minutes_per_unit)]),[[2,20],[2,20]],
       "a group's time is split over its units");
    const st=(await as("authenticated",user("a_admin"),"select erp_status() as s")).rows[0].s;
    ok(st.connection&&st.connection.two_way===true&&!("key_hash" in st.connection),"erp_status shows the connection, never the key hash");
    const ws=await as("authenticated",user("a_mgr"),"select erp_status()");
    ok(/admins only/.test(ws.error||""),"…to admins only");
    const t2=await as("authenticated",user("a_admin"),"select * from erp_outbox");
    ok(/permission denied/.test(t2.error||""),"the tables themselves are closed to the app");
  }

  console.log("\n── phase 2: lockdown ──────────────────────────────────────");
  // An old client's last change before the switch is carried over.
  await anon("update app_users set password_hash=$1, password_plain='Last-1' where id='a_view'",[sha("Last-1")]);
  await pg.applyLockdown();
  {
    const cols=(await q("select column_name from information_schema.columns where table_name='app_users' and column_name like 'password%'")).rows.map(r=>r.column_name);
    eq(cols,["password_changed_at"],"no password is left in the public users table");
    eq((await svc("select svc_login('viewer','Last-1') as r")).rows[0].r.ok,true,"the last password the old client set still works");
    eq((await svc("select svc_login('oldtimer','Secret9!') as r")).rows[0].r.ok,true,"so does every other");
    const r=await as("authenticated",user("a_admin"),"select set_user_password('a_old','After-1')");
    ok(!r.error,"setting a password works without the old columns");
    eq((await svc("select svc_login('oldtimer','After-1') as r")).rows[0].r.ok,true,"…and takes effect");
  }
  {
    for(const t of ["app_users","orders","work_logs","companies","subscriptions","stages"]){
      const r=await anon(`select count(*) from ${t}`);
      ok(/permission denied/.test(r.error||""),`the anon key cannot read ${t}`);
    }
    const pf=await anon("select count(*) from plan_features");
    ok(!pf.error,"…only the public plan catalogue");
    const w=await anon("insert into orders(id,wo_number,company_id) values ('x','x',$1)",[A]);
    ok(/permission denied/.test(w.error||""),"nor write anything");
  }
  {
    const mine=await as("authenticated",user("a_w1"),"select id from orders order by id");
    eq(mine.rows.map(r=>r.id),["oA1"],"a signed-in user sees only their company's פק\"ע");
    const users=await as("authenticated",user("a_w1"),"select id from app_users order by id");
    ok(users.rows.every(r=>r.id.startsWith("a_")),"…and only their company's users");
    const upd=await as("authenticated",user("a_admin"),"update orders set status='blocked' where id='oB1'");
    eq(upd.count,0,"another company's rows cannot be changed — they are not even there");
    const ins=await as("authenticated",user("a_admin"),"insert into orders(id,wo_number,company_id) values ('oX','WO-X',$1)",[B]);
    ok(/row-level security/.test(ins.error||""),"nor written into another company");
    const mv=await as("authenticated",user("a_admin"),"update orders set company_id=$1 where id='oA1'",[B]);
    ok(/row-level security/.test(mv.error||""),"nor moved to one");
    const own=await as("authenticated",user("a_w1"),"update orders set status='partial' where id='oA1'");
    eq(own.count,1,"a worker still saves work in their own company");
    const wl=await as("authenticated",user("a_w1"),`insert into work_logs(id,user_id,user_name,stage_id,order_id,company_id) values ('wlx','a_w1','דנה','s1','oA1',$1)`,[A]);
    ok(!wl.error,"…and reports progress");
  }
  {
    const v=await as("authenticated",user("a_view"),"update orders set status='open' where id='oA1'");
    eq(v.count,0,"a viewer changes nothing");
    const va=await as("authenticated",user("a_view"),`insert into audit_log(id,action,company_id) values ('al1','התחברות',$1)`,[A]);
    ok(!va.error,"…but their login is still journaled");
    await q("update app_users set active=false where id='a_w2'");
    const gone=await as("authenticated",user("a_w2"),"select count(*)::int n from orders");
    eq(gone.rows[0].n,0,"a deactivated user's token sees nothing from the next request on");
    const none=await as("authenticated",{},"select count(*)::int n from orders");
    eq(none.rows[0].n,0,"a token with no app user sees nothing");
  }
  {
    const up=await as("authenticated",user("a_mgr"),"update app_users set role='admin' where id='a_w1'");
    ok(/row-level security/.test(up.error||""),"a department manager cannot make anyone an admin");
    const self=await as("authenticated",user("a_mgr"),"update app_users set role='admin' where id='a_mgr'");
    ok(/row-level security/.test(self.error||""),"…not even themselves");
    const other=await as("authenticated",user("a_mgr"),"update app_users set name='x' where id='a_w2'");
    eq(other.count,0,"…nor touch another department's people");
    const ownDept=await as("authenticated",user("a_mgr"),"update app_users set hourly_rate=70 where id='a_w1'");
    eq(ownDept.count,1,"…but does manage their own");
    const wk=await as("authenticated",user("a_w1"),"update app_users set role='admin' where id='a_w1'");
    eq(wk.count||0,0,"a worker cannot promote themselves");
    const adm=await as("authenticated",user("a_admin"),"update app_users set role='team_lead' where id='a_w1'");
    eq(adm.count,1,"an admin can change roles");
    const delSelf=await as("authenticated",user("a_admin"),"delete from app_users where id='a_admin'");
    eq(delSelf.count,0,"an admin cannot delete themselves");
    await q("update app_users set login_attempts=3, locked_until=now()+interval '5 min' where id='a_w1'");
    await as("authenticated",user("a_admin"),"update app_users set login_attempts=0, locked_until=null, name='Dana' where id='a_w1'");
    const lk=(await q("select name, login_attempts, locked_until is not null as locked from app_users where id='a_w1'")).rows[0];
    eq([lk.name,lk.login_attempts,lk.locked],["Dana",3,true],"saving a user from the app cannot reset a lockout");
    const comp=await as("authenticated",user("a_admin"),"select id from companies");
    eq(comp.rows.map(r=>r.id),[A],"a company admin sees their own company only");
    const cw=await as("authenticated",user("a_w1"),"update companies set name='x' where id=$1",[A]);
    eq(cw.count,0,"only an admin renames it");
    const ci=await as("authenticated",user("a_admin"),"insert into companies(name) values ('new')");
    ok(/row-level security/.test(ci.error||""),"nobody creates a company from the app — sign-up goes through the server");
    const si=await as("authenticated",user("a_admin"),"update subscriptions set plan='enterprise'");
    eq(si.count||0,0,"nor upgrades their own plan");
  }
  {
    const d1=await svc("insert into orders(id,wo_number,company_id) values ('oA2',' wo-100 ',$1)",[A]);
    ok(/orders_company_wo_unique/.test(d1.error||""),"the same מספר פק\"ע twice in one company is refused (case and spaces ignored)");
    const d2=await svc("insert into orders(id,wo_number,company_id) values ('oB2','WO-200',$1)",[B]);
    ok(!d2.error,"a different number, or the same number in another company, is fine");
  }
  {
    const tk=await svc("select svc_erp_outbox_take($1,50) as r",[A]);
    ok(!tk.error&&Array.isArray(tk.rows[0].r),"Engini's functions are unaffected by the lockdown");
  }

  await db.end();
  process.exit(done()?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
