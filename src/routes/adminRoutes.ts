import { Router, Request, Response } from "express";
import { loginAdmin, setupFirstAdmin } from "../services/adminAuthService.js";
import { getDashboardSummary } from "../services/adminDashboardService.js";
import { listApplications, getApplication, approveApplication, rejectApplication } from "../services/adminApplicationsService.js";
import { requireAdminAuth, AdminRequest } from "../middleware/adminAuth.js";

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

// Everything below here requires a valid admin session.
router.use(requireAdminAuth);

router.get("/dashboard", async (_req: AdminRequest, res: Response) => {
  try {
    const summary = await getDashboardSummary();
    res.json(summary);
  } catch (err) {
    console.error("[/admin/dashboard] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load dashboard." });
  }
});

// GET /admin/applications?status=submitted
router.get("/applications", async (req: AdminRequest, res: Response) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const applications = await listApplications(status);
    res.json({ applications });
  } catch (err) {
    console.error("[/admin/applications] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load applications." });
  }
});

// GET /admin/applications/:id
router.get("/applications/:id", async (req: AdminRequest, res: Response) => {
  try {
    const application = await getApplication(req.params.id);
    if (!application) return res.status(404).json({ error: "Application not found." });
    res.json(application);
  } catch (err) {
    console.error("[/admin/applications/:id] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load application." });
  }
});

// POST /admin/applications/:id/approve
router.post("/applications/:id/approve", async (req: AdminRequest, res: Response) => {
  try {
    const result = await approveApplication(req.params.id);
    if (result.outcome === "not_found") return res.status(404).json({ error: "Application not found." });
    if (result.outcome === "already_processed") {
      return res.status(409).json({ error: `Application is already ${result.status}.` });
    }
    res.json({ success: true, studentId: result.studentId, pin: result.pin });
  } catch (err) {
    console.error("[/admin/applications/:id/approve] error:", (err as Error).message);
    res.status(500).json({ error: "Could not approve application." });
  }
});

// POST /admin/applications/:id/reject — { reason }
router.post("/applications/:id/reject", async (req: AdminRequest, res: Response) => {
  try {
    const { reason } = req.body as { reason?: string };
    if (!reason) return res.status(400).json({ error: "reason is required." });
    await rejectApplication(req.params.id, reason);
    res.json({ success: true });
  } catch (err) {
    console.error("[/admin/applications/:id/reject] error:", (err as Error).message);
    res.status(500).json({ error: "Could not reject application." });
  }
});

export default router;
