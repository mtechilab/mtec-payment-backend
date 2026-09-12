import { Router, Response } from "express";
import { requireStudentAuth, AuthenticatedRequest } from "../middleware/auth.js";
import {
  getReceipts,
  getProfile,
  getTimetable,
  getAttendance,
  getResults,
  getLetters,
} from "../services/studentInfoService.js";

const router = Router();
router.use(requireStudentAuth);

function handle(fn: (studentRowId: string) => Promise<unknown>, label: string) {
  return async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await fn(req.studentRowId as string);
      res.json(result);
    } catch (err) {
      console.error(`[/student/${label}] error:`, (err as Error).message);
      res.status(500).json({ error: `Could not load ${label}.` });
    }
  };
}

router.get("/receipts", handle(getReceipts, "receipts"));
router.get("/profile", handle(getProfile, "profile"));
router.get("/timetable", handle(getTimetable, "timetable"));
router.get("/attendance", handle(getAttendance, "attendance"));
router.get("/results", handle(getResults, "results"));
router.get("/letters", handle(getLetters, "letters"));

export default router;
