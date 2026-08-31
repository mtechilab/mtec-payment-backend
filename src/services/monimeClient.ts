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

/** Creates a one-time Monime Payment Code. Amounts are in whole Leones
 *  here; converted to minor units (x100) before the API call — SLE 100 =
 *  value 10000. Uses Payment Codes (USSD), not Checkout Sessions — this
 *  account's Checkout Session webhooks don't fire; only payment_code.*
 *  events do. */
export async function createPaymentCode(params: {
  amountLeones: number;
  phone: string;
  customerName: string;
  internalReference: string;
}): Promise<PaymentCodeResult> {
  const accessToken = requireEnv("MONIME_ACCESS_TOKEN");
  const spaceId = requireEnv("MONIME_SPACE_ID");
  const idempotencyKey = crypto.randomUUID();

  const response = await fetch(`${MONIME_BASE_URL}/v1/payment-codes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Monime-Space-Id": spaceId,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      mode: "one_time",
      name: "MTeC Fee Payment",
      amount: { currency: "SLE", value: Math.round(params.amountLeones * 100) },
      duration: "30m",
      customer: { name: params.customerName },
      reference: params.internalReference,
      authorizedPhoneNumber: params.phone,
    }),
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

/** HMAC verification for incoming webhooks.
 *
 *  Confirmed header format (see mtec-admissions-system's own webhook fix):
 *    monime-signature: t=<timestamp>,v1=<base64 hmac>
 *  Signed payload is "{timestamp}.{rawBody}", HMAC-SHA256, base64-encoded —
 *  NOT a bare hex digest of the raw body alone. Splitting the header on the
 *  first "=" per segment (not a naive split("=")) matters because the
 *  base64 v1 value itself can contain "=" padding, which would otherwise
 *  get truncated. */
export function verifyMonimeSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;

  const parts: Record<string, string> = {};
  for (const segment of signatureHeader.split(",")) {
    const idx = segment.indexOf("=");
    if (idx === -1) continue;
    parts[segment.slice(0, idx)] = segment.slice(idx + 1);
  }

  const timestamp = parts["t"];
  const receivedSig = parts["v1"];
  if (!timestamp || !receivedSig) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("base64");

  try {
    return crypto.timingSafeEqual(Buffer.from(receivedSig), Buffer.from(expected));
  } catch {
    // Buffers of different length throw rather than returning false —
    // treat that as "not a match" rather than letting it bubble up.
    return false;
  }
}
