import { Router } from "express";
import express from "express";
import { verifyMonimeSignature } from "../services/monimeClient.js";
import { finalizeVerifiedPayment, generateMtecReference, expireSubmission } from "../services/paymentPlanService.js";
import { getSupabase } from "../db/supabaseClient.js";

const router = Router();

// Needs the RAW body for HMAC verification — parsing to JSON first and
// re-serializing would change the bytes and break the signature check.
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const rawBody = req.body as Buffer;

  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && rawBody.length !== declaredLength) {
    console.warn(`[webhook] ALERT: body length mismatch — received ${rawBody.length} bytes, content-length header said ${declaredLength}`);
  }

  const signatureHeaderName = process.env.MONIME_SIGNATURE_HEADER || "monime-signature";
  const signature = req.headers[signatureHeaderName.toLowerCase()] as string | undefined;
  const secret = process.env.MONIME_WEBHOOK_SECRET || "";

  const signatureCheck = verifyMonimeSignature(rawBody, signature, secret);
  if (!signatureCheck.valid) {
    if (signatureCheck.reason === "mismatch") {
      console.warn(`[webhook] signature verification failed (mismatch) — provided: ${signatureCheck.provided}, body length: ${rawBody.length}`);
      for (const c of signatureCheck.candidates) {
        console.warn(`[webhook]   candidate "${c.label}": ${c.value}`);
      }
    } else {
      console.warn(`[webhook] signature verification failed (${signatureCheck.reason}) — rejecting`);
    }
    return res.status(401).json({ error: "invalid_signature" });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "invalid_json" });
  }

  const eventName = payload?.event?.name;
  const eventId = payload?.event?.id;

  const processedPaymentData = payload?.data?.processedPaymentData;
  const paymentId = processedPaymentData?.paymentId ?? payload?.data?.paymentId;
  const paymentCodeId = payload?.data?.paymentCodeId ?? payload?.data?.id;
  const amountMinor = processedPaymentData?.amount?.value ?? payload?.data?.amount?.value;
  const providerReference = processedPaymentData?.reference ?? payload?.data?.reference;

  // For a one-time code, `reference` is submission.id — set by /initiate
  // before the Payment Code was created.
  const oneTimeSubmissionId = payload?.data?.reference;

  console.log(`[webhook] received ${eventName} (event ${eventId})`, { paymentId, paymentCodeId, oneTimeSubmissionId });

  // ---------------------------------------------------------------------
  // ACK FIRST, PROCESS AFTER.
  //
  // Every branch below used to `await` its Supabase work before sending a
  // response, which meant Monime's ~10s delivery timeout was effectively a
  // timeout on OUR database, not just on our server being reachable. A
  // slow/cold Supabase round trip on any single call was enough to blow
  // the whole delivery (confirmed live: `payment_code.expired` deliveries
  // timing out at exactly ~10000ms with HTTP code -1, meaning Monime never
  // even got a response to time out gracefully from).
  //
  // Once we've verified the signature and parsed the JSON, there's nothing
  // else Monime needs from us — respond 200 immediately, then do the
  // actual DB work in the background. Errors during that background work
  // are logged, not surfaced to Monime; Monime's own retry schedule still
  // covers "we crashed before finishing," but a slow-but-successful DB
  // call no longer costs us a delivery.
  // ---------------------------------------------------------------------
  res.status(200).json({ received: true });

  processWebhookEvent({ eventName, eventId, paymentId, paymentCodeId, amountMinor, providerReference, oneTimeSubmissionId }).catch((err) => {
    console.error(`[webhook] unhandled error processing ${eventName} (event ${eventId}):`, (err as Error).message);
  });
});

async function processWebhookEvent(args: {
  eventName: string | undefined;
  eventId: string | undefined;
  paymentId: string | undefined;
  paymentCodeId: string | undefined;
  amountMinor: number | undefined;
  providerReference: string | undefined;
  oneTimeSubmissionId: string | undefined;
}) {
  const { eventName, eventId, paymentId, paymentCodeId, amountMinor, providerReference, oneTimeSubmissionId } = args;

  if (eventName === "payment_code.expired") {
    // A one-time code's `reference` is the submission id (set at /initiate,
    // same as the completed path). expireSubmission() is naturally
    // idempotent (only touches status "pending"), so no separate
    // event-id dedup is needed here.
    if (oneTimeSubmissionId) {
      try {
        await expireSubmission(oneTimeSubmissionId);
      } catch (err) {
        console.error("[webhook] expireSubmission failed:", (err as Error).message);
      }
    }
    return;
  }

  if (eventName !== "payment_code.completed") {
    // Anything else we don't act on.
    return;
  }

  if (!eventId) {
    console.error("[webhook] payment_code.completed missing event id — cannot dedupe, skipping");
    return;
  }

  const supabase = getSupabase();

  // ---- Event-level idempotency (shared by both paths below) ----
  const { data: existingEvent } = await supabase
    .from("processed_webhook_events").select("event_id").eq("event_id", eventId).maybeSingle();
  if (existingEvent) {
    console.log(`[webhook] event ${eventId} already processed — idempotent no-op`);
    return;
  }

  // =========================================================
  // RECURRENT: look up by the plan's stored recurrent code id
  // =========================================================
  if (paymentCodeId) {
    const { data: plan, error: planError } = await supabase
      .from("payment_plans").select("*").eq("monime_recurrent_code_id", paymentCodeId).maybeSingle();

    if (planError) {
      console.error("[webhook] plan lookup failed:", planError.message);
      return;
    }

    if (plan) {
      if (!paymentId || amountMinor == null) {
        console.error("[webhook] missing payment data for recurrent event", { eventId, paymentId, amountMinor });
        return;
      }

      // Payment-level idempotency — protects against the same Monime
      // payment being processed twice even across separate events.
      const { data: existingPayment } = await supabase
        .from("payment_submissions").select("id, status").eq("monime_payment_id", paymentId).maybeSingle();
      if (existingPayment) {
        await supabase.from("processed_webhook_events").insert({ event_id: eventId });
        return;
      }

      const amountLeones = Number(amountMinor) / 100;
      const mtecReference = await generateMtecReference(plan.student_row_id as string);

      const { data: submission, error: submissionError } = await supabase
        .from("payment_submissions")
        .insert({
          mtec_reference: mtecReference,
          payment_plan_id: plan.id,
          student_row_id: plan.student_row_id,
          amount: amountLeones,
          method: "monime",
          status: "pending",
          monime_payment_code_id: paymentCodeId,
          monime_payment_id: paymentId,
          monime_transaction_reference: providerReference || null,
          provider_reference: providerReference || null,
        })
        .select()
        .single();

      if (submissionError) {
        if (submissionError.code === "23505") {
          // A concurrent webhook delivery already created it.
          return;
        }
        console.error("[webhook] recurrent submission creation failed:", submissionError.message);
        return;
      }

      try {
        await finalizeVerifiedPayment(submission.id, "Monime (automatic)");
        console.log(`[webhook] recurrent payment ${paymentId} finalized (submission ${submission.id})`);
      } catch (err) {
        console.error("[webhook] recurrent finalize failed:", (err as Error).message);
        // Don't mark the event processed — a later manual retry / reconciliation can pick this up.
        return;
      }

      const { error: eventError } = await supabase.from("processed_webhook_events").insert({ event_id: eventId });
      if (eventError && eventError.code !== "23505") {
        console.error("[webhook] event recording failed:", eventError.message);
      }
      return;
    }
  }

  // =========================================================
  // ONE-TIME: reference is the pre-created submission.id
  // (unchanged from the original working one-time flow)
  // =========================================================
  if (!oneTimeSubmissionId) {
    console.error("[webhook] payment_code.completed with no matching recurrent plan or submission reference");
    return;
  }

  // Idempotency: Monime retries deliveries. A unique constraint on
  // event_id means a retried delivery hits a conflict here and we bail
  // out before touching anything else.
  const { error: idempotencyError } = await supabase
    .from("processed_webhook_events")
    .insert({ event_id: eventId });

  if (idempotencyError) {
    if (idempotencyError.code === "23505") {
      console.log(`[webhook] event ${eventId} already processed — idempotent no-op`);
      return;
    }
    console.error("[webhook] idempotency insert failed:", idempotencyError.message);
    return;
  }

  try {
    await finalizeVerifiedPayment(oneTimeSubmissionId, "Monime (automatic)");
    console.log(`[webhook] submission ${oneTimeSubmissionId} finalized`);
  } catch (err) {
    console.error("[webhook] finalize failed:", (err as Error).message);
  }
}

export default router;
