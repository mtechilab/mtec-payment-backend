import { Router, Request, Response } from "express";
import { requireStaffAuth } from "../middleware/staffAuth.js";
import {
  getPendingCashSubmissions,
  finalizeVerifiedPayment,
  rejectSubmission,
} from "../services/paymentPlanService.js";

const router = Router();
router.use(requireStaffAuth);

// GET /staff/cash-submissions — everything currently awaiting approval.
router.get("/cash-submissions", async (_req: Request, res: Response) => {
  try {
    const submissions = await getPendingCashSubmissions();
    res.json({ submissions });
  } catch (err) {
    console.error("[/staff/cash-submissions] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load pending submissions." });
  }
});

// POST /staff/cash-submissions/:id/approve — { staffName }
// Reuses the exact same finalizeVerifiedPayment the Monime webhook uses,
// so the payment plan / dashboard update the same way regardless of method.
router.post("/cash-submissions/:id/approve", async (req: Request, res: Response) => {
  try {
    const { staffName } = req.body as { staffName?: string };
    if (!staffName) return res.status(400).json({ error: "staffName is required." });
    const result = await finalizeVerifiedPayment(req.params.id, `Cash (confirmed by ${staffName})`);
    res.json({ success: true, alreadyProcessed: (result as any)?.alreadyProcessed === true });
  } catch (err) {
    console.error("[/staff/cash-submissions/approve] error:", (err as Error).message);
    res.status(500).json({ error: "Could not approve payment." });
  }
});

// POST /staff/cash-submissions/:id/reject — { reason }
router.post("/cash-submissions/:id/reject", async (req: Request, res: Response) => {
  try {
    const { reason } = req.body as { reason?: string };
    if (!reason) return res.status(400).json({ error: "reason is required." });
    await rejectSubmission(req.params.id, reason);
    res.json({ success: true });
  } catch (err) {
    console.error("[/staff/cash-submissions/reject] error:", (err as Error).message);
    res.status(500).json({ error: "Could not reject payment." });
  }
});

export default router;
