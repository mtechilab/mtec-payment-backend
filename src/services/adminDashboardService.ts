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
  /** Last 6 months, oldest first — feeds the Payment Collection Overview chart. */
  paymentCollectionSeries: { month: string; totalPayments: number; payingStudents: number }[];
  /**
   * Month-over-month growth, current calendar month vs previous. Only
   * populated where the schema actually has a timestamp to compare
   * (students.created_at, receipts.date) — courses and marks have no
   * created_at column yet, so those come back null rather than a made-up
   * number. The Android client hides the trend line when null.
   */
  growth: {
    studentsPct: number | null;
    coursesPct: number | null;
    paymentsPct: number | null;
    gradesPct: number | null;
  };
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

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Percentage change from `previous` to `current`, or null if there's
 *  nothing meaningful to compare against (avoids a misleading "∞%"
 *  or divide-by-zero when the previous period was empty). */
function monthOverMonthPct(current: number, previous: number): number | null {
  if (previous <= 0) return current > 0 ? null : 0;
  return Math.round(((current - previous) / previous) * 100);
}

/** Shared by the dashboard summary (6 items) and the dedicated Notifications
 *  screen (more). Pulls the same three activity sources and merges/sorts
 *  them — kept in one place so those two callers can't drift apart. */
export async function getRecentActivities(limit: number): Promise<DashboardSummary["recentActivities"]> {
  const supabase = getSupabase();
  const fetchLimit = Math.max(limit, 3);

  const [recentStudents, recentReceipts, recentBatches] = await Promise.all([
    supabase.from("students").select("full_name, student_id, created_at").order("created_at", { ascending: false }).limit(fetchLimit),
    supabase.from("receipts").select("student_name, student_id_number, amount, date").order("date", { ascending: false }).limit(fetchLimit),
    supabase.from("result_batches").select("class_id, published_at").not("published_at", "is", null).order("published_at", { ascending: false }).limit(fetchLimit),
  ]);

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
  return activities.slice(0, limit);
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const supabase = getSupabase();

  const now = new Date();
  const seriesMonthsBack = 6;
  const seriesStart = new Date(now.getFullYear(), now.getMonth() - (seriesMonthsBack - 1), 1);
  const growthWindowStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [
    studentsCount, coursesCount, marksResult, receiptsResult,
    pendingApplicationsCount, unpaidPeriods, recentApplicationsResult, recentPaymentsResult,
    seriesReceipts, growthStudents, activities,
  ] = await Promise.all([
    supabase.from("students").select("id", { count: "exact", head: true }),
    supabase.from("courses").select("id", { count: "exact", head: true }),
    supabase.from("marks").select("score"),
    supabase.from("receipts").select("amount"),
    supabase.from("applications").select("id", { count: "exact", head: true }).in("status", ["submitted", "under_review", "info_required"]),
    supabase.from("payment_periods").select("amount_due, amount_paid").neq("status", "paid"),
    supabase.from("applications").select("application_number, full_name, programme, status, created_at").order("created_at", { ascending: false }).limit(5),
    supabase.from("payment_submissions").select("amount, method, status, created_at, students(full_name)").order("created_at", { ascending: false }).limit(5),
    supabase.from("receipts").select("amount, date, student_row_id").gte("date", seriesStart.toISOString()),
    supabase.from("students").select("created_at").gte("created_at", growthWindowStart.toISOString()),
    getRecentActivities(6),
  ]);

  const gradeDistribution: DashboardSummary["gradeDistribution"] = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
  for (const row of marksResult.data || []) {
    gradeDistribution[scoreToGrade(Number(row.score))]++;
  }

  const totalPaymentsCollected = (receiptsResult.data || []).reduce((sum, r) => sum + Number(r.amount), 0);

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

  // ---- Payment Collection Overview: last 6 calendar months ----
  const monthBuckets: { key: string; label: string; totalPayments: number; payingStudents: Set<string> }[] = [];
  for (let i = seriesMonthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthBuckets.push({
      key: `${d.getFullYear()}-${d.getMonth()}`,
      label: MONTH_LABELS[d.getMonth()],
      totalPayments: 0,
      payingStudents: new Set<string>(),
    });
  }
  for (const r of seriesReceipts.data || []) {
    const d = new Date(r.date as string);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const bucket = monthBuckets.find((b) => b.key === key);
    if (!bucket) continue;
    bucket.totalPayments += Number(r.amount);
    if (r.student_row_id) bucket.payingStudents.add(r.student_row_id as string);
  }
  const paymentCollectionSeries = monthBuckets.map((b) => ({
    month: b.label,
    totalPayments: b.totalPayments,
    payingStudents: b.payingStudents.size,
  }));

  // ---- Month-over-month growth ----
  let studentsThisMonth = 0;
  let studentsLastMonth = 0;
  for (const s of growthStudents.data || []) {
    const d = new Date(s.created_at as string);
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) studentsThisMonth++;
    else studentsLastMonth++;
  }
  const thisMonthBucket = monthBuckets[monthBuckets.length - 1];
  const lastMonthBucket = monthBuckets[monthBuckets.length - 2];
  const paymentsPct = thisMonthBucket && lastMonthBucket
    ? monthOverMonthPct(thisMonthBucket.totalPayments, lastMonthBucket.totalPayments)
    : null;

  return {
    totalStudents: studentsCount.count || 0,
    totalCourses: coursesCount.count || 0,
    totalGrades: (marksResult.data || []).length,
    totalPaymentsCollected,
    pendingApplications: pendingApplicationsCount.count || 0,
    outstandingFees,
    gradeDistribution,
    recentActivities: activities,
    recentApplications,
    recentPayments,
    paymentCollectionSeries,
    growth: {
      studentsPct: monthOverMonthPct(studentsThisMonth, studentsLastMonth),
      coursesPct: null, // courses has no created_at column yet
      paymentsPct,
      gradesPct: null, // marks has no created_at column yet
    },
  };
}
