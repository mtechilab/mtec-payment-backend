import bcrypt from "bcryptjs";
import { getSupabase } from "../db/supabaseClient.js";
import { getPendingCashSubmissions, finalizeVerifiedPayment, rejectSubmission } from "./paymentPlanService.js";

/* ==========================================================================
 * Applications — "Register Student" quick action (real pipeline)
 * ==========================================================================
 * Supersedes an earlier direct-registration shortcut that faked its way
 * around the schema's required application_pins -> applications -> students
 * chain. The Android app now has a proper review screen, so this is the
 * real thing: an application already exists (submitted by an applicant
 * against a purchased/issued pin — that submission flow isn't built yet,
 * out of scope here), and approving it is what actually creates the
 * student account and generates their one-time login PIN.
 * ========================================================================== */

function randomDigits(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += Math.floor(Math.random() * 10);
  return out;
}

const DECIDABLE_STATUSES = ["submitted", "under_review"];

export async function listApplications() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("applications")
    .select("id, application_number, full_name, programme, academic_year, status, created_at")
    .neq("status", "draft")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listApplications failed: ${error.message}`);
  return data || [];
}

export async function getApplication(applicationId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("applications")
    .select("id, application_number, full_name, programme, academic_year, phone, email, intake, study_mode, status, rejection_reason")
    .eq("id", applicationId)
    .maybeSingle();
  if (error) throw new Error(`getApplication failed: ${error.message}`);
  if (!data) throw new Error("Application not found.");
  return data;
}

export async function approveApplication(applicationId: string) {
  const supabase = getSupabase();

  const { data: application, error: appError } = await supabase
    .from("applications")
    .select("id, status, full_name, phone, email, programme, academic_year")
    .eq("id", applicationId)
    .maybeSingle();
  if (appError) throw new Error(`approveApplication (lookup) failed: ${appError.message}`);
  if (!application) throw new Error("Application not found.");
  if (!DECIDABLE_STATUSES.includes(application.status)) {
    throw new Error(`This application is already ${application.status.replace("_", " ")} and can't be re-decided.`);
  }

  const year = application.academic_year || String(new Date().getFullYear());
  const { count: studentCount } = await supabase.from("students").select("id", { count: "exact", head: true });
  const seq = String((studentCount || 0) + 1).padStart(5, "0");
  const studentId = `MTEC-${year}-${seq}`;
  const pin = randomDigits(6);

  const { error: studentError } = await supabase.from("students").insert({
    student_id: studentId,
    student_pin: pin,
    application_id: application.id,
    full_name: application.full_name,
    phone: application.phone,
    email: application.email || "",
    programme: application.programme,
    academic_year: year,
    status: "active",
  });
  if (studentError) throw new Error(`approveApplication (student insert) failed: ${studentError.message}`);

  const { error: updateError } = await supabase
    .from("applications").update({ status: "approved" }).eq("id", applicationId);
  if (updateError) throw new Error(`approveApplication (status update) failed: ${updateError.message}`);

  return { studentId, pin };
}

export async function rejectApplication(applicationId: string, reason: string) {
  const supabase = getSupabase();

  const { data: application, error: appError } = await supabase
    .from("applications").select("status").eq("id", applicationId).maybeSingle();
  if (appError) throw new Error(`rejectApplication (lookup) failed: ${appError.message}`);
  if (!application) throw new Error("Application not found.");
  if (!DECIDABLE_STATUSES.includes(application.status)) {
    throw new Error(`This application is already ${application.status.replace("_", " ")} and can't be re-decided.`);
  }

  const { error } = await supabase
    .from("applications").update({ status: "rejected", rejection_reason: reason }).eq("id", applicationId);
  if (error) throw new Error(`rejectApplication failed: ${error.message}`);
  return { success: true };
}

/* ==========================================================================
 * Students — list/detail (row id included so the app can link into detail)
 * ========================================================================== */

export async function listStudents(search: string | undefined, limit: number) {
  const supabase = getSupabase();
  let query = supabase
    .from("students")
    .select("id, student_id, full_name, phone, programme, academic_year, level, status, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (search) {
    query = query.or(`full_name.ilike.%${search}%,student_id.ilike.%${search}%`);
  }
  const { data, error } = await query;
  if (error) throw new Error(`listStudents failed: ${error.message}`);
  return data || [];
}

export async function getStudentDetail(studentRowId: string) {
  const supabase = getSupabase();
  const { data: student, error: studentError } = await supabase
    .from("students")
    .select("id, student_id, full_name, phone, email, programme, academic_year, level, status")
    .eq("id", studentRowId)
    .maybeSingle();
  if (studentError) throw new Error(`getStudentDetail failed: ${studentError.message}`);
  if (!student) throw new Error("Student not found.");

  // Payment plan totals — omitted entirely (not just zeroed) when there's no
  // active plan, since the app distinguishes "no plan" from "plan with a
  // zero balance" by whether the totalFees key exists at all.
  let totalFees: number | undefined;
  let amountPaid: number | undefined;
  const { data: plan } = await supabase
    .from("payment_plans")
    .select("id, total_amount")
    .eq("student_row_id", studentRowId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (plan) {
    totalFees = Number(plan.total_amount);
    const { data: periods } = await supabase
      .from("payment_periods").select("amount_paid").eq("payment_plan_id", plan.id);
    amountPaid = (periods || []).reduce((sum, p) => sum + Number(p.amount_paid), 0);
  }

  // Enrolled classes — empty until the Academics phase (creating classes)
  // is built; the query itself is correct groundwork for that.
  const { data: classes } = await supabase
    .from("classes").select("courses(name)").contains("student_ids", [studentRowId]);
  const courses = (classes || []).map((c: any) => c.courses?.name).filter(Boolean);

  return {
    ...student,
    ...(totalFees !== undefined ? { totalFees, amountPaid } : {}),
    courses,
  };
}

/* ==========================================================================
 * Transactions — full payment_submissions history (any status), the same
 * table/shape the Payments-pending queue reads from. "Verifying" a pending
 * one (see adminRoutes.ts /payments/:id/verify -> finalizeVerifiedPayment)
 * is what turns it into a settled transaction here.
 * ========================================================================== */

export async function listTransactions(limit: number) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("payment_submissions")
    .select("id, mtec_reference, amount, method, status, provider_reference, created_at, students(student_id, full_name)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listTransactions failed: ${error.message}`);
  return data || [];
}

/** Pending cash submissions awaiting verification — same underlying
 *  table/queue the /staff cash-approval page uses; this just exposes it
 *  under normal admin JWT auth instead of the shared X-Staff-Token. */
export async function listPendingPayments() {
  return getPendingCashSubmissions();
}

export async function verifyPendingPayment(submissionId: string, verifiedByAdmin: string) {
  return finalizeVerifiedPayment(submissionId, `Cash (confirmed by ${verifiedByAdmin})`);
}

export async function rejectPendingPayment(submissionId: string, reason: string) {
  return rejectSubmission(submissionId, reason);
}

/* ==========================================================================
 * Courses — "Add Course" quick action
 * ========================================================================== */

export interface AddCourseInput {
  code: string;
  name: string;
  programme: string;
  level: string;
  semester: string;
  creditUnits: number;
}

export async function addCourse(input: AddCourseInput) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("courses")
    .insert({
      code: input.code,
      name: input.name,
      programme: input.programme,
      level: input.level,
      semester: input.semester,
      credit_units: input.creditUnits,
    })
    .select("id, code, name, programme, level, semester, credit_units")
    .single();
  if (error) throw new Error(`addCourse failed: ${error.message}`);
  return data;
}

/* ==========================================================================
 * Staff — "Manage Staff" quick action
 * ==========================================================================
 * POST /admin/setup only works once, ever (see adminAuthService) — this is
 * the ongoing path for an already-logged-in admin to add more accounts.
 * No role tiers yet: every account created here has full admin permissions,
 * same as the first one. Deactivation/removal isn't built yet either —
 * both are product decisions (can a staff-tier account approve payments but
 * not add courses? can admins remove each other?) worth a real answer
 * rather than a guess baked into the schema.
 * ========================================================================== */

export interface AddStaffInput {
  username: string;
  password: string;
  fullName: string;
}

export async function addStaff(input: AddStaffInput) {
  const supabase = getSupabase();
  const passwordHash = await bcrypt.hash(input.password, 10);
  const { data, error } = await supabase
    .from("admin_accounts")
    .insert({ username: input.username, password_hash: passwordHash, full_name: input.fullName, role: "administrator" })
    .select("id, username, full_name, role, created_at")
    .single();
  if (error) throw new Error(`addStaff failed: ${error.message}`);
  return data;
}

export async function listStaff() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("admin_accounts")
    .select("id, username, full_name, role, created_at")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listStaff failed: ${error.message}`);
  return data || [];
}

/* ==========================================================================
 * Grades — "Enter Grades" quick action
 * ==========================================================================
 * The real chain per schema.sql: a Class belongs to a Course and enrolls a
 * set of students; an Assessment Item belongs to a Class; a Mark is one
 * student's score on one Assessment Item. There's no shortcut around this —
 * a "grade" isn't meaningful without knowing which assessment it's for.
 * ========================================================================== */

export interface CreateClassInput {
  courseCode: string;
  instructorName: string;
  academicYear: string;
  studentIds: string[]; // human-readable student_id strings, e.g. MTEC-2026-00125
}

export async function createClass(input: CreateClassInput) {
  const supabase = getSupabase();

  const { data: course, error: courseError } = await supabase
    .from("courses").select("id, name").eq("code", input.courseCode).maybeSingle();
  if (courseError) throw new Error(`createClass (course lookup) failed: ${courseError.message}`);
  if (!course) throw new Error(`No course found with code ${input.courseCode}.`);

  let studentRowIds: string[] = [];
  if (input.studentIds.length > 0) {
    const { data: students, error: studentsError } = await supabase
      .from("students").select("id, student_id").in("student_id", input.studentIds);
    if (studentsError) throw new Error(`createClass (students lookup) failed: ${studentsError.message}`);
    const found = new Set((students || []).map((s) => s.student_id));
    const missing = input.studentIds.filter((id) => !found.has(id));
    if (missing.length > 0) throw new Error(`No student found with ID(s): ${missing.join(", ")}.`);
    studentRowIds = (students || []).map((s) => s.id as string);
  }

  const { data, error } = await supabase
    .from("classes")
    .insert({
      course_id: course.id,
      instructor_name: input.instructorName,
      academic_year: input.academicYear,
      student_ids: studentRowIds,
    })
    .select("id, course_id, instructor_name, academic_year, student_ids")
    .single();
  if (error) throw new Error(`createClass failed: ${error.message}`);
  return { ...data, courseName: course.name, courseCode: input.courseCode };
}

export async function listClasses() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("classes")
    .select("id, instructor_name, academic_year, student_ids, courses(code, name)");
  if (error) throw new Error(`listClasses failed: ${error.message}`);
  return (data || []).map((c: any) => ({
    id: c.id,
    instructorName: c.instructor_name,
    academicYear: c.academic_year,
    studentCount: (c.student_ids || []).length,
    courseCode: c.courses?.code || "",
    courseName: c.courses?.name || "",
  }));
}

export async function listClassStudents(classId: string) {
  const supabase = getSupabase();
  const { data: cls, error: classError } = await supabase
    .from("classes").select("student_ids").eq("id", classId).maybeSingle();
  if (classError) throw new Error(`listClassStudents (class lookup) failed: ${classError.message}`);
  if (!cls || !cls.student_ids || cls.student_ids.length === 0) return [];

  const { data, error } = await supabase
    .from("students").select("id, student_id, full_name").in("id", cls.student_ids as string[]);
  if (error) throw new Error(`listClassStudents failed: ${error.message}`);
  return (data || []).map((s) => ({ studentRowId: s.id, studentId: s.student_id, fullName: s.full_name }));
}

export interface CreateAssessmentItemInput {
  classId: string;
  name: string;
  maxScore: number;
  weight: number;
}

export async function createAssessmentItem(input: CreateAssessmentItemInput) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("assessment_items")
    .insert({ class_id: input.classId, name: input.name, max_score: input.maxScore, weight: input.weight })
    .select("id, class_id, name, max_score, weight")
    .single();
  if (error) throw new Error(`createAssessmentItem failed: ${error.message}`);
  return data;
}

export async function listAssessmentItems(classId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("assessment_items").select("id, name, max_score, weight").eq("class_id", classId);
  if (error) throw new Error(`listAssessmentItems failed: ${error.message}`);
  return data || [];
}

export interface SaveMarksInput {
  assessmentItemId: string;
  classId: string;
  scores: { studentRowId: string; score: number }[];
}

/** Upserts on the (assessment_item_id, student_row_id) unique constraint —
 *  re-submitting the same sheet corrects scores rather than duplicating them. */
export async function saveMarks(input: SaveMarksInput) {
  const supabase = getSupabase();
  const rows = input.scores.map((s) => ({
    assessment_item_id: input.assessmentItemId,
    class_id: input.classId,
    student_row_id: s.studentRowId,
    score: s.score,
  }));
  const { error } = await supabase
    .from("marks")
    .upsert(rows, { onConflict: "assessment_item_id,student_row_id" });
  if (error) throw new Error(`saveMarks failed: ${error.message}`);
  return { saved: rows.length };
}

export async function getMarks(assessmentItemId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("marks").select("student_row_id, score").eq("assessment_item_id", assessmentItemId);
  if (error) throw new Error(`getMarks failed: ${error.message}`);
  return data || [];
}

export async function listCourses(limit: number) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("courses")
    .select("id, code, name, programme, level, semester, credit_units")
    .order("code", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listCourses failed: ${error.message}`);
  return data || [];
}
