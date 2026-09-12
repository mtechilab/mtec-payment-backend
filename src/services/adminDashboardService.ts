import { getSupabase } from "../db/supabaseClient.js";

export interface DashboardSummary {
  totalStudents: number;
  totalCourses: number;
  totalGrades: number;
  totalPaymentsCollected: number;
  pendingApplications: number;
  outstandingFees: number;
  gradeDistribution: Record<"A" | "B" | "C" | "D" | "E" | "F", number>;
  recentActivities: { type: string; message: string; timestamp: string }[];
  recentApplications: { applicationNumber: string; fullName: string; programme: string; status: string; date: string }[];
  recentPayments: { studentName: string; amount: number; method: string; status: string; date: string }[];
}

/** Simple placeholder grading scale (>=80 A ... <40 F) applied to raw
 *  `marks.score` values. There's no grading-scale table in the schema yet,
 *  so this is a stand-in — swap it out once MTeC's actual grade boundaries
 *  are defined, rather than treating these cutoffs as official. */
function scoreToGrade(score: number): "A" | "B" | "C" | "D" | "E" | "F" {
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  if (score >= 40) return "E";
  return "F";
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const supabase = getSupabase();

  const [
    studentsCount, coursesCount, marksResult, receiptsResult, recentStudents, recentReceipts, recentBatches,
    pendingApplicationsCount, unpaidPeriods, recentApplicationsResult, recentPaymentsResult,
  ] = await Promise.all([
    supabase.from("students").select("id", { count: "exact", head: true }),
    supabase.from("courses").select("id", { count: "exact", head: true }),
    supabase.from("marks").select("score"),
    supabase.from("receipts").select("amount"),
    supabase.from("students").select("full_name, student_id, created_at").order("created_at", { ascending: false }).limit(3),
    supabase.from("receipts").select("student_name, student_id_number, amount, date").order("date", { ascending: false }).limit(3),
    supabase.from("result_batches").select("class_id, published_at").not("published_at", "is", null).order("published_at", { ascending: false }).limit(3),
    supabase.from("applications").select("id", { count: "exact", head: true }).in("status", ["submitted", "under_review", "info_required"]),
    supabase.from("payment_periods").select("amount_due, amount_paid").neq("status", "paid"),
    supabase.from("applications").select("application_number, full_name, programme, status, created_at").order("created_at", { ascending: false }).limit(5),
    supabase.from("payment_submissions").select("amount, method, status, created_at, students(full_name)").order("created_at", { ascending: false }).limit(5),
  ]);

  const gradeDistribution: DashboardSummary["gradeDistribution"] = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
  for (const row of marksResult.data || []) {
    gradeDistribution[scoreToGrade(Number(row.score))]++;
  }

  const totalPaymentsCollected = (receiptsResult.data || []).reduce((sum, r) => sum + Number(r.amount), 0);

  const activities: DashboardSummary["recentActivities"] = [];
  for (const s of recentStudents.data || []) {
    activities.push({
      type: "student_registered",
      message: `New student registered: ${s.full_name} (${s.student_id})`,
      timestamp: s.created_at as string,
    });
  }
  for (const r of recentReceipts.data || []) {
    activities.push({
      type: "payment_received",
      message: `Payment received — NLe ${r.amount} · ${r.student_name} (${r.student_id_number})`,
      timestamp: r.date as string,
    });
  }
  for (const b of recentBatches.data || []) {
    activities.push({
      type: "results_published",
      message: `Results published for a class`,
      timestamp: b.published_at as string,
    });
  }
  activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const outstandingFees = (unpaidPeriods.data || [])
    .reduce((sum, p) => sum + (Number(p.amount_due) - Number(p.amount_paid)), 0);

  const recentApplications = (recentApplicationsResult.data || []).map((a: any) => ({
    applicationNumber: a.application_number,
    fullName: a.full_name,
    programme: a.programme,
    status: a.status,
    date: a.created_at,
  }));

  const recentPayments = (recentPaymentsResult.data || []).map((p: any) => ({
    studentName: p.students?.full_name || "Unknown",
    amount: p.amount,
    method: p.method,
    status: p.status,
    date: p.created_at,
  }));

  return {
    totalStudents: studentsCount.count || 0,
    totalCourses: coursesCount.count || 0,
    totalGrades: (marksResult.data || []).length,
    totalPaymentsCollected,
    pendingApplications: pendingApplicationsCount.count || 0,
    outstandingFees,
    gradeDistribution,
    recentActivities: activities.slice(0, 6),
    recentApplications,
    recentPayments,
  };
}
