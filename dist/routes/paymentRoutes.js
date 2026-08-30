import { Router } from "express";
import { requireStudentAuth } from "../middleware/auth.js";
import { getSummaryForStudent, getPayableOptionsForStudent, validateRequestedAmount, createSubmission, getStatusForReference, attachProviderReference, getTransactionsForStudent, } from "../services/paymentPlanService.js";
import { createPaymentCode } from "../services/monimeClient.js";
import { getSupabase } from "../db/supabaseClient.js";
const router = Router();
router.use(requireStudentAuth);
// GET /payments/summary — PaymentPlanSummary.fromJson() reads this verbatim.
router.get("/summary", async (req, res) => {
    try {
        const summary = await getSummaryForStudent(req.studentRowId);
        res.json(summary);
    }
    catch (err) {
        console.error("[/payments/summary] error:", err.message);
        res.status(404).json({ error: "No active payment plan found." });
    }
});
// GET /payments/options — returns a BARE array (not wrapped), matching
// what PaymentApiClient.getPayableOptions() expects: it calls getArray()
// which does `new JSONArray(body)` directly on the raw response, then
// wraps it into { options: [...] } itself, client-side, for
// MakePaymentActivity's convenience. Wrapping it here too would break
// that parse with a JSONException.
router.get("/options", async (req, res) => {
    try {
        const options = await getPayableOptionsForStudent(req.studentRowId);
        res.json(options);
    }
    catch (err) {
        console.error("[/payments/options] error:", err.message);
        res.status(404).json({ error: "No active payment plan found." });
    }
});
// POST /payments/initiate — { amount, method } -> { transaction, monime? }
router.post("/initiate", async (req, res) => {
    try {
        const { amount, method } = req.body;
        if (!amount || !method) {
            return res.status(400).json({ error: "amount and method are required." });
        }
        const check = await validateRequestedAmount(req.studentRowId, amount);
        if (!check.valid) {
            return res.status(400).json({ error: check.reason });
        }
        const submission = await createSubmission(req.studentRowId, amount, method);
        if (method === "monime") {
            const supabase = getSupabase();
            const { data: student } = await supabase
                .from("students").select("phone, full_name").eq("id", req.studentRowId).single();
            const paymentCode = await createPaymentCode({
                amountLeones: amount,
                phone: student?.phone,
                customerName: student?.full_name,
                internalReference: submission.id, // matches submission.id, not a separate transaction id
            });
            // Track the Monime side alongside the submission so the webhook can
            // find it back by payment code id / our submission id.
            await supabase.from("payment_submissions").update({
                provider_reference: paymentCode.paymentCodeId,
            }).eq("id", submission.id);
            return res.json({
                transaction: { mtecReference: submission.mtec_reference, amount },
                monime: { ussdCode: paymentCode.ussdCode, expiresAt: paymentCode.expireTime },
            });
        }
        // Manual methods — no Monime object in the response; MakePaymentActivity
        // only reads .getJSONObject("monime") when method === MONIME.
        res.json({ transaction: { mtecReference: submission.mtec_reference, amount } });
    }
    catch (err) {
        console.error("[/payments/initiate] error:", err.message);
        res.status(500).json({ error: "Could not start payment. Please try again." });
    }
});
// GET /payments/status/:reference — polled by MonimePaymentActivity.
router.get("/status/:reference", async (req, res) => {
    try {
        const result = await getStatusForReference(req.studentRowId, req.params.reference);
        res.json(result);
    }
    catch (err) {
        console.error("[/payments/status] error:", err.message);
        res.status(500).json({ error: "Could not check status." });
    }
});
// POST /payments/submit-manual — { mtecReference, providerReference }
router.post("/submit-manual", async (req, res) => {
    try {
        const { mtecReference, providerReference } = req.body;
        if (!mtecReference || !providerReference) {
            return res.status(400).json({ error: "mtecReference and providerReference are required." });
        }
        const result = await attachProviderReference(req.studentRowId, mtecReference, providerReference);
        if (!result.success) {
            return res.status(409).json({ error: result.reason });
        }
        res.json({ success: true });
    }
    catch (err) {
        console.error("[/payments/submit-manual] error:", err.message);
        res.status(500).json({ error: "Could not submit payment." });
    }
});
// GET /payments/transactions — full payment history, matches image 1.
router.get("/transactions", async (req, res) => {
    try {
        const transactions = await getTransactionsForStudent(req.studentRowId);
        res.json({ transactions });
    }
    catch (err) {
        console.error("[/payments/transactions] error:", err.message);
        res.status(500).json({ error: "Could not load transactions." });
    }
});
export default router;
