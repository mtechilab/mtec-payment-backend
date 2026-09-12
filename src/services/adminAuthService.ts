import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getSupabase } from "../db/supabaseClient.js";

function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Missing required env var JWT_SECRET — check your .env file.");
  return secret;
}

export function issueAdminToken(adminId: string, username: string, role: string): string {
  return jwt.sign({ sub: adminId, username, role, type: "admin" }, requireJwtSecret(), { expiresIn: "12h" });
}

export type AdminLoginResult =
  | { outcome: "success"; token: string; fullName: string; role: string }
  | { outcome: "invalid_credentials" }
  | { outcome: "no_admin_configured" };

export async function loginAdmin(username: string, password: string): Promise<AdminLoginResult> {
  const supabase = getSupabase();
  const { count } = await supabase.from("admin_accounts").select("id", { count: "exact", head: true });
  if (!count) return { outcome: "no_admin_configured" };

  const { data: admin, error } = await supabase
    .from("admin_accounts").select("*").eq("username", username).maybeSingle();
  if (error || !admin) return { outcome: "invalid_credentials" };

  const matches = await bcrypt.compare(password, admin.password_hash as string);
  if (!matches) return { outcome: "invalid_credentials" };

  const token = issueAdminToken(admin.id as string, admin.username as string, admin.role as string);
  return { outcome: "success", token, fullName: admin.full_name as string, role: admin.role as string };
}

/** One-time bootstrap — only works while admin_accounts is empty. This is
 *  how the very first admin account gets created, since nobody can log in
 *  to create one otherwise. Locks itself out permanently once one exists. */
export async function setupFirstAdmin(username: string, password: string, fullName: string) {
  const supabase = getSupabase();
  const { count } = await supabase.from("admin_accounts").select("id", { count: "exact", head: true });
  if (count && count > 0) {
    return { success: false as const, reason: "An admin account already exists — setup is locked." };
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const { error } = await supabase
    .from("admin_accounts")
    .insert({ username, password_hash: passwordHash, full_name: fullName, role: "administrator" });
  if (error) return { success: false as const, reason: error.message };
  return { success: true as const };
}
