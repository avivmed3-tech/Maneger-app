// ════════════════════════════════════════════════════════════════════════════
// The erp Edge Function — the endpoint Engini talks to.
// ════════════════════════════════════════════════════════════════════════════
//   GET  /erp/health              is the key good, and which company is it
//   POST /erp/work-orders         Priority work-order operations → the app
//   GET  /erp/sign-offs?limit=N   the next stage sign-offs to report in Priority
//   POST /erp/sign-offs/ack       which of them Priority took
//
// Auth: the company's API key (created in the app, 🔌 Priority card) in
// `x-api-key`, or as `Authorization: Bearer ov_…`.
//
// Inbound batches run through the app's own Priority import (core.mjs, lifted
// verbatim from index.html) and are written by svc_erp_apply in a single
// transaction. Everything here is plain web-standard JS, so the same module
// runs in the Edge runtime and under Node in tools/erp-test.js.
// ════════════════════════════════════════════════════════════════════════════
import * as core from "./core.mjs";

const MAX_OPERATIONS = 5000;
const DEFAULT_OPTIONS = { onlyOpen: false, skipCancelled: true, makeStages: true, makeProjects: true,
  importStd: true, fillSerials: false, serialMax: 100, importProgress: true };

// Field names Engini sends → the Priority report's column headers, which is
// what priScan reads. The Hebrew headers themselves are accepted as well, so a
// row can be passed through exactly as the Excel report names it.
const OP_FIELDS = {
  wo: "wo", work_order: "wo", pn: "pn", part: "pn", description: "desc", branch: "branch", project: "project",
  qty: "qty", quantity: "qty", unit_price: "price", price: "price", release_date: "release",
  end_date: "endDate", production_end_date: "endDate", op_seq: "seq", seq: "seq", op_code: "op",
  op_name: "opDesc", operation: "opDesc", work_center: "wc", reported_qty: "reported", remaining_qty: "remain",
  std_min_per_unit_pn: "stdPn", std_min_per_unit_wo: "stdWo", status: "status",
};
const SN_FIELDS = { wo: "wo", work_order: "wo", pn: "pn", sn: "sn", serial: "sn", serial_number: "sn" };

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8" },
});
const fail = (status, error, extra) => json(status, { ok: false, error, ...(extra || {}) });

function toPriorityRow(o) {
  const row = core.xlRow(o && typeof o === "object" ? o : {});
  for (const [k, v] of Object.entries(o || {})) {
    const f = OP_FIELDS[k];
    if (f && v !== undefined && v !== null) row[core.xlNorm(core.PRI_H[f])] = v;
  }
  // A status note travels under any of the report's spellings; Engini's name for it is status_note.
  if (o && o.status_note != null) row[core.xlNorm(core.PRI_NOTE_H[0])] = o.status_note;
  return row;
}
function toSerialRow(o) {
  const row = core.xlRow(o && typeof o === "object" ? o : {});
  for (const [k, v] of Object.entries(o || {})) {
    const f = SN_FIELDS[k];
    if (f && v !== undefined && v !== null) row[core.xlNorm(core.PRI_S[f])] = v;
  }
  return row;
}

// The units an operation says are done: the reported count, or — where
// Priority left it blank — ordered minus remaining. priBuild's own rule.
const opDone = (w, op) => Math.floor(op.reported > 0 ? op.reported
  : ((w.qty > 0 && op.remain > 0 && op.remain < w.qty) ? w.qty - op.remain : 0));

export function createHandler({ rpc, log = console }) {
  async function authenticate(req) {
    const h = req.headers;
    let key = h.get("x-api-key") || "";
    const bearer = (h.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!key && bearer.startsWith("ov_")) key = bearer;
    if (!key) return null;
    return await rpc("svc_erp_auth", { p_key: key.trim() });
  }

  async function inbound(conn, body) {
    const ops = Array.isArray(body?.operations) ? body.operations : Array.isArray(body?.rows) ? body.rows : null;
    if (!ops || !ops.length) return fail(400, "operations: an array of work-order operation rows is required");
    if (ops.length > MAX_OPERATIONS) return fail(413, `at most ${MAX_OPERATIONS} operations per request — split the batch by work order`);
    const serials = Array.isArray(body?.serials) ? body.serials : [];

    const scan = core.priScan(ops.map(toPriorityRow), serials.map(toSerialRow));
    if (!scan.wos.length) return fail(400, "no row carried a work-order number (wo)");
    const cid = conn.company_id;
    const holder = crypto.randomUUID();
    if (!(await rpc("svc_erp_lock", { p_company: cid, p_holder: holder, p_seconds: 120 }))) {
      return fail(409, "busy: another batch for this company is being written — retry in a few seconds", { retry_after: 5 });
    }
    try {
      const withCid = (x) => ({ ...x, companyId: cid });
      const st = await rpc("svc_erp_load", {
        p_company: cid,
        p_wo_keys: scan.wos.map((w) => core.woKey(w.wo)),
        p_pns: [...new Set(scan.wos.map((w) => String(w.pn || "").trim()).filter(Boolean))],
      });
      const stages = (st.stages || []).map(core.dbToStage).map(withCid);
      const projects = (st.projects || []).map(core.dbToProject).map(withCid);
      const pnStandards = (st.pn_standards || []).map(core.dbToPnStd).map(withCid);
      const existing = (st.orders || []).map(core.dbToOrder).map(withCid);
      const erpLogs = (st.erp_logs || []).map(core.dbToLog).map(withCid);
      const opts = { ...DEFAULT_OPTIONS, ...(conn.options || {}) };
      const twoWay = !!conn.two_way;
      const map = core.priAutoMap(scan.ops, stages, conn.stage_map || {});

      // Two-way: the app now reports its own sign-offs to Priority, so
      // Priority's counts include them. Progress is then worked out here (see
      // twoWayProgress) instead of by priBuild, which would credit those units
      // a second time.
      const built = core.priBuild(scan, { projects, stages, pnStandards }, map,
        twoWay ? { ...opts, importProgress: false } : opts);
      const plan = core.priMergePlan(built, existing, twoWay ? [] : erpLogs);

      const byWo = new Map(existing.map((o) => [core.woKey(o.woNumber), o]));
      const updatedById = new Map(plan.updated.map((o) => [o.id, o]));
      const finalOrder = new Map(); // woKey → the order as it stands after this batch
      for (const o of existing) finalOrder.set(core.woKey(o.woNumber), updatedById.get(o.id) || o);
      for (const o of plan.added) finalOrder.set(core.woKey(o.woNumber), o);

      let logs = plan.logs, dropLogIds = plan.dropLogIds, progressChanged = plan.progressChanged;
      if (twoWay && opts.importProgress !== false) {
        ({ logs, dropLogIds, progressChanged } = twoWayProgress({ scan, built, finalOrder, erpLogs, st }));
      }
      // A record dropped and rewritten under the same id is an update, not a
      // delete and an insert — one realtime event on the floor instead of two.
      const rewritten = new Set(logs.map((x) => x.id));
      dropLogIds = dropLogIds.filter((id) => !rewritten.has(id));

      // The Priority operation behind each stage of each order — what a
      // sign-off on that stage is reported against.
      const orderOps = [];
      for (const w of scan.wos) {
        const o = finalOrder.get(core.woKey(w.wo));
        if (!o) continue;
        const seen = new Set();
        for (const op of w.ops.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0))) {
          const sid = built.opStage[op.key];
          if (!sid || seen.has(sid)) continue;
          seen.add(sid);
          orderOps.push({ order_id: o.id, stage_id: sid, wo_number: o.woNumber, op_code: op.code || null,
            op_seq: op.seq || null, op_name: op.name || null, work_center: op.wc || null });
        }
      }
      const stageMap = {};
      for (const op of scan.ops) {
        if (map[op.key] === core.PRI_SKIP) stageMap[op.key] = core.PRI_SKIP;
        else if (built.opStage[op.key]) stageMap[op.key] = built.opStage[op.key];
      }

      const ERP_KEYS = ["id", "wo_number", "pn", "description", "qty", "unit_price", "project_id", "branch",
        "received_date", "target_date", "stage_ids", "status", "erp_status", "erp_note"];
      const prevById = new Map(existing.map((o) => [o.id, o]));
      const updatedRows = plan.updated.map((o) => {
        const r = core.orderToDb(withCid(o));
        const out = Object.fromEntries(ERP_KEYS.map((k) => [k, r[k]]));
        if (o.serials !== prevById.get(o.id)?.serials) out.serials = r.serials;
        return out;
      });
      const summary = {
        unchanged: plan.unchanged, cancelled: plan.cancelled || 0, new_serials: plan.newSerials || 0,
        progress_changed: progressChanged, new_stages: built.newStages.length, new_projects: built.newProjects.length,
        standards: built.stds.length, skipped: { closed: built.stats?.closedSkipped || 0, coc: built.stats?.cocSkipped || 0,
          cancelled: built.stats?.cancelledSkipped || 0, no_branch: built.stats?.noBranchSkipped || 0 },
      };
      const res = await rpc("svc_erp_apply", {
        p_company: cid,
        p: {
          batch_ref: body.batch_ref ? String(body.batch_ref).slice(0, 200) : null,
          rows_count: ops.length, wos_count: scan.wos.length, summary,
          new_stages: built.newStages.map(withCid).map(core.stageToDb),
          new_projects: built.newProjects.map(withCid).map(core.projectToDb),
          added_orders: plan.added.map(withCid).map(core.orderToDb),
          updated_orders: updatedRows,
          drop_log_ids: dropLogIds,
          logs: logs.map(withCid).map(core.logToDb),
          stds: built.stds.map(withCid).map(core.pnStdToDb),
          order_ops: orderOps,
          stage_map: stageMap,
        },
      });
      return json(200, {
        ok: true, ...res, ...summary,
        changes: plan.changes.slice(0, 100),
        issues: (built.issues || []).slice(0, 100),
      });
    } finally {
      await rpc("svc_erp_unlock", { p_company: cid, p_holder: holder }).catch((e) => log.warn?.("unlock", e));
    }
  }

  return async function handle(req) {
    const url = new URL(req.url);
    const route = url.pathname.replace(/^.*?\/erp(?=\/|$)/, "") || "/";
    try {
      const conn = await authenticate(req);
      if (!conn) return fail(401, "missing or invalid API key (x-api-key)");

      if (req.method === "GET" && (route === "/" || route === "/health")) {
        return json(200, { ok: true, company_id: conn.company_id, two_way: !!conn.two_way });
      }
      if (req.method === "POST" && route === "/work-orders") {
        let body;
        try { body = await req.json(); } catch { return fail(400, "body is not valid JSON"); }
        return await inbound(conn, body);
      }
      if (req.method === "GET" && route === "/sign-offs") {
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100));
        const events = await rpc("svc_erp_outbox_take", { p_company: conn.company_id, p_limit: limit, p_lease_seconds: 600 });
        return json(200, { ok: true, two_way: !!conn.two_way, events });
      }
      if (req.method === "POST" && route === "/sign-offs/ack") {
        let body;
        try { body = await req.json(); } catch { return fail(400, "body is not valid JSON"); }
        const acks = Array.isArray(body?.acks) ? body.acks : Array.isArray(body) ? body : null;
        if (!acks) return fail(400, "acks: an array of {event_id, ok, error?, priority_ref?, retry?} is required");
        const res = await rpc("svc_erp_outbox_ack", { p_company: conn.company_id, p_acks: acks });
        return json(200, { ok: true, ...res });
      }
      return fail(404, `no route ${req.method} ${route}`);
    } catch (e) {
      log.error?.("erp", e);
      return fail(500, String(e?.message || e).slice(0, 500));
    }
  };
}

// ── Progress when the app reports back to Priority ────────────────────────
// Priority's reported count for an operation is now the app's sign-offs that
// reached it plus whatever was reported in Priority directly. Only the second
// part becomes the import's stand-in records, and it is placed on units nobody
// signed in the app — so no unit is ever counted twice. A work order Priority
// has closed has, by definition, finished every stage.
function twoWayProgress({ scan, built, finalOrder, erpLogs, st }) {
  const key = (o, s) => `${o}|${s}`;
  const acked = new Map((st.acked || []).map((a) => [key(a.order_id, a.stage_id), Number(a.units) || 0]));
  const appDone = new Map((st.app_done || []).map((d) => [key(d.order_id, d.stage_id),
    { serials: new Set(d.serial_ids || []), qty: Number(d.qty) || 0 }]));
  const erpByOrder = new Map();
  for (const w of erpLogs) { const a = erpByOrder.get(w.orderId); a ? a.push(w) : erpByOrder.set(w.orderId, [w]); }

  const logs = [], dropLogIds = [];
  let progressChanged = 0;
  // Only what priBuild let in — a פק"ע it skipped (COC, no branch, cancelled)
  // keeps whatever it had, exactly as on the one-way path.
  const builtWos = new Set(built.orders.map((o) => core.woKey(o.woNumber)));
  for (const w of scan.wos) {
    const o = builtWos.has(core.woKey(w.wo)) && finalOrder.get(core.woKey(w.wo));
    if (!o) continue;
    const serials = o.serials || [];
    const cap = serials.length || (Number(o.qty) || 0);
    const target = new Map();
    if (cap) {
      const s = core.priStatus(w.statusRaw);
      const closed = s.st === "complete" && s.phase !== "cancelled";
      const stagesOf = closed ? (o.stageIds || []) : [];
      for (const sid of stagesOf) target.set(sid, cap);
      if (!closed) for (const op of w.ops) {
        const sid = built.opStage[op.key];
        if (!sid) continue;
        const n = Math.max(0, opDone(w, op) - (acked.get(key(o.id, sid)) || 0));
        if (n > 0) target.set(sid, Math.max(target.get(sid) || 0, n));
      }
      for (const [sid, n] of target) {
        const d = appDone.get(key(o.id, sid));
        const room = Math.max(0, cap - (d ? d.serials.size + d.qty : 0));
        const v = Math.min(n, room);
        if (v > 0) target.set(sid, v); else target.delete(sid);
      }
    }
    const prev = erpByOrder.get(o.id) || [];
    if (core.progSig(target) === core.progSig(core.progPerStage(prev))) continue;
    progressChanged++;
    dropLogIds.push(...prev.map((x) => x.id));
    const stamp = core.priStamp(w.release);
    let k = 0;
    for (const [sid, n] of target) {
      const base = { userId: core.PRI_LOG_USER, userName: core.PRI_LOG_NAME, stageId: sid, orderId: o.id,
        startTime: stamp, endTime: stamp, completed: true, durationMin: 0, paused: false, pauseStart: null,
        totalPauseMin: 0, pauseLog: [], bulkGroupId: null };
      if (!serials.length) {
        logs.push({ ...base, id: `${o.id}q${k++}`, serialId: null, serialSn: null, bulk: true, bulkCount: n });
        continue;
      }
      const done = appDone.get(key(o.id, sid))?.serials || new Set();
      for (const sr of serials.filter((s) => !done.has(s.id)).slice(0, n)) {
        logs.push({ ...base, id: `${o.id}p${k++}`, serialId: sr.id, serialSn: sr.sn, bulk: false, bulkCount: null });
      }
    }
  }
  return { logs, dropLogIds, progressChanged };
}
