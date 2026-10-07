// Edge entry for the auth function — the logic is in handler.mjs.
// Deployed with verify_jwt = false: a user who is signing in has no token yet.
import { createHandler, gotrueAdmin } from "./handler.mjs";

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

Deno.serve(createHandler({ rpc, gotrue: gotrueAdmin({ url, serviceKey }) }));
