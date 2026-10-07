// ════════════════════════════════════════════════════════════════════════════
// The auth Edge Function — how the app signs a user in.
// ════════════════════════════════════════════════════════════════════════════
//   POST /auth/login     {username, password}
//   POST /auth/register  {company_name, admin_name, username, password}
//
// The password is checked by svc_login inside the database (lockout included).
// Only then is a Supabase Auth session issued, for an Auth account whose
// password is a random secret the database keeps — never the user's password.
// The session's access token carries app_metadata.app_user_id, which is what
// every row-level policy keys on. Token refresh and sign-out go straight from
// the app to Supabase Auth; nothing here is involved.
//
// Plain web-standard JS: the Edge runtime serves it (index.ts) and
// tools/auth-test.js drives it under Node.
// ════════════════════════════════════════════════════════════════════════════

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-max-age": "86400",
};
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", ...CORS },
});

const MESSAGES = {
  bad_credentials: "שם משתמש או סיסמה שגויים",
  locked: "החשבון ננעל זמנית אחרי ניסיונות כושלים — נסה שוב בעוד כמה דקות",
  missing_fields: "יש למלא את כל השדות",
  too_long: "אחד השדות ארוך מדי",
  username_taken: "שם המשתמש תפוס",
  weak_password: "הסיסמה קצרה מדי (לפחות 8 תווים)",
};

async function sha8(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// The Auth account's address. Nobody types it and no mail is ever sent to it;
// .invalid is reserved (RFC 2606) and can never be delivered to.
export async function authEmail(appUserId, domain = "users.omniview.invalid") {
  const slug = String(appUserId).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40) || "user";
  return `u-${slug}-${await sha8(String(appUserId))}@${domain}`;
}

/**
 * @param rpc     (name, args) → result of a public.svc_* function, as the service role
 * @param gotrue  {createUser, updateUser, findUserIdByEmail, signIn} over Supabase Auth's admin API
 */
export function createHandler({ rpc, gotrue, emailDomain, log = console }) {
  async function session(user, auth) {
    const email = await authEmail(user.id, emailDomain);
    const meta = { app_user_id: user.id, company_id: user.company_id };
    let id = auth.auth_user_id;
    if (!id) {
      try {
        id = (await gotrue.createUser({ email, password: auth.secret, email_confirm: true, app_metadata: meta })).id;
      } catch (e) {
        // Created on an earlier attempt that died before it was recorded.
        if (e.status !== 422 && !/already|exists/i.test(e.message || "")) throw e;
        id = await gotrue.findUserIdByEmail(email);
        if (!id) throw e;
        await gotrue.updateUser(id, { password: auth.secret, app_metadata: meta });
      }
      await rpc("svc_link_auth_user", { p_user_id: user.id, p_auth_user_id: id });
    }
    let s = await gotrue.signIn(email, auth.secret);
    if (!s) {
      // The Auth account drifted (edited by hand, restored from a backup):
      // put the secret and the claims back, and try once more.
      await gotrue.updateUser(id, { email, password: auth.secret, app_metadata: meta });
      s = await gotrue.signIn(email, auth.secret);
    }
    if (!s) throw new Error("Supabase Auth refused the session");
    return {
      access_token: s.access_token, refresh_token: s.refresh_token, token_type: s.token_type || "bearer",
      expires_in: s.expires_in, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
    };
  }

  const refuse = (status, res) => json(status, {
    ok: false, error: res.error, message: MESSAGES[res.error] || "ההתחברות נכשלה",
    ...(res.attempts ? { attempts: res.attempts, max_attempts: res.max_attempts } : {}),
    ...(res.locked_until ? { locked_until: res.locked_until } : {}),
  });

  return async function handle(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const route = new URL(req.url).pathname.replace(/^.*?\/auth(?=\/|$)/, "") || "/";
    if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
    let body;
    try { body = await req.json(); } catch { return json(400, { ok: false, error: "bad_json" }); }
    try {
      if (route === "/login") {
        const res = await rpc("svc_login", { p_username: String(body?.username || ""), p_password: String(body?.password || "") });
        if (!res?.ok) return refuse(res?.error === "locked" ? 423 : 401, res || { error: "bad_credentials" });
        return json(200, { ok: true, user: res.user, session: await session(res.user, res.auth) });
      }
      if (route === "/register") {
        if (String(body?.password || "").length < 8) return refuse(400, { error: "weak_password" });
        const res = await rpc("svc_register", {
          p_company_name: String(body?.company_name || ""), p_admin_name: String(body?.admin_name || ""),
          p_username: String(body?.username || ""), p_password: String(body?.password || ""),
        });
        if (!res?.ok) return refuse(res?.error === "username_taken" ? 409 : 400, res || { error: "missing_fields" });
        return json(200, { ok: true, user: res.user, session: await session(res.user, res.auth) });
      }
      return json(404, { ok: false, error: "not_found" });
    } catch (e) {
      log.error?.("auth", e);
      return json(500, { ok: false, error: "server_error", message: "שגיאת שרת בהתחברות — נסה שוב בעוד רגע" });
    }
  };
}

// Supabase Auth's admin API over fetch. The token endpoint is rate limited per
// IP (bursts of 30, then one every two seconds), and every login comes from
// this function's address — so a shift signing in at once is waited out
// briefly instead of being turned away.
export function gotrueAdmin({ url, serviceKey, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const admin = { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" };
  const call = async (method, path, body, headers = admin) => {
    const r = await fetchImpl(`${url}/auth/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { msg: text }; }
    return { status: r.status, ok: r.ok, data };
  };
  const err = (r) => Object.assign(new Error(r.data?.msg || r.data?.message || r.data?.error_description || `HTTP ${r.status}`), { status: r.status });
  return {
    async createUser(u) { const r = await call("POST", "/admin/users", u); if (!r.ok) throw err(r); return r.data; },
    async updateUser(id, u) { const r = await call("PUT", `/admin/users/${id}`, u); if (!r.ok) throw err(r); return r.data; },
    async findUserIdByEmail(email) {
      for (let page = 1; page <= 50; page++) {
        const r = await call("GET", `/admin/users?page=${page}&per_page=1000`);
        if (!r.ok) throw err(r);
        const users = r.data?.users || [];
        const hit = users.find((x) => String(x.email || "").toLowerCase() === email.toLowerCase());
        if (hit) return hit.id;
        if (users.length < 1000) return null;
      }
      return null;
    },
    async signIn(email, password) {
      for (let attempt = 0; ; attempt++) {
        const r = await call("POST", "/token?grant_type=password", { email, password });
        if (r.ok) return r.data;
        if (r.status === 429 && attempt < 6) { await sleep(1500 * (attempt + 1)); continue; }
        if (r.status === 400 || r.status === 401) return null;
        throw err(r);
      }
    },
  };
}
