import crypto from "crypto";

const MONIME_BASE_URL = "https://api.monime.io";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} — check your .env file.`);
  return value;
}

export interface PaymentCodeResult {
  paymentCodeId: string;
  ussdCode: string;
  expireTime: string;
}

export interface RecurrentPaymentCodeResult {
  paymentCodeId: string;
  ussdCode: string;
  expireTime: string;
}

export async function createPaymentCode(params: {
  amountLeones: number;
  phone?: string;
  customerName: string;
  internalReference: string;
  duration?: string;
}): Promise<PaymentCodeResult> {
  const accessToken = requireEnv("MONIME_ACCESS_TOKEN");
  const spaceId = requireEnv("MONIME_SPACE_ID");
  const financialAccountId = requireEnv("MONIME_FINANCIAL_ACCOUNT_ID");
  const idempotencyKey = crypto.randomUUID();

  const body: Record<string, unknown> = {
    mode: "one_time",
    name: "MTeC Fee Payment",
    amount: { currency: "SLE", value: Math.round(params.amountLeones * 100) },
    duration: params.duration || "30m",
    customer: { name: params.customerName },
    reference: params.internalReference,
    financialAccountId,
  };
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
    throw new Error(`Monime create-payment-code failed: ${JSON.stringify(json)}`);
  }
  return { paymentCodeId: json.result.id, ussdCode: json.result.ussdCode, expireTime: json.result.expireTime };
}

export async function createRecurrentPaymentCode(params: {
  amountLeones: number;
  customerName: string;
  internalReference: string;
  duration: string;
  recurrentPaymentTarget?: { type: "count" | "amount"; value: number };
  phone?: string;
}): Promise<RecurrentPaymentCodeResult> {
  const accessToken = requireEnv("MONIME_ACCESS_TOKEN");
  const spaceId = requireEnv("MONIME_SPACE_ID");
  const financialAccountId = requireEnv("MONIME_FINANCIAL_ACCOUNT_ID");
  const idempotencyKey = crypto.randomUUID();

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

  // Two candidate keys: the secret used literally as UTF-8 text (what we
  // tried before), and the secret base64-decoded into raw key bytes
  // (untested until now).
  const keyCandidates: { label: string; key: Buffer }[] = [
    { label: "utf8", key: Buffer.from(secret, "utf8") },
  ];
  try {
    const decoded = Buffer.from(secret, "base64");
    // Only worth trying as a distinct candidate if it actually decodes to
    // something different-looking (avoids a duplicate, confusing entry
    // when the secret has no base64-only characters at all).
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
}
