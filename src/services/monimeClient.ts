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

  // Concrete check, not a guess: if these two numbers disagree, the bytes
  // we're hashing are provably NOT what Monime sent (truncated, re-encoded,
  // or altered somewhere in the proxy chain — Cloudflare + Render both sit
  // in front of this route per the b3/cf-*/rndr-id headers already seen).
  // If they match, transport corruption is ruled out entirely and the
  // remaining suspects narrow to the signing construction itself.
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
      // These are safe to log — one-way HMAC outputs, not the secret
      // itself. Whichever candidate.value exactly equals `provided` here
      // tells us which construction Monime actually uses.
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

  // UNCONFIRMED field paths for the recurrent case — captured here so a
  // real payment_code.completed delivery can be checked against these
  // before relying on the recurrent flow in production.
  const processedPaymentData = payload?.data?.processedPaymentData;
  const paymentId = processedPaymentData?.paymentId ?? payload?.data?.paymentId;
  const paymentCodeId = payload?.data?.paymentCodeId ?? payload?.data?.id;
  const amountMinor = processedPaymentData?.amount?.value ?? payload?.data?.amount?.value;
  const providerReference = processedPaymentData?.reference ?? payload?.data?.reference;

  // For a one-time code, `reference` is submission.id — set by /initiate
  // before the Payment Code was created.
  const oneTimeSubmissionId = payload?.data?.reference;

  console.log(`[webhook] received ${eventName} (event ${eventId})`, { paymentId, paymentCodeId, oneTimeSubmissionId });

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
    return res.status(200).json({ received: true });
  }

  if (eventName !== "payment_code.completed") {
    // Anything else we don't act on — 200 quickly so Monime doesn't keep retrying.
    return res.status(200).json({ received: true });
  }

  const supabase = getSupabase();

  // ---- Event-level idempotency (shared by both paths below) ----
  const { data: existingEvent } = await supabase
    .from("processed_webhook_events").select("event_id").eq("event_id", eventId).maybeSingle();
  if (existingEvent) {
    console.log(`[webhook] event ${eventId} already processed — idempotent no-op`);
    return res.status(200).json({ received: true });
  }

  // =========================================================
  // RECURRENT: look up by the plan's stored recurrent code id
  // =========================================================
  if (paymentCodeId) {
    const { data: plan, error: planError } = await supabase
      .from("payment_plans").select("*").eq("monime_recurrent_code_id", paymentCodeId).maybeSingle();

    if (planError) {
      console.error("[webhook] plan lookup failed:", planError.message);
      return res.status(500).json({ error: "internal_error" });
    }

    if (plan) {
      if (!paymentId || amountMinor == null) {
        console.error("[webhook] missing payment data for recurrent event", { eventId, paymentId, amountMinor });
        // Nothing safe to act on with an incomplete payload — ack so
        // Monime doesn't retry forever, but don't mark it processed.
        return res.status(200).json({ received: true });
      }

      // Payment-level idempotency — protects against the same Monime
      // payment being processed twice even across separate events.
      const { data: existingPayment } = await supabase
        .from("payment_submissions").select("id, status").eq("monime_payment_id", paymentId).maybeSingle();
      if (existingPayment) {
        await supabase.from("processed_webhook_events").insert({ event_id: eventId });
        return res.status(200).json({ received: true });
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
          return res.status(200).json({ received: true });
        }
        console.error("[webhook] recurrent submission creation failed:", submissionError.message);
        return res.status(500).json({ error: "internal_error" });
      }

      try {
        await finalizeVerifiedPayment(submission.id, "Monime (automatic)");
        console.log(`[webhook] recurrent payment ${paymentId} finalized (submission ${submission.id})`);
      } catch (err) {
        console.error("[webhook] recurrent finalize failed:", (err as Error).message);
        // Don't mark the event processed — let Monime retry.
        return res.status(500).json({ error: "payment_processing_failed" });
      }

      const { error: eventError } = await supabase.from("processed_webhook_events").insert({ event_id: eventId });
      if (eventError && eventError.code !== "23505") {
        console.error("[webhook] event recording failed:", eventError.message);
        return res.status(500).json({ error: "internal_error" });
      }

      return res.status(200).json({ received: true });
    }
  }

  // =========================================================
  // ONE-TIME: reference is the pre-created submission.id
  // (unchanged from the original working one-time flow)
  // =========================================================
  if (!oneTimeSubmissionId) {
    console.error("[webhook] payment_code.completed with no matching recurrent plan or submission reference");
    return res.status(200).json({ received: true });
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
      return res.status(200).json({ received: true });
    }
    console.error("[webhook] idempotency insert failed:", idempotencyError.message);
    return res.status(500).json({ error: "internal_error" });
  }

  try {
    await finalizeVerifiedPayment(oneTimeSubmissionId, "Monime (automatic)");
    console.log(`[webhook] submission ${oneTimeSubmissionId} finalized`);
  } catch (err) {
    console.error("[webhook] finalize failed:", (err as Error).message);
  }

  res.status(200).json({ received: true });
});

export default router;
  const body: Record<string, unknown> = {
    mode: "recurrent",
    name: "MTeC Recurring Fee Payment",
    amount: { currency: "SLE", value: Math.round(params.amountLeones * 100) },
    duration: params.duration,
    customer: { name: params.customerName },
    reference: params.internalReference,
    financialAccountId,
  };
  if (params.recurrentPaymentTarget) body.recurrentPaymentTarget = params.recurrentPaymentTarget;
  // No phone restriction by default, so a parent/guardian can redeem the
  // monthly code too — actual cross-phone redemption still depends on
  // Monime account/payment-code configuration, not just this flag.
  if (params.phone) body.authorizedPhoneNumber = params.phone;

  const response = await fetch(`${MONIME_BASE_URL}/v1/payment-codes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Monime-Space-Id": spaceId,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });

  const json = (await response.json()) as {
    success: boolean;
    result?: { id: string; ussdCode: string; expireTime: string };
  };
  if (!response.ok || !json.success || !json.result) {
    throw new Error(`Monime create-recurrent-payment-code failed: ${JSON.stringify(json)}`);
  }
  return { paymentCodeId: json.result.id, ussdCode: json.result.ussdCode, expireTime: json.result.expireTime };
}

export type SignatureCheckResult =
  | { valid: true }
  | { valid: false; reason: "missing_secret" | "missing_header" | "malformed_header" | "timestamp_too_old" }
  | { valid: false; reason: "mismatch"; provided: string; candidates: { label: string; value: string }[] };

/**
 * HMAC verification for incoming webhooks.
 *
 * Every "mismatch" delivery so far has failed ALL FOUR body-construction
 * candidates uniformly — that pattern points at the SECRET being wrong
 * (a wrong secret fails every construction equally), not the message
 * construction. Still, this now also tries decoding the secret as base64
 * before use as the HMAC key: providers using this t=...,v1=... header
 * shape (Svix and Svix-compatible implementations) commonly issue a
 * base64-encoded secret that must be decoded to raw bytes first, rather
 * than used as literal UTF-8 text — an easy thing to get wrong and one
 * that produces exactly this "every candidate fails" symptom even with
 * the correct secret value pasted in.
 */
export function verifyMonimeSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): SignatureCheckResult {
  if (!secret) return { valid: false, reason: "missing_secret" };
  if (!signatureHeader) return { valid: false, reason: "missing_header" };

  const parts: Record<string, string> = {};
  for (const kv of signatureHeader.split(",")) {
    const eq = kv.indexOf("=");
    if (eq === -1) continue;
    parts[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }

  const timestamp = parts["t"];
  const providedSignature = parts["v1"];
  if (!timestamp || !providedSignature) return { valid: false, reason: "malformed_header" };

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return { valid: false, reason: "malformed_header" };
  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (ageSeconds > 300) return { valid: false, reason: "timestamp_too_old" };

  const dotJoined = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]);
  const noSeparator = Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]);
  const colonJoined = Buffer.concat([Buffer.from(`${timestamp}:`, "utf8"), rawBody]);

  // Two candidate keys: the secret used literally as UTF-8 text (what was
  // tried before), and the secret base64-decoded into raw key bytes
  // (new — untested until now).
  const keyCandidates: { label: string; key: Buffer }[] = [
    { label: "utf8", key: Buffer.from(secret, "utf8") },
  ];
  try {
    const decoded = Buffer.from(secret, "base64");
    // Only worth trying as a distinct candidate if it actually round-trips
    // — avoids a duplicate, confusing entry when the secret has no
    // base64-only characters at all.
    if (decoded.length > 0 && decoded.toString("base64").replace(/=+$/, "") === secret.replace(/=+$/, "")) {
      keyCandidates.push({ label: "base64-decoded", key: decoded });
    }
  } catch {
    // not valid base64 — skip, utf8 candidate above still applies
  }

  const bodyCandidates: { label: string; payload: Buffer }[] = [
    { label: "timestamp.body", payload: dotJoined },
    { label: "timestamp+body (no separator)", payload: noSeparator },
    { label: "timestamp:body (colon)", payload: colonJoined },
    { label: "body only (no timestamp)", payload: rawBody },
  ];

  const allCandidates: { label: string; value: string }[] = [];
  for (const keyC of keyCandidates) {
    for (const bodyC of bodyCandidates) {
      const value = crypto.createHmac("sha256", keyC.key).update(bodyC.payload).digest("base64");
      allCandidates.push({ label: `key=${keyC.label}, body=${bodyC.label}`, value });

      try {
        if (crypto.timingSafeEqual(Buffer.from(providedSignature), Buffer.from(value))) {
          return { valid: true };
        }
      } catch {
        // length mismatch on this candidate — not a match, keep checking others
      }
    }
  }

  return {
    valid: false,
    reason: "mismatch",
    provided: providedSignature,
    candidates: allCandidates,
  };
}    candidates: [
      { label: "timestamp.body (current)", value: expected },
      { label: "timestamp+body (no separator)", value: hmacBase64(noSeparator) },
      { label: "timestamp:body (colon)", value: hmacBase64(colonJoined) },
      { label: "body only (no timestamp)", value: hmacBase64(rawBody) },
    ],
  };
}
