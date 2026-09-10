import "dotenv/config";
<<<<<<< HEAD
<<<<<<< HEAD
=======
import path from "path";
import { fileURLToPath } from "url";
>>>>>>> 1c6ce85 (add adnin login)
=======
import path from "path";
import { fileURLToPath } from "url";
>>>>>>> f13cd76 (Merge remote main)
import express from "express";
import authRoutes from "./routes/authRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";
<<<<<<< HEAD
<<<<<<< HEAD

=======
=======
>>>>>>> f13cd76 (Merge remote main)
import staffRoutes from "./routes/staffRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
<<<<<<< HEAD
>>>>>>> 1c6ce85 (add adnin login)
=======
>>>>>>> f13cd76 (Merge remote main)
const app = express();

// Webhook route needs raw body — registered before express.json() so it
// alone gets the unparsed buffer; every other route gets normal JSON.
app.use("/api/payments", webhookRoutes);
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
//app.get('/health', (req, res) => res.status(200).send('OK'));
=======

>>>>>>> 36cdb6a (Initial commit)
=======

>>>>>>> 83cdb68 (add update)
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
=======
=======
>>>>>>> f13cd76 (Merge remote main)

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Staff-Token");
<<<<<<< HEAD
>>>>>>> 1c6ce85 (add adnin login)
=======
>>>>>>> f13cd76 (Merge remote main)
  res.header("Access-Control-Allow-Methods", "GET, POST");
  next();
});

app.use("/auth", authRoutes);
app.use("/payments", paymentRoutes);
<<<<<<< HEAD
<<<<<<< HEAD

<<<<<<< HEAD
<<<<<<< HEAD
app.get("/health", (req, res) => res.json({ status: "ok" }));
=======
app.get("/health", (_req, res) => res.json({ status: "ok" }));
>>>>>>> 36cdb6a (Initial commit)
=======
app.get("/health", (_req, res) => res.json({ status: "ok" }));
>>>>>>> 83cdb68 (add update)
=======
=======
>>>>>>> f13cd76 (Merge remote main)
app.use("/api/staff", staffRoutes);
app.use("/api/admin", adminRoutes);

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
<<<<<<< HEAD
>>>>>>> 1c6ce85 (add adnin login)
=======
>>>>>>> f13cd76 (Merge remote main)

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`MTeC Payment Backend listening on port ${port}`);
  console.log(`Webhook endpoint: /api/payments/webhook`);
<<<<<<< HEAD
<<<<<<< HEAD
=======
  console.log(`Staff cash-approval page: /staff`);
>>>>>>> 1c6ce85 (add adnin login)
=======
  console.log(`Staff cash-approval page: /staff`);
>>>>>>> f13cd76 (Merge remote main)
});
