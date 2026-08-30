import bcrypt from "bcryptjs";
import { getSupabase } from "../db/supabaseClient.js";
import { issueStudentToken } from "../middleware/auth.js";

export type StudentLoginResult =
  | { outcome: "success"; authToken: string; studentName: string; studentPublicId: string; programmeName: string }
  | { outcome: "first_login_required" }
  | { outcome: "invalid_credentials" }
  | { outcome: "not_found" };

/** Mirrors the web app's studentLogin() in src/lib/db.ts — same PIN-then-
 *  password first-login pattern, same students table, just returning a
 *  signed session token instead of a browser-local flag. */
export async function studentLogin(studentId: string, credential: string): Promise<StudentLoginResult> {
  const supabase = getSupabase();
  const { data: student, error } = await supabase
    .from("students")
    .select("*")
    .eq("student_id", studentId.toUpperCase())
    .maybeSingle();
  if (error || !student) return { outcome: "not_found" };

  if (!student.first_login_complete) {
    if (credential !== student.student_pin) return { outcome: "invalid_credentials" };
    return { outcome: "first_login_required" };
  }

  const passwordMatches = student.password_hash && (await bcrypt.compare(credential, student.password_hash as string));
  if (!passwordMatches) return { outcome: "invalid_credentials" };

  return buildSuccessResult(student);
}

/** Completes first login by setting a real password (bcrypt-hashed
 *  server-side — the web app's client-side SHA-256 was flagged as
 *  demo-only; this backend does it properly). */
export async function completeFirstLogin(studentId: string, newPassword: string): Promise<StudentLoginResult> {
  const supabase = getSupabase();
  const { data: student, error } = await supabase
    .from("students")
    .select("*")
    .eq("student_id", studentId.toUpperCase())
    .maybeSingle();
  if (error || !student) return { outcome: "not_found" };

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const { data: updated, error: updateError } = await supabase
    .from("students")
    .update({ password_hash: passwordHash, first_login_complete: true })
    .eq("id", student.id)
    .select()
    .single();
  if (updateError || !updated) return { outcome: "not_found" };

  return buildSuccessResult(updated);
}

function buildSuccessResult(student: Record<string, unknown>): StudentLoginResult {
  return {
    outcome: "success",
    authToken: issueStudentToken(student.id as string),
    studentName: student.full_name as string,
    studentPublicId: student.student_id as string,
    programmeName: student.programme as string,
  };
}
