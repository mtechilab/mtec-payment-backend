import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthenticatedRequest extends Request {
  studentRowId?: string;
}

function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Missing required env var JWT_SECRET — check your .env file.");
  return secret;
}

/** Issues a session token for a successfully-logged-in student. The token
 *  contains ONLY the student's row id — nothing else needs to be trusted
 *  from the client on any subsequent request. */
export function issueStudentToken(studentRowId: string): string {
  return jwt.sign({ sub: studentRowId, type: "student" }, requireJwtSecret(), { expiresIn: "30d" });
}

/** Every /payments/* route uses this. On success, req.studentRowId is set
 *  from the verified token — this is the ONLY source of "who is asking"
 *  anywhere in the payments routes. No route ever reads a studentId from
 *  the request body or query string. */
export function requireStudentAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header." });
  }
  const token = header.slice("Bearer ".length);

  try {
    const payload = jwt.verify(token, requireJwtSecret()) as jwt.JwtPayload;
    if (payload.type !== "student" || typeof payload.sub !== "string") {
      return res.status(401).json({ error: "Invalid token." });
    }
    req.studentRowId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session — please log in again." });
  }
}
