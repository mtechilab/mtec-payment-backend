-- =====================================================================
-- Migration: recurrent ("Pay Monthly") Monime payment code support
-- Run this once against your live Supabase database (SQL Editor or
-- `supabase db push` if you've adopted migration tooling).
-- Safe to run multiple times — every statement is idempotent.
-- =====================================================================

ALTER TABLE payment_submissions ADD COLUMN IF NOT EXISTS monime_payment_code_id TEXT;
ALTER TABLE payment_submissions ADD COLUMN IF NOT EXISTS monime_payment_id TEXT;
ALTER TABLE payment_submissions ADD COLUMN IF NOT EXISTS monime_transaction_reference TEXT;

-- Prevents the same individual Monime payment (one redemption of a
-- recurrent code) from being processed into two submissions.
CREATE UNIQUE INDEX IF NOT EXISTS payment_submissions_monime_payment_id_unique
ON payment_submissions(monime_payment_id)
WHERE monime_payment_id IS NOT NULL;

ALTER TABLE payment_plans ADD COLUMN IF NOT EXISTS monime_recurrent_code_id TEXT;
ALTER TABLE payment_plans ADD COLUMN IF NOT EXISTS monime_recurrent_ussd_code TEXT;
ALTER TABLE payment_plans ADD COLUMN IF NOT EXISTS monime_recurrent_expire_time TIMESTAMPTZ;
ALTER TABLE payment_plans ADD COLUMN IF NOT EXISTS monime_recurrent_amount NUMERIC;

-- Refresh PostgREST's schema cache so the new columns are visible to the
-- API immediately, without waiting for its periodic refresh.
NOTIFY pgrst, 'reload schema';
