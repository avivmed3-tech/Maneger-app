// Edge entry for the erp function — the logic is in handler.mjs, the Priority
// import it runs in core.mjs (generated from index.html).
// Deployed with verify_jwt = false: Engini authenticates with the company's
// API key, which the handler checks on every request.
import { createHandler } from "./handler.mjs";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function rpc(name: string, args: Record<string, unknown>) {
  const r = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${name}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

Deno.serve(createHandler({ rpc }));
