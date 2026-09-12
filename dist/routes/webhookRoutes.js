import { Router } from "express";
import express from "express";
import { verifyMonimeSignature } from "../services/monimeClient.js";
import { finalizeVerifiedPayment } from "../services/paymentPlanService.js";
import { getSupabase } from "../db/supabaseClient.js";
const router = Router();
// Needs the RAW body for HMAC verification — parsing to JSON first and
// re-serializing would change the bytes and break the signature check.
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const rawBody = req.body;
    // TEMPORARY DIAGNOSTIC — uncomment while confirming the real signature
    // header name for the first time (see README's "Confirming the webhook
    // signature header" section), then comment it back out. Don't leave
    // this on permanently — request headers can include sensitive data in
    // other contexts, and there's no reason to log every request forever.
    const signatureHeaderName = process.env.MONIME_SIGNATURE_HEADER || "monime-signature";
    const signature = req.headers[signatureHeaderName.toLowerCase()];
    const secret = process.env.MONIME_WEBHOOK_SECRET || "";
    if (!verifyMonimeSignature(rawBody, signature, secret)) {
        console.warn("[webhook] signature verification failed — rejecting");
        return res.status(401).json({ error: "invalid_signature" });
    }
    let payload;
    try {
        payload = JSON.parse(rawBody.toString("utf8"));
    }
    catch {
        return res.status(400).json({ error: "invalid_json" });
    }
    const eventName = payload?.event?.name;
    const eventId = payload?.event?.id;
    const submissionId = payload?.data?.reference; // we set this = submission.id when creating the payment code
    console.log(`[webhook] received ${eventName} (event ${eventId}), submissionId=${submissionId}`);
    if (eventName === "payment_code.completed" && submissionId) {
        const supabase = getSupabase();
        // Idempotency: Monime retries deliveries. A unique constraint on
        // event_id means a retried delivery hits a conflict here and we bail
        // out before touching anything else — same pattern as the web app's
        // Monime integration.
        const { error: idempotencyError } = await supabase
            .from("processed_webhook_events")
            .insert({ event_id: eventId });
        if (idempotencyError) {
            if (idempotencyError.code === "23505") {
                console.log(`[webhook] event ${eventId} already processed — idempotent no-op`);
                return res.status(200).json({ received: true });
            }
            console.error("[webhook] idempotency insert failed:", idempotencyError.message);
            return res.status(500).json({ error: "internal_error" });
        }
        try {
            await finalizeVerifiedPayment(submissionId, "Monime (automatic)");
            console.log(`[webhook] submission ${submissionId} finalized`);
        }
        catch (err) {
            console.error("[webhook] finalize failed:", err.message);
        }
    }
    // Always 200 quickly for events we don't act on, so Monime doesn't retry unnecessarily.
    res.status(200).json({ received: true });
});
export default router;
