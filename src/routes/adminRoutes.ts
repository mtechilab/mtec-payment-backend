import { Router, Request, Response } from "express";
import { loginAdmin, setupFirstAdmin } from "../services/adminAuthService.js";
import { getDashboardSummary, getRecentActivities } from "../services/adminDashboardService.js";
import { requireAdminAuth, AdminRequest } from "../middleware/adminAuth.js";
import {
  listApplications, getApplication, approveApplication, rejectApplication,
  listStudents, getStudentDetail,
  listTransactions, listPendingPayments, verifyPendingPayment, rejectPendingPayment,
  addCourse, listCourses,
  addStaff, listStaff,
  createClass, listClasses, listClassStudents, createAssessmentItem, listAssessmentItems, saveMarks, getMarks,
} from "../services/adminOpsService.js";

const router = Router();

// POST /admin/setup — { username, password, fullName }
// Only works while admin_accounts is empty. This is how the very first
// admin account gets created; it refuses once one already exists.
router.post("/setup", async (req: Request, res: Response) => {
  const { username, password, fullName } = req.body as { username?: string; password?: string; fullName?: string };
  if (!username || !password || !fullName) {
    return res.status(400).json({ error: "username, password, and fullName are all required." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  const result = await setupFirstAdmin(username, password, fullName);
  if (!result.success) return res.status(403).json({ error: result.reason });
  res.json({ success: true });
});

// POST /admin/login — { username, password }
router.post("/login", async (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) return res.status(400).json({ error: "username and password are required." });

  const result = await loginAdmin(username, password);
  if (result.outcome === "no_admin_configured") {
    return res.status(409).json({ error: "no_admin_configured", message: "No admin account exists yet — use /admin/setup first." });
  }
  if (result.outcome === "invalid_credentials") {
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  res.json({ token: result.token, fullName: result.fullName, role: result.role });
});

// GET /admin/dashboard — protected
router.get("/dashboard", requireAdminAuth, async (_req: AdminRequest, res: Response) => {
  try {
    const summary = await getDashboardSummary();
    res.json(summary);
  } catch (err) {
    console.error("[/admin/dashboard] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load dashboard." });
  }
});

// ==========================================================================
// Applications — "Register Student" quick action
// Approving is what creates the student account (generates Student ID + PIN).
// ==========================================================================

// GET /admin/applications — everything past draft, most recent first
router.get("/applications", requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const applications = await listApplications();
    res.json({ applications });
  } catch (err) {
    console.error("[/admin/applications GET] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load applications." });
  }
});

// GET /admin/applications/:id
router.get("/applications/:id", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const application = await getApplication(req.params.id);
    res.json(application);
  } catch (err) {
    console.error("[/admin/applications/:id GET] error:", (err as Error).message);
    res.status(404).json({ error: (err as Error).message || "Application not found." });
  }
});

// POST /admin/applications/:id/approve — creates the student, returns { studentId, pin }
router.post("/applications/:id/approve", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const result = await approveApplication(req.params.id);
    res.json(result);
  } catch (err) {
    console.error("[/admin/applications/:id/approve] error:", (err as Error).message);
    res.status(400).json({ error: (err as Error).message || "Could not approve application." });
  }
});

// POST /admin/applications/:id/reject — { reason }
router.post("/applications/:id/reject", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body as { reason?: string };
    if (!reason) return res.status(400).json({ error: "reason is required." });
    await rejectApplication(req.params.id, reason);
    res.json({ success: true });
  } catch (err) {
    console.error("[/admin/applications/:id/reject] error:", (err as Error).message);
    res.status(400).json({ error: (err as Error).message || "Could not reject application." });
  }
});

// ==========================================================================
// Students
// ==========================================================================

// GET /admin/students?q=&limit=
router.get("/students", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const students = await listStudents(q, limit);
    res.json({ students });
  } catch (err) {
    console.error("[/admin/students GET] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load students." });
  }
});

// GET /admin/students/:id
router.get("/students/:id", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const student = await getStudentDetail(req.params.id);
    res.json(student);
  } catch (err) {
    console.error("[/admin/students/:id GET] error:", (err as Error).message);
    res.status(404).json({ error: (err as Error).message || "Student not found." });
  }
});

// ==========================================================================
// Payments — Verification + Transactions tabs
// ==========================================================================

// GET /admin/transactions?limit= — full payment_submissions history, any status
router.get("/transactions", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const transactions = await listTransactions(limit);
    res.json({ transactions });
  } catch (err) {
    console.error("[/admin/transactions] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load transactions." });
  }
});

// GET /admin/payments/pending — cash deposits awaiting verification
router.get("/payments/pending", requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const submissions = await listPendingPayments();
    res.json({ submissions });
  } catch (err) {
    console.error("[/admin/payments/pending] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load pending payments." });
  }
});

// POST /admin/payments/:id/verify
router.post("/payments/:id/verify", requireAdminAuth, async (req: AdminRequest, res: Response) => {
  try {
    const result = await verifyPendingPayment(req.params.id, req.adminUsername || "admin");
    res.json({ success: true, alreadyProcessed: (result as any)?.alreadyProcessed === true });
  } catch (err) {
    console.error("[/admin/payments/:id/verify] error:", (err as Error).message);
    res.status(500).json({ error: "Could not verify payment." });
  }
});

// POST /admin/payments/:id/reject — { reason }
router.post("/payments/:id/reject", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { reason } = req.body as { reason?: string };
    if (!reason) return res.status(400).json({ error: "reason is required." });
    await rejectPendingPayment(req.params.id, reason);
    res.json({ success: true });
  } catch (err) {
    console.error("[/admin/payments/:id/reject] error:", (err as Error).message);
    res.status(500).json({ error: "Could not reject payment." });
  }
});

// ==========================================================================
// Courses — "Add Course" quick action
// ==========================================================================

// GET /admin/courses?limit=
router.get("/courses", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const courses = await listCourses(limit);
    res.json({ courses });
  } catch (err) {
    console.error("[/admin/courses GET] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load courses." });
  }
});

// POST /admin/courses — { code, name, programme, level, semester, creditUnits }
router.post("/courses", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { code, name, programme, level, semester, creditUnits } = req.body as {
      code?: string; name?: string; programme?: string; level?: string; semester?: string; creditUnits?: number;
    };
    if (!code || !name || !programme || !level || !semester) {
      return res.status(400).json({ error: "code, name, programme, level, and semester are all required." });
    }
    const course = await addCourse({ code, name, programme, level, semester, creditUnits: Number(creditUnits) || 3 });
    res.json({ success: true, course });
  } catch (err) {
    console.error("[/admin/courses POST] error:", (err as Error).message);
    res.status(500).json({ error: "Could not add course." });
  }
});

// ==========================================================================
// Staff — "Manage Staff" quick action
// ==========================================================================

// GET /admin/staff
router.get("/staff", requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const staff = await listStaff();
    res.json({ staff });
  } catch (err) {
    console.error("[/admin/staff GET] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load staff." });
  }
});

// POST /admin/staff — { username, password, fullName }
// Ongoing path for adding accounts once the very first one exists (see
// /admin/setup, which locks itself out after that). Every account created
// here gets full admin permissions — no role tiers yet.
router.post("/staff", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { username, password, fullName } = req.body as { username?: string; password?: string; fullName?: string };
    if (!username || !password || !fullName) {
      return res.status(400).json({ error: "username, password, and fullName are all required." });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    const staff = await addStaff({ username, password, fullName });
    res.json({ success: true, staff });
  } catch (err) {
    console.error("[/admin/staff POST] error:", (err as Error).message);
    res.status(400).json({ error: (err as Error).message || "Could not add staff account." });
  }
});

// ==========================================================================
// Grades — "Enter Grades" quick action
// Chain: Class (course + enrolled students) -> Assessment Item -> Marks.
// ==========================================================================

// GET /admin/classes
router.get("/classes", requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const classes = await listClasses();
    res.json({ classes });
  } catch (err) {
    console.error("[/admin/classes GET] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load classes." });
  }
});

// POST /admin/classes — { courseCode, instructorName, academicYear, studentIds: string[] }
router.post("/classes", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { courseCode, instructorName, academicYear, studentIds } = req.body as {
      courseCode?: string; instructorName?: string; academicYear?: string; studentIds?: string[];
    };
    if (!courseCode || !instructorName || !academicYear) {
      return res.status(400).json({ error: "courseCode, instructorName, and academicYear are all required." });
    }
    const cls = await createClass({
      courseCode, instructorName, academicYear, studentIds: Array.isArray(studentIds) ? studentIds : [],
    });
    res.json({ success: true, class: cls });
  } catch (err) {
    console.error("[/admin/classes POST] error:", (err as Error).message);
    res.status(400).json({ error: (err as Error).message || "Could not create class." });
  }
});

// GET /admin/classes/:id/students
router.get("/classes/:id/students", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const students = await listClassStudents(req.params.id);
    res.json({ students });
  } catch (err) {
    console.error("[/admin/classes/:id/students] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load class roster." });
  }
});

// GET /admin/classes/:id/assessment-items
router.get("/classes/:id/assessment-items", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const items = await listAssessmentItems(req.params.id);
    res.json({ items });
  } catch (err) {
    console.error("[/admin/classes/:id/assessment-items GET] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load assessment items." });
  }
});

// POST /admin/classes/:id/assessment-items — { name, maxScore, weight }
router.post("/classes/:id/assessment-items", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { name, maxScore, weight } = req.body as { name?: string; maxScore?: number; weight?: number };
    if (!name || !maxScore || !weight) {
      return res.status(400).json({ error: "name, maxScore, and weight are all required." });
    }
    const item = await createAssessmentItem({ classId: req.params.id, name, maxScore: Number(maxScore), weight: Number(weight) });
    res.json({ success: true, item });
  } catch (err) {
    console.error("[/admin/classes/:id/assessment-items POST] error:", (err as Error).message);
    res.status(400).json({ error: (err as Error).message || "Could not create assessment item." });
  }
});

// GET /admin/marks?assessmentItemId=
router.get("/marks", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const assessmentItemId = req.query.assessmentItemId as string;
    if (!assessmentItemId) return res.status(400).json({ error: "assessmentItemId is required." });
    const marks = await getMarks(assessmentItemId);
    res.json({ marks });
  } catch (err) {
    console.error("[/admin/marks GET] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load marks." });
  }
});

// POST /admin/marks — { assessmentItemId, classId, scores: [{ studentRowId, score }] }
router.post("/marks", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { assessmentItemId, classId, scores } = req.body as {
      assessmentItemId?: string; classId?: string; scores?: { studentRowId: string; score: number }[];
    };
    if (!assessmentItemId || !classId || !Array.isArray(scores) || scores.length === 0) {
      return res.status(400).json({ error: "assessmentItemId, classId, and a non-empty scores array are required." });
    }
    const result = await saveMarks({ assessmentItemId, classId, scores });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[/admin/marks POST] error:", (err as Error).message);
    res.status(500).json({ error: "Could not save marks." });
  }
});

// GET /admin/notifications?limit= — fuller activity feed than the dashboard's 6-item summary
router.get("/notifications", requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const activities = await getRecentActivities(limit);
    res.json({ activities });
  } catch (err) {
    console.error("[/admin/notifications] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load notifications." });
  }
});

export default router;
