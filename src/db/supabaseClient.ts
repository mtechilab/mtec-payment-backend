import { createClient } from "@supabase/supabase-js";
import { Database } from "./types.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} — check your .env file.`);
  return value;
}

let cachedClient: ReturnType<typeof createClient<Database>> | null = null;

/** Lazily created so a missing env var only throws when actually used,
 *  not at import time (matters for tests and for clear startup behavior). */
export function getSupabase() {
  if (!cachedClient) {
    const url = requireEnv("SUPABASE_URL");
    const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    cachedClient = createClient<Database>(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return cachedClient;
}
