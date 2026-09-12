# MTeC Payment Backend

TypeScript/Express backend serving the MTeC Student Android app's payment
flows (`com.mtec.student`) — built to match `PaymentApiClient.java`'s
contract exactly, field-for-field, verified by reading the compiled
Android source rather than guessed.

## Routes

**Auth** (`/auth`):
- `POST /auth/student-login` — `{ studentId, credential }`. First login (PIN as
  credential) returns `{ outcome: "first_login_required" }`; subsequent
  logins (password as credential) return `{ authToken, studentName,
  studentPublicId, programmeName }`.
- `POST /auth/student-first-login` — `{ studentId, newPassword }`, sets the
  real password (bcrypt-hashed server-side) and returns the same success
  shape as login.

**Payments** (`/payments` — every route below requires `Authorization:
Bearer <authToken>`; the student's identity is derived from that token
server-side, never from anything in the request body):
- `GET /payments/summary` — full dashboard data: plan, totals, progress,
  schedule. Matches `PaymentPlanSummary.fromJson()`.
- `GET /payments/options` — `{ options: [...] }`, the "1 Month / 2
  Months..." chips, capped at what's actually still unpaid.
- `POST /payments/initiate` — `{ amount, method }`. Validates server-side
  before anything else happens. For `method: "monime"`, also creates a
  real Monime Payment Code and returns `{ transaction, monime: { ussdCode,
  expiresAt } }`. For manual methods, returns `{ transaction }` only (no
  `monime` key — the Android app only reads it when the method is Monime).
- `GET /payments/status/:reference` — polled by `MonimePaymentActivity`.
  Returns `{ status: "pending" | "successful" | "failed" }`.
- `POST /payments/submit-manual` — `{ mtecReference, providerReference }`,
  flips a manual submission to `under_review` for finance to verify. A
  reused `providerReference` is rejected by a real database constraint,
  not just application logic.
- `GET /payments/transactions` — full history for the Transactions screen,
  richer status labels than `/status` (`successful` / `verified` /
  `under_review` / `failed`, plus `rejectionReason` when relevant).

**Webhook** (`/api/payments`):
- `POST /api/payments/webhook` — Monime calls this. HMAC-verified,
  idempotent (a unique constraint on the event id rejects retried
  deliveries before anything else runs), only acts on
  `payment_code.completed`.

## Setup

```bash
cp .env.example .env   # fill in real values — see below
npm install
npm run dev             # local dev, auto-restarts on change
```

Before anything will actually work:
1. Create a Supabase project, run `schema.sql` in its SQL Editor.
2. Fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`.
3. Fill in `JWT_SECRET` — any long random string (`openssl rand -hex 32`).
4. Fill in the three `MONIME_*` values from your Monime dashboard.

## Confirming the webhook signature header

Monime's own HMAC verification docs are a placeholder as of when this was
written — the real header name carrying the signature isn't published.
`verifyMonimeSignature()` in `src/services/monimeClient.ts` computes a
standard HMAC-SHA256 hex digest and compares it against whatever header
`MONIME_SIGNATURE_HEADER` points at (defaults to `monime-signature`, which
is an educated guess, not a confirmed value).

To confirm the real one:
1. In `src/routes/webhookRoutes.ts`, uncomment the line:
   ```ts
   // console.log("Webhook headers received:", req.headers);
   ```
2. Trigger one real test webhook from the Monime dashboard (or complete
   one real test payment).
3. Check your server logs — find whichever header actually carries a
   signature-looking value (something like `monime-signature` or
   `x-monime-signature`).
4. Set `MONIME_SIGNATURE_HEADER` in `.env` (or your Render environment
   variables) to match exactly.
5. Comment the diagnostic line back out — no reason to log every
   request's headers permanently.

Until this is confirmed, webhook signature checks fail closed (reject
everything) rather than fail open (accept anything) — safe, but
non-functional until fixed.

## Deploying (Render)

1. Push this repo to GitHub (`.gitignore` already excludes `node_modules`,
   `dist`, `.env` — confirm before pushing that none of those got
   committed anyway).
2. Render → New → Web Service → connect the repo.
   - Build command: `npm install && npm run build`
   - Start command: `npm start`
3. Add every variable from `.env.example` as a real environment variable
   in Render's dashboard. Skip `PORT` — Render sets it automatically.
4. Once deployed, register `https://<your-render-host>/api/payments/webhook`
   as the webhook URL in the Monime dashboard.
5. **Update `PaymentApiClient.java`'s `BASE_URL`** in the Android project
   to the real deployed host, then rebuild the APK. The compiled app has
   this hardcoded — a mismatched host here means every payment screen
   fails silently with a connection error, not an obvious crash.

## What's real vs. what needs your input

**Real, tested this session:** the full schema ran clean against a real
Postgres instance (not just reviewed); the payment allocation math
(splitting one payment across multiple periods, partial payments, the
overpayment-leftover edge case) was unit-tested against worked examples;
the `method` enum values were verified against the actual compiled
Android `PaymentMethod.java`, not guessed (an earlier guess was wrong and
caught by this verification); the webhook route was boot-tested and
confirmed returning 401 for an unsigned request rather than 404, proving
the route itself is correctly wired.

**Needs your input:** the real Monime webhook signature header name (see
above), and — once Supabase Auth gets added for the *staff-facing* side of
the broader MTeC system — this backend's own RLS assumptions should be
revisited, since it currently uses the service-role key for everything
(bypasses RLS entirely, appropriate for a backend service, but worth
being deliberate about rather than assumed).
