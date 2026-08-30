import { Router } from "express";
import { studentLogin, completeFirstLogin } from "../services/authService.js";
const router = Router();
router.post("/student-login", async (req, res) => {
    try {
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
    }
    catch (err) {
        // Never let a thrown error (e.g. a missing env var, a Supabase outage)
        // become an unhandled rejection — that crashes the entire Node process
        // for every user, not just this one request. This is what actually
        // happened on Render: one bad login request took the whole backend down.
        console.error("[/auth/student-login] error:", err.message);
        res.status(500).json({ error: "Something went wrong. Please try again." });
    }
});
router.post("/student-first-login", async (req, res) => {
    try {
        const { studentId, newPassword } = req.body;
        if (!studentId || !newPassword || newPassword.length < 6) {
            return res.status(400).json({ error: "studentId and a password of at least 6 characters are required." });
        }
        const result = await completeFirstLogin(studentId, newPassword);
        if (result.outcome !== "success") {
            return res.status(404).json({ error: "Student ID not recognized." });
        }
        res.json(result);
    }
    catch (err) {
        console.error("[/auth/student-first-login] error:", err.message);
        res.status(500).json({ error: "Something went wrong. Please try again." });
    }
});
export default router;
