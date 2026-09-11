import { Request, Response, NextFunction } from "express";

/**
 * Bare-minimum staff gate for the cash-approval stopgap. A single shared
 * secret via header, not a real per-staff-member login — that's the known
 * limitation here: this can't tell WHICH staff member approved something,
 * only that someone with the key did. Fine as a stopgap until there's an
 * actual staff_accounts table + real auth (see the database-unification
 * plan — this whole endpoint should move to that shared auth once it
 * exists, the same way the old admissions backend's requireStaffAuth did
 * for its own project).
 */
export function requireStaffAuth(req: Request, res: Response, next: NextFunction) {
  const key = process.env.STAFF_API_KEY;
  if (!key) {
    console.error("[staffAuth] STAFF_API_KEY not set — refusing all staff requests until configured.");
    return res.status(500).json({ error: "Staff access is not configured on this server." });
  }
  const provided = req.headers["x-staff-token"];
  if (provided !== key) {
    return res.status(401).json({ error: "Invalid or missing staff token." });
  }
  next();
}
