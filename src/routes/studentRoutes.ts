import { Router, Response } from "express";
import { AuthenticatedRequest, requireStudentAuth } from "../middleware/auth.js";
import { getSupabase } from "../db/supabaseClient.js";

const router = Router();
router.use(requireStudentAuth);

// GET /student/profile — the student's own row, nothing else.
router.get("/profile", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("students")
      .select("student_id, full_name, phone, email, programme, academic_year, level, status")
      .eq("id", req.studentRowId!)
      .maybeSingle();
    if (error || !data) return res.status(404).json({ error: "Student not found." });
    res.json(data);
  } catch (err) {
    console.error("[/student/profile] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load profile." });
  }
});

// GET /student/courses — classes this student is enrolled in this term,
// joined to the course they belong to. `classes.student_ids` is a uuid[]
// column, so membership is checked with .contains() rather than a join table.
router.get("/courses", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data: classesRaw, error } = await supabase
      .from("classes")
      .select("id, instructor_name, academic_year, courses(code, name, credit_units, semester)")
      .contains("student_ids", [req.studentRowId!]);
    if (error) throw error;
    const classes = (classesRaw || []) as unknown as {
      instructor_name: string;
      courses: { code: string; name: string; credit_units: number; semester: string } | null;
    }[];
    const flattened = classes.map((c) => ({
      courseCode: c.courses?.code,
      courseName: c.courses?.name,
      creditUnits: c.courses?.credit_units,
      semester: c.courses?.semester,
      instructorName: c.instructor_name,
    }));
    res.json(flattened);
  } catch (err) {
    console.error("[/student/courses] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load courses." });
  }
});

// GET /student/timetable — every slot across this student's enrolled classes.
router.get("/timetable", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data: classesRaw, error: classErr } = await supabase
      .from("classes").select("id, instructor_name, courses(code, name)").contains("student_ids", [req.studentRowId!]);
    if (classErr) throw classErr;
    const classes = (classesRaw || []) as unknown as {
      id: string; instructor_name: string; courses: { code: string; name: string } | null;
    }[];
    const classById = new Map(classes.map((c) => [c.id, c]));
    const classIds = classes.map((c) => c.id);
    if (classIds.length === 0) return res.json([]);

    const { data: slotsRaw, error: slotErr } = await supabase
      .from("timetable_slots")
      .select("class_id, day_of_week, start_time, end_time, room")
      .in("class_id", classIds);
    if (slotErr) throw slotErr;
    const slots = (slotsRaw || []) as unknown as {
      class_id: string; day_of_week: string; start_time: string; end_time: string; room: string;
    }[];

    const dayOrder: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const flattened = slots
      .map((s) => {
        const cls = classById.get(s.class_id);
        return {
          courseCode: cls?.courses?.code,
          courseName: cls?.courses?.name,
          instructorName: cls?.instructor_name,
          dayOfWeek: s.day_of_week,
          startTime: s.start_time,
          endTime: s.end_time,
          room: s.room,
        };
      })
      .sort((a, b) => (dayOrder[a.dayOfWeek] - dayOrder[b.dayOfWeek]) || a.startTime.localeCompare(b.startTime));

    res.json(flattened);
  } catch (err) {
    console.error("[/student/timetable] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load timetable." });
  }
});

// GET /student/attendance — this student's own attendance records, most recent first.
router.get("/attendance", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("attendance_records")
      .select("date, mark, classes(courses(code, name))")
      .eq("student_row_id", req.studentRowId!)
      .order("date", { ascending: false })
      .limit(100);
    if (error) throw error;
    const records = (data || []) as unknown as {
      date: string; mark: string; classes: { courses: { code: string; name: string } | null } | null;
    }[];
    const flattened = records.map((r) => ({
      courseName: r.classes?.courses?.name,
      mark: r.mark,
      date: r.date,
    }));
    res.json(flattened);
  } catch (err) {
    console.error("[/student/attendance] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load attendance." });
  }
});

// GET /student/results — marks, but ONLY for classes whose result_batches
// row is "published". A student never sees a grade before it's officially
// released, even if the raw mark row already exists in the table.
router.get("/results", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data: published, error: pubErr } = await supabase
      .from("result_batches").select("class_id").eq("status", "published");
    if (pubErr) throw pubErr;
    const publishedClassIds = (published || []).map((r) => r.class_id);
    if (publishedClassIds.length === 0) return res.json([]);

    const { data, error } = await supabase
      .from("marks")
      .select("score, class_id, classes(courses(code, name)), assessment_items(name, max_score, weight)")
      .eq("student_row_id", req.studentRowId!)
      .in("class_id", publishedClassIds);
    if (error) throw error;
    const marks = (data || []) as unknown as {
      score: number;
      classes: { courses: { code: string; name: string } | null } | null;
      assessment_items: { name: string; max_score: number; weight: number } | null;
    }[];
    const flattened = marks.map((m) => ({
      courseName: m.classes?.courses?.name,
      assessmentName: m.assessment_items?.name,
      score: m.score,
      maxScore: m.assessment_items?.max_score,
    }));
    res.json(flattened);
  } catch (err) {
    console.error("[/student/results] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load results." });
  }
});

// GET /student/receipts — confirmed payments only (a receipt is proof of a
// verified payment — distinct from payment_submissions, which may still be
// pending/under review).
router.get("/receipts", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("receipts")
      .select("receipt_number, amount, method, date, received_by, previous_balance, new_balance")
      .eq("student_row_id", req.studentRowId!)
      .order("date", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("[/student/receipts] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load receipts." });
  }
});

// GET /student/letters — offer letter (via applications) + acceptance
// letter (direct student_row_id link), whichever exist.
router.get("/letters", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    const { data: student, error: studentErr } = await supabase
      .from("students").select("application_id").eq("id", req.studentRowId!).maybeSingle();
    if (studentErr) throw studentErr;
    if (!student) return res.json([]);

    const { data: offerLetter, error: offerErr } = await supabase
      .from("offer_letters")
      .select("programme, academic_year, fees_amount, reporting_date")
      .eq("application_id", student.application_id)
      .maybeSingle();
    if (offerErr) throw offerErr;
    if (!offerLetter) return res.json([]);

    res.json([{
      programme: offerLetter.programme,
      academicYear: offerLetter.academic_year,
      feesAmount: offerLetter.fees_amount,
      reportingDate: offerLetter.reporting_date,
    }]);
  } catch (err) {
    console.error("[/student/letters] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load letters." });
  }
});

export default router;
