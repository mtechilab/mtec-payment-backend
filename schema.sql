-- =====================================================================
-- MTeC Digital Campus — Supabase schema
-- Run this in the Supabase SQL Editor (or via `supabase db push`).
-- Mirrors src/types/index.ts field-for-field so the client/server code
-- maps onto these tables without translation logic.
-- =====================================================================

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ---- System settings (single row) ----------------------------------

create table system_settings (
  id int primary key default 1,
  application_fee numeric not null default 100,
  currency text not null default 'NLe',
  active_academic_year text not null default '2026',
  active_intake text not null default 'September 2026',
  constraint single_row check (id = 1)
);
insert into system_settings (id) values (1) on conflict do nothing;

-- ---- Payment transactions -------------------------------------------

create table payment_transactions (
  id uuid primary key default gen_random_uuid(),
  external_reference text,
  amount numeric not null,
  currency text not null default 'NLe',
  purpose text not null default 'application_fee',
  method text not null check (method in ('monime', 'cash', 'bank', 'other')),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---- Application PINs -------------------------------------------------

create table application_pins (
  id uuid primary key default gen_random_uuid(),
  pin text not null unique,
  password_hash text,
  academic_year text not null,
  intake text not null,
  status text not null default 'generated'
    check (status in ('generated', 'active', 'used', 'expired', 'revoked')),
  source text not null check (source in ('monime_payment', 'campus_sale')),
  applicant_name text not null,
  applicant_phone text not null,
  applicant_email text,
  programme_interest text not null,
  payment_transaction_id uuid references payment_transactions(id),
  issued_by text,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  used_at timestamptz
);
create index idx_application_pins_pin on application_pins (pin);

-- ---- Applications -------------------------------------------------

create table applications (
  id uuid primary key default gen_random_uuid(),
  application_number text unique,
  pin_id uuid not null references application_pins(id),
  status text not null default 'draft'
    check (status in ('draft','submitted','under_review','info_required','approved','rejected','offer_issued','accepted')),
  full_name text not null default '',
  other_name text not null default '',
  gender text not null default '',
  date_of_birth text not null default '',
  nationality text not null default 'Sierra Leonean',
  phone text not null default '',
  whatsapp text not null default '',
  email text not null default '',
  address text not null default '',
  district text not null default '',
  city_town text not null default '',
  academic_year text not null default '',
  intake text not null default '',
  programme text not null default '',
  study_mode text not null default 'Full-time',
  education jsonb not null default '[]',
  emergency_contact jsonb not null default '{"name":"","relationship":"","phone":"","address":""}',
  documents jsonb not null default '[]',
  declaration_confirmed boolean not null default false,
  rejection_reason text,
  created_at timestamptz not null default now(),
  submitted_at timestamptz
);
create index idx_applications_pin_id on applications (pin_id);
create index idx_applications_status on applications (status);

-- ---- Offer letters -------------------------------------------------

create table offer_letters (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id),
  student_name text not null,
  application_number text not null,
  programme text not null,
  academic_year text not null,
  admission_conditions text not null,
  fees_amount numeric not null,
  reporting_date text not null,
  authorized_signatory text not null,
  generated_at timestamptz not null default now(),
  acceptance_deadline timestamptz not null
);
create index idx_offer_letters_application_id on offer_letters (application_id);

-- ---- Students -------------------------------------------------

create table students (
  id uuid primary key default gen_random_uuid(),
  student_id text not null unique,
  student_pin text not null,
  password_hash text,
  first_login_complete boolean not null default false,
  application_id uuid not null references applications(id),
  full_name text not null,
  phone text not null,
  email text not null default '',
  programme text not null,
  academic_year text not null,
  level text not null default 'Year 1',
  status text not null default 'active' check (status in ('active','inactive','graduated','withdrawn')),
  created_at timestamptz not null default now()
);
create index idx_students_student_id on students (student_id);

create table acceptance_letters (
  id uuid primary key default gen_random_uuid(),
  student_row_id uuid not null references students(id),
  offer_letter_id uuid not null references offer_letters(id),
  student_id_number text not null,
  generated_at timestamptz not null default now()
);

-- ---- Finance -------------------------------------------------

create table fee_structures (
  programme text primary key,
  registration_fee numeric not null default 500,
  tuition_per_semester numeric not null default 1500
);

create table student_invoices (
  id uuid primary key default gen_random_uuid(),
  student_row_id uuid not null references students(id),
  description text not null,
  amount numeric not null,
  created_at timestamptz not null default now()
);

create table receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_number text not null unique,
  student_row_id uuid not null references students(id),
  student_id_number text not null,
  student_name text not null,
  programme text not null,
  amount numeric not null,
  method text not null check (method in ('cash','bank','monime')),
  date timestamptz not null default now(),
  received_by text not null,
  previous_balance numeric not null,
  new_balance numeric not null
);
create index idx_receipts_student on receipts (student_row_id);

-- ---- Programmes (first-class record — duration lives here, not
-- ---- scattered as a string across applications/students/courses) ------

create table programmes (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  department text not null default '',
  duration_years numeric not null,       -- e.g. 2 — drives "Programme Duration: 2 Years" in the UI
  duration_label text not null default '' -- optional override, e.g. "2 Years" vs "24 Months"
);

-- ---- Payment Plans (Watu-inspired student payment experience) ---------
--
-- Design, matching the spec's "Critical Rules" section:
-- - A payment plan's duration is SEPARATE from programme duration
--   (a plan might cover one semester; the programme spans years).
-- - Frequency is configurable (daily/weekly/monthly/semester), not
--   hardcoded per screen.
-- - The plan generates a fixed schedule of periods up front (so
--   "September: PAID, October: DUE, November: UPCOMING" is just reading
--   rows, never recalculated ad hoc in the UI).
-- - Every payment belongs to exactly one plan period.
-- - Provider references must be unique across ALL payment submissions —
--   enforced with a real unique constraint, not just app-level checking,
--   so a reused Orange Money reference is rejected at the database level
--   even if two requests race each other.

create table payment_plans (
  id uuid primary key default gen_random_uuid(),
  student_row_id uuid not null references students(id),
  programme_id uuid not null references programmes(id),
  label text not null,                  -- e.g. "Semester 1"
  frequency text not null check (frequency in ('daily','weekly','monthly','semester')),
  period_amount numeric not null,       -- amount due per period, e.g. 750 for monthly
  total_amount numeric not null,        -- sum across the whole plan, e.g. 3000
  plan_start_date date not null,
  plan_end_date date not null,
  status text not null default 'active' check (status in ('active','completed','cancelled')),
  created_at timestamptz not null default now()
);
create index idx_payment_plans_student on payment_plans (student_row_id);

-- One row per period in the schedule (September, October, November...),
-- generated when the plan is created — not computed on the fly. This is
-- what "✓ September PAID / ◐ October DUE / ○ November UPCOMING" reads from.
create table payment_periods (
  id uuid primary key default gen_random_uuid(),
  payment_plan_id uuid not null references payment_plans(id),
  period_label text not null,           -- e.g. "September 2026"
  period_index int not null,            -- 1, 2, 3... — display order
  due_date date not null,
  amount_due numeric not null,
  amount_paid numeric not null default 0,
  status text not null default 'upcoming' check (status in ('upcoming','due','overdue','paid')),
  unique (payment_plan_id, period_index)
);
create index idx_payment_periods_plan on payment_periods (payment_plan_id);

-- Every payment attempt — digital (Monime, instant) or manual (Orange
-- Money/Agent/Cash/Alt Account, pending finance verification) — is one
-- row here. This is intentionally separate from `receipts`: a receipt is
-- proof of a CONFIRMED payment; a submission is a claim that may still
-- need verification. A submission becomes a receipt only once verified.
create table payment_submissions (
  id uuid primary key default gen_random_uuid(),
  mtec_reference text not null unique,   -- e.g. MTEC-2026-00125-P02, generated server-side
  payment_plan_id uuid not null references payment_plans(id),
  payment_period_id uuid references payment_periods(id), -- null if covering multiple periods
  student_row_id uuid not null references students(id),
  amount numeric not null,
  method text not null check (method in ('monime','orange_money','orange_money_agent','cash_deposit','alternative_account')),
  provider_reference text,               -- student-entered ref for manual methods; null for Monime until confirmed
  status text not null default 'pending' check (status in ('pending','under_review','verified','rejected','failed')),
  verified_by text,                      -- finance officer name, for manual methods
  verified_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now()
);
create index idx_payment_submissions_plan on payment_submissions (payment_plan_id);
create index idx_payment_submissions_student on payment_submissions (student_row_id);

-- Enforces "Provider references cannot be reused" at the database level —
-- a partial unique index so it only applies where a reference was actually
-- given (Monime submissions may not have one until the webhook fills it in).
create unique index idx_unique_provider_reference
  on payment_submissions (method, provider_reference)
  where provider_reference is not null;

-- ---- Academics -------------------------------------------------

create table courses (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  programme text not null,
  level text not null,
  semester text not null,
  credit_units int not null default 3
);

create table classes (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses(id),
  instructor_name text not null,
  academic_year text not null,
  student_ids uuid[] not null default '{}'
);

create table timetable_slots (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references classes(id),
  day_of_week text not null check (day_of_week in ('Mon','Tue','Wed','Thu','Fri','Sat')),
  start_time text not null,
  end_time text not null,
  room text not null
);

create table attendance_records (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references classes(id),
  student_row_id uuid not null references students(id),
  date date not null,
  mark text not null check (mark in ('present','absent','late','excused')),
  unique (class_id, student_row_id, date)
);

create table assessment_items (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references classes(id),
  name text not null,
  max_score numeric not null,
  weight numeric not null
);

create table marks (
  id uuid primary key default gen_random_uuid(),
  assessment_item_id uuid not null references assessment_items(id),
  class_id uuid not null references classes(id),
  student_row_id uuid not null references students(id),
  score numeric not null,
  unique (assessment_item_id, student_row_id)
);

create table result_batches (
  class_id uuid primary key references classes(id),
  status text not null default 'draft' check (status in ('draft','pending_review','published')),
  sent_back_reason text,
  submitted_at timestamptz,
  published_at timestamptz
);

create table result_audit (
  id uuid primary key default gen_random_uuid(),
  student_row_id uuid not null references students(id),
  class_id uuid not null references classes(id),
  old_score numeric,
  new_score numeric not null,
  changed_by text not null,
  reason text not null,
  timestamp timestamptz not null default now()
);

-- ---- Webhook idempotency (server-side use only) ----------------------

create table processed_webhook_events (
  event_id text primary key,
  processed_at timestamptz not null default now()
);

-- =====================================================================
-- Row Level Security
--
-- TEMPORARY / PERMISSIVE for the current stage of this build: the admin
-- side has no Supabase Auth yet (flagged elsewhere in this project), so
-- these policies allow the anon key broad read/write access needed for
-- the app to function end-to-end right now. THIS IS NOT SAFE FOR A REAL
-- PRODUCTION LAUNCH — before going live, replace these with policies
-- scoped to authenticated staff roles (see the README section on this).
-- =====================================================================

alter table system_settings enable row level security;
alter table payment_transactions enable row level security;
alter table application_pins enable row level security;
alter table applications enable row level security;
alter table offer_letters enable row level security;
alter table students enable row level security;
alter table acceptance_letters enable row level security;
alter table fee_structures enable row level security;
alter table student_invoices enable row level security;
alter table receipts enable row level security;
alter table programmes enable row level security;
alter table payment_plans enable row level security;
alter table payment_periods enable row level security;
alter table payment_submissions enable row level security;
alter table courses enable row level security;
alter table classes enable row level security;
alter table timetable_slots enable row level security;
alter table attendance_records enable row level security;
alter table assessment_items enable row level security;
alter table marks enable row level security;
alter table result_batches enable row level security;
alter table result_audit enable row level security;
alter table processed_webhook_events enable row level security;

do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'system_settings','payment_transactions','application_pins','applications',
      'offer_letters','students','acceptance_letters','fee_structures',
      'student_invoices','receipts','programmes','payment_plans','payment_periods',
      'payment_submissions','courses','classes','timetable_slots',
      'attendance_records','assessment_items','marks','result_batches','result_audit'
    ])
  loop
    execute format(
      'create policy "temp_allow_all_%1$s" on %1$s for all using (true) with check (true);',
      t
    );
  end loop;
end $$;

-- processed_webhook_events is server-only (service role bypasses RLS
-- anyway) — no anon policy needed, so anon has zero access to it.
