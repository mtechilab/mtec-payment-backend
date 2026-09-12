import { getSupabase } from "../db/supabaseClient.js";

export async function getReceipts(studentRowId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("receipts")
    .select("receipt_number, amount, method, date, received_by, previous_balance, new_balance")
    .eq("student_row_id", studentRowId)
    .order("date", { ascending: false });
  if (error) throw new Error(`getReceipts failed: ${error.message}`);
  return data;
}

export async function getProfile(studentRowId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("students")
    .select("student_id, full_name, phone, email, programme, academic_year, level, status")
    .eq("id", studentRowId)
    .maybeSingle();
  if (error) throw new Error(`getProfile failed: ${error.message}`);
  return data;
}

/** Classes this student is enrolled in — student_ids is a uuid[] column,
 *  so this uses Postgres array-contains rather than a join table. */
async function getEnrolledClasses(studentRowId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("classes")
    .select("id, course_id, instructor_name")
    .contains("student_ids", [studentRowId]);
  if (error) throw new Error(`getEnrolledClasses failed: ${error.message}`);
  return data || [];
}

async function getCourseNamesByIds(courseIds: string[]) {
  if (courseIds.length === 0) return new Map<string, { code: string; name: string }>();
  const supabase = getSupabase();
  const { data, error } = await supabase.from("courses").select("id, code, name").in("id", courseIds);
  if (error) throw new Error(`getCourseNamesByIds failed: ${error.message}`);
  const map = new Map<string, { code: string; name: string }>();
  for (const c of data || []) map.set(c.id, { code: c.code, name: c.name });
  return map;
}

export async function getTimetable(studentRowId: string) {
  const supabase = getSupabase();
  const classes = await getEnrolledClasses(studentRowId);
  if (classes.length === 0) return [];

  const classIds = classes.map((c) => c.id);
  const courseMap = await getCourseNamesByIds(classes.map((c) => c.course_id));

  const { data: slots, error } = await supabase
    .from("timetable_slots")
    .select("class_id, day_of_week, start_time, end_time, room")
    .in("class_id", classIds);
  if (error) throw new Error(`getTimetable failed: ${error.message}`);

  const classById = new Map(classes.map((c) => [c.id, c]));
  return (slots || []).map((slot) => {
    const cls = classById.get(slot.class_id);
    const course = cls ? courseMap.get(cls.course_id) : undefined;
    return {
      dayOfWeek: slot.day_of_week,
      startTime: slot.start_time,
      endTime: slot.end_time,
      room: slot.room,
      courseCode: course?.code || "",
      courseName: course?.name || "Unknown course",
      instructorName: cls?.instructor_name || "",
    };
  });
}

export async function getAttendance(studentRowId: string) {
  const supabase = getSupabase();
  const classes = await getEnrolledClasses(studentRowId);
  const courseMap = await getCourseNamesByIds(classes.map((c) => c.course_id));
  const classById = new Map(classes.map((c) => [c.id, c]));

  const { data, error } = await supabase
    .from("attendance_records")
    .select("class_id, date, mark")
    .eq("student_row_id", studentRowId)
    .order("date", { ascending: false });
  if (error) throw new Error(`getAttendance failed: ${error.message}`);

  return (data || []).map((rec) => {
    const cls = classById.get(rec.class_id);
    const course = cls ? courseMap.get(cls.course_id) : undefined;
    return { date: rec.date, mark: rec.mark, courseName: course?.name || "Unknown course" };
  });
}

/** Only returns marks for classes whose result_batches.status is
 *  'published' — draft/pending_review results are never shown to
 *  students, matching the intended review workflow. */
export async function getResults(studentRowId: string) {
  const supabase = getSupabase();
  const classes = await getEnrolledClasses(studentRowId);
  if (classes.length === 0) return [];

  const classIds = classes.map((c) => c.id);
  const courseMap = await getCourseNamesByIds(classes.map((c) => c.course_id));
  const classById = new Map(classes.map((c) => [c.id, c]));

  const { data: publishedBatches, error: batchError } = await supabase
    .from("result_batches")
    .select("class_id")
    .in("class_id", classIds)
    .eq("status", "published");
  if (batchError) throw new Error(`getResults (batches) failed: ${batchError.message}`);

  const publishedClassIds = (publishedBatches || []).map((b) => b.class_id);
  if (publishedClassIds.length === 0) return [];

  const { data: marks, error: marksError } = await supabase
    .from("marks")
    .select("class_id, assessment_item_id, score")
    .eq("student_row_id", studentRowId)
    .in("class_id", publishedClassIds);
  if (marksError) throw new Error(`getResults (marks) failed: ${marksError.message}`);

  const assessmentIds = (marks || []).map((m) => m.assessment_item_id);
  const { data: assessments, error: assessError } = assessmentIds.length
    ? await supabase.from("assessment_items").select("id, name, max_score").in("id", assessmentIds)
    : { data: [] as { id: string; name: string; max_score: number }[], error: null };
  if (assessError) throw new Error(`getResults (assessments) failed: ${assessError.message}`);
  const assessmentById = new Map((assessments || []).map((a) => [a.id, a]));

  return (marks || []).map((m) => {
    const cls = classById.get(m.class_id);
    const course = cls ? courseMap.get(cls.course_id) : undefined;
    const assessment = assessmentById.get(m.assessment_item_id);
    return {
      courseName: course?.name || "Unknown course",
      assessmentName: assessment?.name || "Assessment",
      score: m.score,
      maxScore: assessment?.max_score ?? null,
    };
  });
}

export async function getLetters(studentRowId: string) {
  const supabase = getSupabase();
  const { data: acceptance, error } = await supabase
    .from("acceptance_letters")
    .select("offer_letter_id, generated_at, student_id_number")
    .eq("student_row_id", studentRowId);
  if (error) throw new Error(`getLetters failed: ${error.message}`);
  if (!acceptance || acceptance.length === 0) return [];

  const offerIds = acceptance.map((a) => a.offer_letter_id);
  const { data: offers, error: offerError } = await supabase
    .from("offer_letters")
    .select("id, student_name, programme, academic_year, admission_conditions, fees_amount, reporting_date, authorized_signatory")
    .in("id", offerIds);
  if (offerError) throw new Error(`getLetters (offers) failed: ${offerError.message}`);
  const offerById = new Map((offers || []).map((o) => [o.id, o]));

  return acceptance.map((a) => {
    const offer = offerById.get(a.offer_letter_id);
    return {
      generatedAt: a.generated_at,
      studentName: offer?.student_name || "",
      programme: offer?.programme || "",
      academicYear: offer?.academic_year || "",
      admissionConditions: offer?.admission_conditions || "",
      feesAmount: offer?.fees_amount ?? 0,
      reportingDate: offer?.reporting_date || "",
      authorizedSignatory: offer?.authorized_signatory || "",
    };
  });
}
