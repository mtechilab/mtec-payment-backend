import { createClient } from "@supabase/supabase-js";
function requireEnv(name) {
    const value = process.env[name];
    if (!value)
        throw new Error(`Missing required env var ${name} — check your .env file.`);
    return value;
}
let cachedClient = null;
/** Lazily created so a missing env var only throws when actually used,
 *  not at import time (matters for tests and for clear startup behavior). */
export function getSupabase() {
    if (!cachedClient) {
        const url = requireEnv("SUPABASE_URL");
        const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
        cachedClient = createClient(url, serviceRoleKey, {
            auth: { autoRefreshToken: false, persistSession: false },
        });
    }
    return cachedClient;
}
