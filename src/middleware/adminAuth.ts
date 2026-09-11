import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AdminRequest extends Request {
  adminId?: string;
  adminUsername?: string;
  adminRole?: string;
}

function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Missing required env var JWT_SECRET — check your .env file.");
  return secret;
}

export function requireAdminAuth(req: AdminRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header." });
  }
  const token = header.slice("Bearer ".length);
  try {
    const payload = jwt.verify(token, requireJwtSecret()) as jwt.JwtPayload;
    if (payload.type !== "admin" || typeof payload.sub !== "string") {
      return res.status(401).json({ error: "Invalid token." });
    }
    req.adminId = payload.sub;
    req.adminUsername = payload.username as string;
    req.adminRole = payload.role as string;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session — please log in again." });
  }
}
