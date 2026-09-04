import { Router, Response } from "express";
import crypto from "crypto";
import { AuthenticatedRequest, requireStudentAuth } from "../middleware/auth.js";
import {
  getSummaryForStudent,
  getPayableOptionsForStudent,
  validateRequestedAmount,
  createSubmission,
  getStatusForReference,
  attachProviderReference,
  getTransactionsForStudent,
  ensureRecurrentPaymentCode,
<<<<<<< HEAD
  cancelSubmission,
=======
>>>>>>> 36cdb6a (Initial commit)
  SubmissionMethod,
} from "../services/paymentPlanService.js";
import { createPaymentCode } from "../services/monimeClient.js";
import { getSupabase } from "../db/supabaseClient.js";

const router = Router();
router.use(requireStudentAuth);

// GET /payments/summary — PaymentPlanSummary.fromJson() reads this verbatim.
router.get("/summary", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const summary = await getSummaryForStudent(req.studentRowId!);
    res.json(summary);
  } catch (err) {
    console.error("[/payments/summary] error:", (err as Error).message);
    res.status(404).json({ error: "No active payment plan found." });
  }
});

// GET /payments/options — returns a BARE array (not wrapped), matching
// what PaymentApiClient.getPayableOptions() expects: it calls getArray()
// which does `new JSONArray(body)` directly on the raw response, then
// wraps it into { options: [...] } itself, client-side, for
// MakePaymentActivity's convenience. Wrapping it here too would break
// that parse with a JSONException.
router.get("/options", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const options = await getPayableOptionsForStudent(req.studentRowId!);
    res.json(options);
  } catch (err) {
    console.error("[/payments/options] error:", (err as Error).message);
    res.status(404).json({ error: "No active payment plan found." });
  }
});

type PaymentType = "recurrent" | "one_time";

// POST /payments/initiate — { amount, method, paymentType? } -> { transaction, monime? }
//
// paymentType defaults to "one_time" so existing Android app builds that
// don't send the field keep working unchanged. "recurrent" is the new
// "Pay Monthly" flow using a single reusable USSD code.
router.post("/initiate", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { amount, method, paymentType = "one_time" } = req.body as {
      amount: number;
      method: SubmissionMethod;
      paymentType?: PaymentType;
    };

    if (!amount || !method) {
      return res.status(400).json({ error: "amount and method are required." });
    }
    if (paymentType !== "recurrent" && paymentType !== "one_time") {
      return res.status(400).json({ error: "Invalid payment type." });
    }

    const check = await validateRequestedAmount(req.studentRowId!, amount);
    if (!check.valid) {
      return res.status(400).json({ error: check.reason });
    }

    const supabase = getSupabase();

    // ---- RECURRENT (monthly, reusable code) ----
    if (method === "monime" && paymentType === "recurrent") {
      const recurrentCode = await ensureRecurrentPaymentCode(req.studentRowId!);
      // No submission is created here — one is created by the webhook
      // each time this reusable code is actually redeemed.
      return res.json({
        transaction: { amount: recurrentCode.amount, paymentType: "recurrent" },
        monime: {
          paymentCodeId: recurrentCode.codeId,
          ussdCode: recurrentCode.ussdCode,
          expiresAt: recurrentCode.expireTime,
          amount: recurrentCode.amount,
          paymentType: "recurrent",
        },
      });
    }

    const submission = await createSubmission(req.studentRowId!, amount, method);

    if (method === "monime") {
      const { data: student } = await supabase
        .from("students").select("phone, full_name").eq("id", req.studentRowId!).single();

      const paymentCode = await createPaymentCode({
        amountLeones: amount,
        phone: student?.phone as string,
        customerName: student?.full_name as string,
        internalReference: submission.id as string, // matches submission.id, not a separate transaction id
      });

      // Track the Monime side alongside the submission so the webhook can
      // find it back by payment code id / our submission id.
      await supabase.from("payment_submissions").update({
        provider_reference: paymentCode.paymentCodeId,
        monime_payment_code_id: paymentCode.paymentCodeId,
      }).eq("id", submission.id as string);

      return res.json({
        transaction: { mtecReference: submission.mtec_reference, amount, paymentType: "one_time" },
        monime: {
          paymentCodeId: paymentCode.paymentCodeId,
          ussdCode: paymentCode.ussdCode,
          expiresAt: paymentCode.expireTime,
          amount,
          paymentType: "one_time",
        },
      });
    }

    // Manual methods — no Monime object in the response; MakePaymentActivity
    // only reads .getJSONObject("monime") when method === MONIME.
    res.json({ transaction: { mtecReference: submission.mtec_reference, amount, paymentType: "one_time" } });
  } catch (err) {
    console.error("[/payments/initiate] error:", (err as Error).message);
    res.status(500).json({ error: "Could not start payment. Please try again." });
  }
});

// GET /payments/status/:reference — polled by MonimePaymentActivity.
router.get("/status/:reference", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await getStatusForReference(req.studentRowId!, req.params.reference);
    res.json(result);
  } catch (err) {
    console.error("[/payments/status] error:", (err as Error).message);
    res.status(500).json({ error: "Could not check status." });
  }
});

// POST /payments/submit-manual — { mtecReference, providerReference }
router.post("/submit-manual", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { mtecReference, providerReference } = req.body;
    if (!mtecReference || !providerReference) {
      return res.status(400).json({ error: "mtecReference and providerReference are required." });
    }
    const result = await attachProviderReference(req.studentRowId!, mtecReference, providerReference);
    if (!result.success) {
      return res.status(409).json({ error: result.reason });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[/payments/submit-manual] error:", (err as Error).message);
    res.status(500).json({ error: "Could not submit payment." });
  }
});

<<<<<<< HEAD
// POST /payments/:reference/cancel — student backed out of an in-progress
// (still "pending") payment, e.g. tapping Cancel on the Monime USSD screen.
// Frees up the reserved amount so validateRequestedAmount stops counting
// it against their balance on the next attempt.
router.post("/:reference/cancel", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await cancelSubmission(req.studentRowId!, req.params.reference);
    if (!result.success) {
      return res.status(409).json({ error: result.reason });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[/payments/:reference/cancel] error:", (err as Error).message);
    res.status(500).json({ error: "Could not cancel payment." });
  }
});

=======
>>>>>>> 36cdb6a (Initial commit)
// GET /payments/transactions — full payment history, matches image 1.
router.get("/transactions", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const transactions = await getTransactionsForStudent(req.studentRowId!);
    res.json({ transactions });
  } catch (err) {
    console.error("[/payments/transactions] error:", (err as Error).message);
    res.status(500).json({ error: "Could not load transactions." });
  }
});

export default router;
