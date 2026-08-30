import { getSupabase } from "../db/supabaseClient.js";
async function getActivePlanForStudent(studentRowId) {
    const supabase = getSupabase();
    const { data: plan, error } = await supabase
        .from("payment_plans")
        .select("*")
        .eq("student_row_id", studentRowId)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error)
        throw new Error(`getActivePlanForStudent failed: ${error.message}`);
    if (!plan)
        throw new Error("No active payment plan found for this student.");
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
async function getPeriodsForPlan(planId) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from("payment_periods")
        .select("*")
        .eq("payment_plan_id", planId)
        .order("period_index", { ascending: true });
    if (error)
        throw new Error(`getPeriodsForPlan failed: ${error.message}`);
    return data;
}
function toApiPeriod(p) {
    return {
        periodLabel: p.period_label,
        dueDate: p.due_date,
        amountDue: Number(p.amount_due),
        amountPaid: Number(p.amount_paid),
        status: p.status,
    };
}
function monthsBetween(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    return Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 30)));
}
/** GET /payments/summary — every field matches PaymentPlanSummary.fromJson() exactly. */
export async function getSummaryForStudent(studentRowId) {
    const plan = await getActivePlanForStudent(studentRowId);
    const periods = await getPeriodsForPlan(plan.id);
    const amountPaid = periods.reduce((sum, p) => sum + Number(p.amount_paid), 0);
    const totalAmount = Number(plan.total_amount);
    const outstandingBalance = totalAmount - amountPaid;
    const progressPercent = totalAmount > 0 ? (amountPaid / totalAmount) * 100 : 0;
    const today = new Date().toISOString().slice(0, 10);
    const nextPeriod = periods.find((p) => p.status !== "paid" && p.due_date >= today) || periods.find((p) => p.status !== "paid") || null;
    let daysRemaining = null;
    if (nextPeriod) {
        const due = new Date(nextPeriod.due_date);
        const now = new Date();
        daysRemaining = Math.max(0, Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    }
    const programme = plan.programmes;
    const programmeDurationMonths = programme ? Math.round(Number(programme.duration_years) * 12) : 0;
    const planDurationMonths = monthsBetween(plan.plan_start_date, plan.plan_end_date);
    return {
        plan: {
            frequency: plan.frequency,
            semester: plan.label, // "label" internally ("Semester 1"), "semester" on the wire — matches Java field name
            academicSession: `${new Date(plan.plan_start_date).getFullYear()}/${new Date(plan.plan_end_date).getFullYear()}`,
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
export async function getPayableOptionsForStudent(studentRowId) {
    const plan = await getActivePlanForStudent(studentRowId);
    const periods = await getPeriodsForPlan(plan.id);
    const unpaid = periods.filter((p) => p.status !== "paid");
    const unitLabel = {
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
            label: unitLabel[plan.frequency](i + 1),
            amount: cumulativeAmount,
        });
    }
    return options;
}
/** The other half of "never trust the client" — every initiate call runs
 *  through this before anything else happens. */
export async function validateRequestedAmount(studentRowId, requestedAmount) {
    const summary = await getSummaryForStudent(studentRowId);
    if (requestedAmount <= 0)
        return { valid: false, reason: "Amount must be greater than zero." };
    if (requestedAmount > summary.outstandingBalance) {
        return { valid: false, reason: `Amount exceeds outstanding balance of ${summary.outstandingBalance}.` };
    }
    const MINIMUM_PARTIAL_AMOUNT = 100;
    const periodAmount = summary.plan.totalAmount / summary.periods.length;
    const isWholePeriodMultiple = Math.abs(requestedAmount % periodAmount) < 0.01;
    if (!isWholePeriodMultiple && requestedAmount < MINIMUM_PARTIAL_AMOUNT) {
        return {
            valid: false,
            reason: `Partial payments must be at least ${MINIMUM_PARTIAL_AMOUNT}, or a whole multiple of ${periodAmount}.`,
        };
    }
    return { valid: true };
}
function allocateAmountAcrossPeriods(periods, amount) {
    let remaining = amount;
    const updates = [];
    for (const p of periods) {
        if (remaining <= 0)
            break;
        const outstanding = Number(p.amount_due) - Number(p.amount_paid);
        if (outstanding <= 0)
            continue;
        const apply = Math.min(outstanding, remaining);
        const newAmountPaid = Number(p.amount_paid) + apply;
        const newStatus = newAmountPaid >= Number(p.amount_due) ? "paid" : "due";
        updates.push({ id: p.id, newAmountPaid, newStatus, applied: apply });
        remaining -= apply;
    }
    return { updates, leftover: remaining };
}
async function nextReceiptNumber() {
    const supabase = getSupabase();
    const year = new Date().getFullYear();
    const { count } = await supabase
        .from("receipts")
        .select("id", { count: "exact", head: true })
        .like("receipt_number", `MTEC/REC/${year}/%`);
    return `MTEC/REC/${year}/${String((count || 0) + 1).padStart(5, "0")}`;
}
async function generateMtecReference(studentRowId) {
    const supabase = getSupabase();
    const { data: student } = await supabase.from("students").select("student_id, academic_year").eq("id", studentRowId).single();
    const studentNumber = student?.student_id?.split("/").pop() || "00000";
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
export async function finalizeVerifiedPayment(submissionId, verifiedBy) {
    const supabase = getSupabase();
    const { data: submission, error: subError } = await supabase
        .from("payment_submissions").select("*").eq("id", submissionId).single();
    if (subError)
        throw new Error(`finalizeVerifiedPayment fetch failed: ${subError.message}`);
    if (submission.status === "verified")
        return { alreadyProcessed: true };
    const periods = await getPeriodsForPlan(submission.payment_plan_id);
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
export async function rejectSubmission(submissionId, reason) {
    const supabase = getSupabase();
    await supabase.from("payment_submissions").update({ status: "rejected", rejection_reason: reason }).eq("id", submissionId);
}
/** POST /payments/initiate — creates the submission; for Monime, the
 *  route layer creates the actual Payment Code afterward. */
export async function createSubmission(studentRowId, amount, method) {
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
    if (error)
        throw new Error(`createSubmission failed: ${error.message}`);
    return submission;
}
/** GET /payments/status/:reference — internal status names are more
 *  descriptive (verified/rejected/under_review) than what the Android app
 *  needs; this is the translation boundary, not a schema change. */
export async function getStatusForReference(studentRowId, mtecReference) {
    const supabase = getSupabase();
    const { data: submission, error } = await supabase
        .from("payment_submissions")
        .select("*")
        .eq("mtec_reference", mtecReference)
        .eq("student_row_id", studentRowId) // a student can only check their own submissions
        .single();
    if (error || !submission)
        return { status: "failed" };
    if (submission.status === "verified")
        return { status: "successful" };
    if (submission.status === "rejected" || submission.status === "failed")
        return { status: "failed" };
    return { status: "pending" };
}
export async function attachProviderReference(studentRowId, mtecReference, providerReference) {
    const supabase = getSupabase();
    const { data: submission, error: findError } = await supabase
        .from("payment_submissions")
        .select("id")
        .eq("mtec_reference", mtecReference)
        .eq("student_row_id", studentRowId)
        .single();
    if (findError || !submission)
        return { success: false, reason: "Payment reference not found." };
    const { error } = await supabase
        .from("payment_submissions")
        .update({ provider_reference: providerReference, status: "under_review" })
        .eq("id", submission.id);
    if (error) {
        if (error.code === "23505") {
            return { success: false, reason: "This reference has already been used for another payment." };
        }
        throw new Error(`attachProviderReference failed: ${error.message}`);
    }
    return { success: true, submissionId: submission.id };
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
const METHOD_DISPLAY_NAME = {
    monime: "Monime",
    orange_money: "Orange Money",
    orange_money_agent: "Orange Money Agent",
    cash_deposit: "Cash Deposit",
    alternative_account: "Bank Transfer",
};
function displayStatus(status, method) {
    if (status === "verified") {
        return method === "monime" ? { label: "Successful", state: "success" } : { label: "Verified", state: "success" };
    }
    if (status === "under_review")
        return { label: "Under review", state: "pending" };
    if (status === "pending")
        return { label: "Pending", state: "pending" };
    return { label: "Failed", state: "failed" }; // rejected or failed
}
export async function getTransactionsForStudent(studentRowId) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from("payment_submissions")
        .select("*")
        .eq("student_row_id", studentRowId)
        .order("created_at", { ascending: false });
    if (error)
        throw new Error(`getTransactionsForStudent failed: ${error.message}`);
    return (data || []).map((s) => {
        const method = s.method;
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
