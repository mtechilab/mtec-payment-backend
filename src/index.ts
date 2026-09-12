import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import authRoutes from "./routes/authRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";
import staffRoutes from "./routes/staffRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import studentRoutes from "./routes/studentRoutes.js";
import studentInfoRoutes from "./routes/studentInfoRoutes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Webhook route needs raw body — registered before express.json() so it
// alone gets the unparsed buffer; every other route gets normal JSON.
app.use("/api/payments", webhookRoutes);

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Staff-Token");
  res.header("Access-Control-Allow-Methods", "GET, POST");
  next();
});

app.use("/auth", authRoutes);
app.use("/payments", paymentRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/student", studentRoutes);
app.use("/api/student", studentInfoRoutes);

// Bare-minimum cash-approval page — visit https://<this-host>/staff on any
// phone/browser. No login of its own; it just asks for the staff key and
// sends it as X-Staff-Token on every request. Stopgap only — see the
// database-unification plan for where this belongs long-term.
app.get("/staff", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "staff.html"));
});

// Admin Dashboard — real login (admin_accounts + JWT), real data (students/
// courses/marks/receipts tables), no mock numbers. First run: POST to
// /api/admin/setup once (see migrations/002_admin_accounts.sql) to create
// the first account, since nobody can log in to create one otherwise.
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`MTeC Payment Backend listening on port ${port}`);
  console.log(`Webhook endpoint: /api/payments/webhook`);
  console.log(`Staff cash-approval page: /staff`);
});
