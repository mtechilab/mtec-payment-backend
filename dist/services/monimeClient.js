import crypto from "crypto";
const MONIME_BASE_URL = "https://api.monime.io";
function requireEnv(name) {
    const value = process.env[name];
    if (!value)
        throw new Error(`Missing required env var ${name} — check your .env file.`);
    return value;
}
/** Creates a one-time Monime Payment Code. Amounts are in whole Leones
 *  here; converted to minor units (x100) before the API call — SLE 100 =
 *  value 10000. Uses Payment Codes (USSD), not Checkout Sessions — this
 *  account's Checkout Session webhooks don't fire; only payment_code.*
 *  events do. */
export async function createPaymentCode(params) {
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
    const json = (await response.json());
    if (!response.ok || !json.success || !json.result) {
        throw new Error(`Monime create-payment-code failed: ${JSON.stringify(json)}`);
    }
    return { paymentCodeId: json.result.id, ussdCode: json.result.ussdCode, expireTime: json.result.expireTime };
}
/** HMAC verification for incoming webhooks — see the README for how to
 *  confirm the real header name, which isn't published in Monime's docs
 *  as of writing. */
export function verifyMonimeSignature(rawBody, signatureHeader, secret) {
    if (!signatureHeader)
        return false;
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    try {
        return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
    }
    catch {
        return false;
    }
}
