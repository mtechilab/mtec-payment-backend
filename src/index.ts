import "dotenv/config";
import express from "express";
import authRoutes from "./routes/authRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";

const app = express();

// Webhook route needs raw body — registered before express.json() so it
// alone gets the unparsed buffer; every other route gets normal JSON.
app.use("/api/payments", webhookRoutes);
<<<<<<< HEAD
//app.get('/health', (req, res) => res.status(200).send('OK'));
=======

>>>>>>> 36cdb6a (Initial commit)
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST");
  next();
});

app.use("/auth", authRoutes);
app.use("/payments", paymentRoutes);

<<<<<<< HEAD
app.get("/health", (req, res) => res.json({ status: "ok" }));
=======
app.get("/health", (_req, res) => res.json({ status: "ok" }));
>>>>>>> 36cdb6a (Initial commit)

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`MTeC Payment Backend listening on port ${port}`);
  console.log(`Webhook endpoint: /api/payments/webhook`);
});
