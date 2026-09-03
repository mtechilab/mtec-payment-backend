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

/** Creates a one-time Monime Payment Code. Amounts are in whole Leones
 *  here; converted to minor units (x100) before the API call — SLE 100 =
 *  value 10000. Uses Payment Codes (USSD), not Checkout Sessions — this
 *  account's Checkout Session webhooks don't fire; only payment_code.*
 *  events do.
 *
 *  `financialAccountId` targets a specific financial account in the
 *  Monime space (this space has more than one — see MONIME_FINANCIAL_ACCOUNT_ID
 *  below). Omitting it was letting Monime pick a default, which is the
 *  likely cause of inconsistent USSD codes — some routable on Orange
 *  Money, some rejected with "cannot be used on 'Orange Money'".
 *
 *  `phone` is optional: only send authorizedPhoneNumber when explicitly
 *  supplied. An incorrect network/phone match here is what produced a
 *  real "reference code cannot be used on Orange Money" rejection during
 *  testing — omitting it avoids locking the code to a network the payer
 *  may not be on. */
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

/** Creates a REUSABLE / RECURRENT Payment Code — one fixed amount per
 *  redemption, intended for the "Pay Monthly" Watu-style flow. A single
 *  recurrent code can be redeemed multiple times over its lifetime; each
 *  redemption produces its own payment_code.completed webhook event.
 *
 *  UNCONFIRMED: the exact accepted `duration` syntax for recurrent codes
 *  (e.g. "4mo") and the `recurrentPaymentTarget` shape have not been
 *  verified against Monime's docs/support — confirm with a real account
 *  test before relying on this in production. A rejected format throws
 *  here rather than silently misbehaving, so it should surface clearly. */
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

/**
 * HMAC verification for incoming webhooks. Confirmed against a real
 * captured delivery (not guessed): Monime's `monime-signature` header
 * uses the same t=<timestamp>,v1=<signature> pattern as Stripe, Mux,
 * Monite, and Zoho — but unlike those (hex), Monime's v1 value is
 * base64-encoded, confirmed by the '+', '/', and '=' padding characters
 * in a real captured signature, which are not valid hex.
 *
 * Signed payload construction (`${timestamp}.${rawBody}`, dot-joined)
 * matches the near-universal convention across every provider using this
 * header shape — this is the standard construction, not a guess specific
 * to Monime.
 *
 * Also rejects timestamps older than 5 minutes, standard replay-attack
 * protection used by every provider in this family (Stripe, Zoho, etc).
 */
export type SignatureCheckResult =
  | { valid: true }
  | { valid: false; reason: "missing_secret" | "missing_header" | "malformed_header" | "timestamp_too_old" }
  | { valid: false; reason: "mismatch"; provided: string; candidates: { label: string; value: string }[] };

export function verifyMonimeSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): SignatureCheckResult {
  // Checked first and separately from a bad/missing header: if the env var
  // itself is empty, every delivery will fail HMAC comparison no matter
  // what Monime sends — worth distinguishing in logs from "Monime sent a
  // malformed signature", since the fix is completely different (an env
  // var to set on Render vs. something to report to Monime).
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
  if (ageSeconds > 300) return { valid: false, reason: "timestamp_too_old" }; // reject anything older than 5 minutes

  const hmacBase64 = (payload: Buffer) => crypto.createHmac("sha256", secret).update(payload).digest("base64");

  // Primary construction — Stripe/Monite-style "timestamp.body". Never
  // actually confirmed to match Monime's real scheme (only assumed by
  // convention), so on mismatch below we also compute the next most
  // plausible alternatives to compare side by side against a real
  // delivery, rather than guessing again one at a time.
  const dotJoined = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]);
  const expected = hmacBase64(dotJoined);

  try {
    const matches = crypto.timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expected));
    if (matches) return { valid: true };
  } catch {
    // length mismatch — definitely not a match, fall through to report candidates
  }

  const noSeparator = Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]);
  const colonJoined = Buffer.concat([Buffer.from(`${timestamp}:`, "utf8"), rawBody]);

  return {
    valid: false,
    reason: "mismatch",
    provided: providedSignature,
    candidates: [
      { label: "timestamp.body (current)", value: expected },
      { label: "timestamp+body (no separator)", value: hmacBase64(noSeparator) },
      { label: "timestamp:body (colon)", value: hmacBase64(colonJoined) },
      { label: "body only (no timestamp)", value: hmacBase64(rawBody) },
    ],
  };
}
