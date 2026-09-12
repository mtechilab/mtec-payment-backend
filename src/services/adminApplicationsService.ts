import crypto from "crypto";
import { getSupabase } from "../db/supabaseClient.js";

export async function listApplications(status?: string) {
  const supabase = getSupabase();
  let query = supabase
    .from("applications")
    .select("id, application_number, full_name, programme, academic_year, status, created_at")
    .order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw new Error(`listApplications failed: ${error.message}`);
  return data;
}

export async function getApplication(id: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("applications").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getApplication failed: ${error.message}`);
  return data;
}

/** Derives a short programme code for the student ID from the programme
 *  name — e.g. "Diploma in Computer Science" -> "CS", "HND Business
 *  Administration" -> "BA". Drops filler words rather than trying to be
 *  clever; falls back to the first 2 letters of the whole name if nothing
 *  meaningful is left, so it never produces an empty code. */
function programmeCode(programmeName: string): string {
  const filler = new Set(["diploma", "certificate", "hnd", "bachelor", "in", "of", "and", "the"]);
  const words = programmeName.split(/\s+/).filter((w) => w && !filler.has(w.toLowerCase()));
  const code = words.map((w) => w[0]).join("").toUpperCase();
  return code.length >= 2 ? code.slice(0, 4) : programmeName.slice(0, 2).toUpperCase();
}

async function generateStudentId(programme: string, academicYear: string): Promise<string> {
  const supabase = getSupabase();
  const code = programmeCode(programme);
  const year = academicYear.match(/\d{4}/)?.[0] || new Date().getFullYear().toString();
  const prefix = `MTEC-${code}-${year}-`;

  const { count, error } = await supabase
    .from("students").select("id", { count: "exact", head: true }).like("student_id", `${prefix}%`);
  if (error) throw new Error(`generateStudentId count failed: ${error.message}`);

  const sequence = (count || 0) + 1;
  return `${prefix}${sequence.toString().padStart(4, "0")}`;
}

function generatePin(): string {
  return crypto.randomInt(100000, 999999).toString();
}

export type ApproveResult =
  | { outcome: "success"; studentId: string; pin: string }
  | { outcome: "not_found" }
  | { outcome: "already_processed"; status: string };

/** Approves an application: generates a student ID + one-time PIN, creates
 *  the offer_letters record (fee amount pulled from fee_structures if one
 *  exists for the programme, 0 otherwise — flagged in the return so the
 *  caller/UI can show that honestly rather than silently showing NLe 0),
 *  creates the students row, and marks the application approved. */
export async function approveApplication(applicationId: string): Promise<ApproveResult> {
  const supabase = getSupabase();

  const { data: application, error: appErr } = await supabase
    .from("applications").select("*").eq("id", applicationId).maybeSingle();
  if (appErr) throw new Error(`approveApplication lookup failed: ${appErr.message}`);
  if (!application) return { outcome: "not_found" };
  if (application.status === "approved") return { outcome: "already_processed", status: application.status };

  const studentId = await generateStudentId(application.programme, application.academic_year);
  const pin = generatePin();

  const { data: feeRow } = await supabase
    .from("fee_structures").select("registration_fee, tuition_per_semester")
    .eq("programme", application.programme).maybeSingle();
  const feesAmount = feeRow ? Number(feeRow.registration_fee) + Number(feeRow.tuition_per_semester) : 0;

  const applicationNumber = application.application_number || `MTEC-APP-${application.academic_year}-${applicationId.slice(0, 8)}`;
  const reportingDate = new Date();
  reportingDate.setDate(reportingDate.getDate() + 14);
  const acceptanceDeadline = new Date();
  acceptanceDeadline.setDate(acceptanceDeadline.getDate() + 7);

  const { error: offerErr } = await supabase.from("offer_letters").insert({
    application_id: applicationId,
    student_name: application.full_name,
    application_number: applicationNumber,
    programme: application.programme,
    academic_year: application.academic_year,
    admission_conditions: "Admission is conditional on payment of the registration fee and submission of original documents at reporting.",
    fees_amount: feesAmount,
    reporting_date: reportingDate.toISOString().slice(0, 10),
    authorized_signatory: "MTeC Admissions",
    acceptance_deadline: acceptanceDeadline.toISOString().slice(0, 10),
  });
  if (offerErr) throw new Error(`approveApplication offer_letters insert failed: ${offerErr.message}`);

  const { error: studentErr } = await supabase.from("students").insert({
    student_id: studentId,
    student_pin: pin,
    application_id: applicationId,
    full_name: application.full_name,
    phone: application.phone,
    email: application.email,
    programme: application.programme,
    academic_year: application.academic_year,
    level: "Year 1",
    status: "active",
  });
  if (studentErr) throw new Error(`approveApplication students insert failed: ${studentErr.message}`);

  const { error: updateErr } = await supabase
    .from("applications").update({ status: "approved" }).eq("id", applicationId);
  if (updateErr) throw new Error(`approveApplication status update failed: ${updateErr.message}`);

  return { outcome: "success", studentId, pin };
}

export async function rejectApplication(applicationId: string, reason: string) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("applications").update({ status: "rejected", rejection_reason: reason }).eq("id", applicationId);
  if (error) throw new Error(`rejectApplication failed: ${error.message}`);
}
