<<<<<<< HEAD
<<<<<<< HEAD
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
=======
=======
>>>>>>> 83cdb68 (add update)
import { getSupabase } from "../db/supabaseClient.js";
import { createRecurrentPaymentCode } from "./monimeClient.js";

// ---------------------------------------------------------------------
// Every response shape in this file is written to match the Android
// app's model classes EXACTLY (verified by reading PaymentPlanSummary.
// java, SchedulePeriod.java, PayableOption.java directly, not guessed):
//   GET /payments/summary  -> PaymentPlanSummary.fromJson()
//   GET /payments/options  -> { options: PayableOption[] }
// Field names below are camelCase on purpose, matching the Java parsing
// code's json.getString("periodLabel") etc. — changing a field name here
// breaks the app silently (org.json throws, caught, shown as a toast).
// ---------------------------------------------------------------------

export type Frequency = "daily" | "weekly" | "monthly" | "semester";
export type SubmissionMethod = "monime" | "orange_money" | "orange_money_agent" | "cash_deposit" | "alternative_account";

interface PeriodRow {
  id: string;
  period_label: string;
  period_index: number;
  due_date: string;
  amount_due: number;
  amount_paid: number;
  status: "upcoming" | "due" | "overdue" | "paid";
}

async function getActivePlanForStudent(studentRowId: string) {
  const supabase = getSupabase();
  const { data: plan, error } = await supabase
    .from("payment_plans")
    .select("*")
    .eq("student_row_id", studentRowId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getActivePlanForStudent failed: ${error.message}`);
  if (!plan) throw new Error("No active payment plan found for this student.");

  // Separate query rather than an embedded join — avoids needing full
  // foreign-key Relationships metadata in the hand-written Database type
  // just to satisfy postgrest-js's embedded-select type inference.
  const { data: programme } = await supabase
    .from("programmes")
    .select("name, duration_years")
    .eq("id", plan.programme_id)
    .maybeSingle();

  return { ...plan, programmes: programme || null };
}

async function getPeriodsForPlan(planId: string): Promise<PeriodRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("payment_periods")
    .select("*")
    .eq("payment_plan_id", planId)
    .order("period_index", { ascending: true });
  if (error) throw new Error(`getPeriodsForPlan failed: ${error.message}`);
  return data as PeriodRow[];
}

function toApiPeriod(p: PeriodRow) {
  return {
    periodLabel: p.period_label,
    dueDate: p.due_date,
    amountDue: Number(p.amount_due),
    amountPaid: Number(p.amount_paid),
    status: p.status,
  };
}

function monthsBetween(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 30)));
}

/** GET /payments/summary — every field matches PaymentPlanSummary.fromJson() exactly. */
export async function getSummaryForStudent(studentRowId: string) {
  const plan = await getActivePlanForStudent(studentRowId);
  const periods = await getPeriodsForPlan(plan.id as string);

  const amountPaid = periods.reduce((sum, p) => sum + Number(p.amount_paid), 0);
  const totalAmount = Number(plan.total_amount);
  const outstandingBalance = totalAmount - amountPaid;
  const progressPercent = totalAmount > 0 ? (amountPaid / totalAmount) * 100 : 0;

  const today = new Date().toISOString().slice(0, 10);
  const nextPeriod = periods.find((p) => p.status !== "paid" && p.due_date >= today) || periods.find((p) => p.status !== "paid") || null;

  let daysRemaining: number | null = null;
  if (nextPeriod) {
    const due = new Date(nextPeriod.due_date);
    const now = new Date();
    daysRemaining = Math.max(0, Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
  }

  const programme = plan.programmes;
  const programmeDurationMonths = programme ? Math.round(Number(programme.duration_years) * 12) : 0;
  const planDurationMonths = monthsBetween(plan.plan_start_date as string, plan.plan_end_date as string);

  return {
    plan: {
      frequency: plan.frequency as Frequency,
      semester: plan.label as string, // "label" internally ("Semester 1"), "semester" on the wire — matches Java field name
      academicSession: `${new Date(plan.plan_start_date as string).getFullYear()}/${new Date(plan.plan_end_date as string).getFullYear()}`,
      planDurationMonths,
      totalAmount,
    },
    programmeDurationMonths,
    amountPaid,
    outstandingBalance,
    progressPercent,
    daysRemaining,
    nextPeriod: nextPeriod ? toApiPeriod(nextPeriod) : null,
    periods: periods.map(toApiPeriod),
  };
}

/** GET /payments/options — server-generates the "1 Month / 2 Months..."
 *  chips, capped at what's actually still unpaid (spec sections 9, 20-22:
 *  "Only display periods that remain unpaid/eligible"). */
export async function getPayableOptionsForStudent(studentRowId: string) {
  const plan = await getActivePlanForStudent(studentRowId);
  const periods = await getPeriodsForPlan(plan.id as string);
  const unpaid = periods.filter((p) => p.status !== "paid");

  const unitLabel: Record<Frequency, (n: number) => string> = {
    daily: (n) => (n === 1 ? "1 Day" : `${n} Days`),
    weekly: (n) => (n === 1 ? "1 Week" : `${n} Weeks`),
    monthly: (n) => (n === 1 ? "1 Month" : `${n} Months`),
    semester: () => "Full Semester",
  };

  const options = [];
  let cumulativeAmount = 0;
  const maxOptions = plan.frequency === "semester" ? 1 : Math.min(unpaid.length, 4); // cap at 4 chips, matches mockup

  for (let i = 0; i < maxOptions; i++) {
    const outstanding = Number(unpaid[i].amount_due) - Number(unpaid[i].amount_paid);
    cumulativeAmount += outstanding;
    options.push({
      periodsCovered: i + 1,
      label: unitLabel[plan.frequency as Frequency](i + 1),
      amount: cumulativeAmount,
    });
  }

  return options;
}

/** The other half of "never trust the client" — every initiate call runs
 *  through this before anything else happens. */
export async function validateRequestedAmount(studentRowId: string, requestedAmount: number) {
  const summary = await getSummaryForStudent(studentRowId);
  if (requestedAmount <= 0) return { valid: false as const, reason: "Amount must be greater than zero." };
  if (requestedAmount > summary.outstandingBalance) {
    return { valid: false as const, reason: `Amount exceeds outstanding balance of ${summary.outstandingBalance}.` };
  }
  const MINIMUM_PARTIAL_AMOUNT = 100;
  const periodAmount = summary.plan.totalAmount / summary.periods.length;
  const isWholePeriodMultiple = Math.abs(requestedAmount % periodAmount) < 0.01;
  if (!isWholePeriodMultiple && requestedAmount < MINIMUM_PARTIAL_AMOUNT) {
    return {
      valid: false as const,
      reason: `Partial payments must be at least ${MINIMUM_PARTIAL_AMOUNT}, or a whole multiple of ${periodAmount}.`,
    };
  }
  return { valid: true as const };
}

function allocateAmountAcrossPeriods(periods: PeriodRow[], amount: number) {
  let remaining = amount;
  const updates: { id: string; newAmountPaid: number; newStatus: string; applied: number }[] = [];
  for (const p of periods) {
    if (remaining <= 0) break;
    const outstanding = Number(p.amount_due) - Number(p.amount_paid);
    if (outstanding <= 0) continue;
    const apply = Math.min(outstanding, remaining);
    const newAmountPaid = Number(p.amount_paid) + apply;
    const newStatus = newAmountPaid >= Number(p.amount_due) ? "paid" : "due";
    updates.push({ id: p.id, newAmountPaid, newStatus, applied: apply });
    remaining -= apply;
  }
  return { updates, leftover: remaining };
}

async function nextReceiptNumber(): Promise<string> {
  const supabase = getSupabase();
  const year = new Date().getFullYear();
  const { count } = await supabase
    .from("receipts")
    .select("id", { count: "exact", head: true })
    .like("receipt_number", `MTEC/REC/${year}/%`);
  return `MTEC/REC/${year}/${String((count || 0) + 1).padStart(5, "0")}`;
}

/** Generates the human-readable payment reference, e.g. "MTEC-2026-0001-P01".
 *  FIXED: student_id is hyphen-delimited ("MTEC-CS-2026-0001"), not
 *  slash-delimited — the old .split("/").pop() found no "/" and silently
 *  returned the entire student_id unchanged, producing broken double-
 *  prefixed references like "MTEC-2026-MTEC-CS-2026-0001-P01" (confirmed
 *  live during testing). Splitting on "-" correctly extracts just the
 *  trailing sequence number. Exported so the webhook can generate a
 *  reference for recurrent payments, which arrive without a pre-created
 *  submission. */
export async function generateMtecReference(studentRowId: string): Promise<string> {
  const supabase = getSupabase();
  const { data: student } = await supabase.from("students").select("student_id, academic_year").eq("id", studentRowId).single();
  const studentNumber = (student?.student_id as string)?.split("-").pop() || "00000";
  const year = student?.academic_year || String(new Date().getFullYear());
  const { count } = await supabase
    .from("payment_submissions")
    .select("id", { count: "exact", head: true })
    .like("mtec_reference", `MTEC-${year}-${studentNumber}-%`);
  const seq = String((count || 0) + 1).padStart(2, "0");
  return `MTEC-${year}-${studentNumber}-P${seq}`;
}

/** Finalizes a payment — allocates across periods, marks the submission
 *  verified, writes a receipt. Called by manual finance verification AND
 *  by the Monime webhook — one code path for "money confirmed," whoever
 *  confirmed it. */
export async function finalizeVerifiedPayment(submissionId: string, verifiedBy: string) {
  const supabase = getSupabase();

  const { data: submission, error: subError } = await supabase
    .from("payment_submissions").select("*").eq("id", submissionId).single();
  if (subError) throw new Error(`finalizeVerifiedPayment fetch failed: ${subError.message}`);
  if (submission.status === "verified") return { alreadyProcessed: true };

  const periods = await getPeriodsForPlan(submission.payment_plan_id as string);
  const { updates, leftover } = allocateAmountAcrossPeriods(periods, Number(submission.amount));

  for (const u of updates) {
    await supabase.from("payment_periods").update({ amount_paid: u.newAmountPaid, status: u.newStatus }).eq("id", u.id);
  }

  await supabase.from("payment_submissions").update({
    status: "verified", verified_by: verifiedBy, verified_at: new Date().toISOString(),
  }).eq("id", submissionId);

  const { data: student } = await supabase
    .from("students").select("student_id, full_name, programme")
    .eq("id", submission.student_row_id).single();

  const previousBalance = periods.reduce((s, p) => s + (Number(p.amount_due) - Number(p.amount_paid)), 0);
  await supabase.from("receipts").insert({
    receipt_number: await nextReceiptNumber(),
    student_row_id: submission.student_row_id,
    student_id_number: student?.student_id,
    student_name: student?.full_name,
    programme: student?.programme,
    amount: submission.amount,
    method: submission.method === "monime" ? "monime" : "bank",
    received_by: verifiedBy,
    previous_balance: previousBalance,
    new_balance: previousBalance - Number(submission.amount) + leftover,
  });

  if (leftover > 0) {
    console.warn(`[paymentPlanService] Submission ${submissionId} had ${leftover} leftover after allocation.`);
  }
  return { alreadyProcessed: false, leftover };
}

export async function rejectSubmission(submissionId: string, reason: string) {
  const supabase = getSupabase();
  await supabase.from("payment_submissions").update({ status: "rejected", rejection_reason: reason }).eq("id", submissionId);
}

/** Called from the webhook's payment_code.expired handler. Only touches a
 *  submission that's still "pending" — if it's already verified (a
 *  completed event arrived first or raced ahead of the expiry event) or
 *  already rejected/failed, this is a no-op, which is what makes it safe
 *  to call without a separate event-id idempotency check: re-delivering
 *  the same expired event just re-runs a query that changes nothing the
 *  second time. */
export async function expireSubmission(submissionId: string) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("payment_submissions")
    .update({ status: "failed", rejection_reason: "Payment code expired before it was redeemed." })
    .eq("id", submissionId)
    .eq("status", "pending");
  if (error) throw new Error(`expireSubmission failed: ${error.message}`);
}

/** POST /payments/initiate — creates the submission; for Monime, the
 *  route layer creates the actual Payment Code afterward. */
export async function createSubmission(studentRowId: string, amount: number, method: SubmissionMethod) {
  const plan = await getActivePlanForStudent(studentRowId);
  const mtecReference = await generateMtecReference(studentRowId);

  const supabase = getSupabase();
  const { data: submission, error } = await supabase
    .from("payment_submissions")
    .insert({
      mtec_reference: mtecReference,
      payment_plan_id: plan.id,
      student_row_id: studentRowId,
      amount,
      method,
      status: "pending",
    })
    .select()
    .single();
  if (error) throw new Error(`createSubmission failed: ${error.message}`);
  return submission;
}

/** GET /payments/status/:reference — internal status names are more
 *  descriptive (verified/rejected/under_review) than what the Android app
 *  needs; this is the translation boundary, not a schema change. */
export async function getStatusForReference(studentRowId: string, mtecReference: string) {
  const supabase = getSupabase();
  const { data: submission, error } = await supabase
    .from("payment_submissions")
    .select("*")
    .eq("mtec_reference", mtecReference)
    .eq("student_row_id", studentRowId) // a student can only check their own submissions
    .single();
  if (error || !submission) return { status: "failed" as const };

  if (submission.status === "verified") return { status: "successful" as const };
  if (submission.status === "rejected" || submission.status === "failed") return { status: "failed" as const };
  return { status: "pending" as const };
}

export async function attachProviderReference(studentRowId: string, mtecReference: string, providerReference: string) {
  const supabase = getSupabase();
  const { data: submission, error: findError } = await supabase
    .from("payment_submissions")
    .select("id")
    .eq("mtec_reference", mtecReference)
    .eq("student_row_id", studentRowId)
    .single();
  if (findError || !submission) return { success: false as const, reason: "Payment reference not found." };

  const { error } = await supabase
    .from("payment_submissions")
    .update({ provider_reference: providerReference, status: "under_review" })
    .eq("id", submission.id);
  if (error) {
    if (error.code === "23505") {
      return { success: false as const, reason: "This reference has already been used for another payment." };
    }
    throw new Error(`attachProviderReference failed: ${error.message}`);
  }
  return { success: true as const, submissionId: submission.id as string };
}




// ---------------------------------------------------------------------
// Recurrent (Watu-style monthly) payment code
// ---------------------------------------------------------------------

/** Returns the amount for the student's next unpaid period — a
 *  recurrent Monime code must have one fixed amount per redemption. */
async function getNextRecurrentPaymentAmount(studentRowId: string): Promise<number> {
  const plan = await getActivePlanForStudent(studentRowId);
  const periods = await getPeriodsForPlan(plan.id as string);
  const unpaid = periods.filter((p) => p.status !== "paid");
  if (unpaid.length === 0) throw new Error("No unpaid payment period exists.");
  const next = unpaid[0];
  return Number(next.amount_due) - Number(next.amount_paid);
}

function monthsForPlan(plan: { plan_start_date: string; plan_end_date: string }): number {
  const start = new Date(plan.plan_start_date);
  const end = new Date(plan.plan_end_date);
  return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 30)));
}

/** Gets the plan's existing recurrent code or creates one. Deliberately
 *  NOT tied to payment_submissions — one recurrent code can produce many
 *  submissions over the life of the plan (one per monthly redemption):
 *
 *    paymentCode
 *       ├── payment 1 -> submission 1
 *       ├── payment 2 -> submission 2
 *       └── payment 3 -> submission 3
 */
export async function ensureRecurrentPaymentCode(studentRowId: string) {
  const supabase = getSupabase();
  const plan = await getActivePlanForStudent(studentRowId);

  const { data: student, error: studentError } = await supabase
    .from("students").select("phone, full_name").eq("id", studentRowId).single();
  if (studentError || !student) {
    throw new Error(`Could not load student: ${studentError?.message || "student not found"}`);
  }

  const monthlyAmount = await getNextRecurrentPaymentAmount(studentRowId);

  // Reuse an existing, still-valid recurrent code rather than creating a
  // new one every time the student opens the "Pay Monthly" screen.
  if (plan.monime_recurrent_code_id && plan.monime_recurrent_ussd_code && plan.monime_recurrent_expire_time) {
    const expiry = new Date(plan.monime_recurrent_expire_time as string);
    if (expiry.getTime() > Date.now()) {
      return {
        codeId: plan.monime_recurrent_code_id as string,
        ussdCode: plan.monime_recurrent_ussd_code as string,
        expireTime: plan.monime_recurrent_expire_time as string,
        amount: monthlyAmount,
        reused: true,
      };
    }
  }

  const months = monthsForPlan(plan as { plan_start_date: string; plan_end_date: string });
  // UNCONFIRMED duration syntax — see the note in monimeClient.ts.
  const duration = `${months}mo`;

  const recurrentCode = await createRecurrentPaymentCode({
    amountLeones: monthlyAmount,
    customerName: student.full_name as string,
    internalReference: `MTEC-PLAN-${plan.id}`,
    duration,
    recurrentPaymentTarget: { type: "count", value: months },
    // No phone restriction, so a parent/guardian can redeem too (subject
    // to Monime account configuration actually allowing it).
  });

  const { error: updateError } = await supabase
    .from("payment_plans")
    .update({
      monime_recurrent_code_id: recurrentCode.paymentCodeId,
      monime_recurrent_ussd_code: recurrentCode.ussdCode,
      monime_recurrent_expire_time: recurrentCode.expireTime,
      monime_recurrent_amount: monthlyAmount,
    })
    .eq("id", plan.id);
  if (updateError) throw new Error(`Failed to save recurrent payment code: ${updateError.message}`);

  return {
    codeId: recurrentCode.paymentCodeId,
    ussdCode: recurrentCode.ussdCode,
    expireTime: recurrentCode.expireTime,
    amount: monthlyAmount,
    reused: false,
  };
}

// ---------------------------------------------------------------------
// GET /payments/transactions — matches image 1's Transactions screen.
// Label nuance worth calling out: a verified Monime payment shows
// "Successful" (it was auto-confirmed by Monime itself), while a
// verified manual payment (Orange Money Agent, Cash, etc.) shows
// "Verified" (a human finance officer confirmed it) — same underlying
// DB status ("verified"), different label depending on how it got there,
// because that distinction is genuinely meaningful to a student reading
// their history.
// ---------------------------------------------------------------------

const METHOD_DISPLAY_NAME: Record<SubmissionMethod, string> = {
  monime: "Monime",
  orange_money: "Orange Money",
  orange_money_agent: "Orange Money Agent",
  cash_deposit: "Cash Deposit",
  alternative_account: "Bank Transfer",
};

function displayStatus(status: string, method: SubmissionMethod): { label: string; state: "success" | "pending" | "failed" } {
  if (status === "verified") {
    return method === "monime" ? { label: "Successful", state: "success" } : { label: "Verified", state: "success" };
  }
  if (status === "under_review") return { label: "Under review", state: "pending" };
  if (status === "pending") return { label: "Pending", state: "pending" };
  return { label: "Failed", state: "failed" }; // rejected or failed
}

export async function getTransactionsForStudent(studentRowId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("payment_submissions")
    .select("*")
    .eq("student_row_id", studentRowId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`getTransactionsForStudent failed: ${error.message}`);

  return (data || []).map((s) => {
    const method = s.method as SubmissionMethod;
    const statusInfo = displayStatus(s.status, method);
    return {
      mtecReference: s.mtec_reference,
      date: s.created_at,
      amount: Number(s.amount),
      methodLabel: METHOD_DISPLAY_NAME[method] || method,
      method,
      statusLabel: statusInfo.label,
      statusState: statusInfo.state,
      providerReference: s.provider_reference,
      rejectionReason: s.rejection_reason,
    };
  });
}
<<<<<<< HEAD
>>>>>>> 36cdb6a (Initial commit)
=======
>>>>>>> 83cdb68 (add update)
