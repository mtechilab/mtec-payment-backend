import { Router } from "express";
import { studentLogin, completeFirstLogin } from "../services/authService.js";

const router = Router();

router.post("/student-login", async (req, res) => {
  const { studentId, credential } = req.body;
  if (!studentId || !credential) {
    return res.status(400).json({ error: "studentId and credential are required." });
  }

  const result = await studentLogin(studentId, credential);
  switch (result.outcome) {
    case "success":
      return res.json(result);
    case "first_login_required":
      return res.status(200).json({ outcome: "first_login_required" });
    case "invalid_credentials":
      return res.status(401).json({ error: "Incorrect Student ID or PIN/password." });
    case "not_found":
      return res.status(404).json({ error: "Student ID not recognized." });
  }
});

router.post("/student-first-login", async (req, res) => {
  const { studentId, newPassword } = req.body;
  if (!studentId || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "studentId and a password of at least 6 characters are required." });
  }
  const result = await completeFirstLogin(studentId, newPassword);
  if (result.outcome !== "success") {
    return res.status(404).json({ error: "Student ID not recognized." });
  }
  res.json(result);
});

export default router;
