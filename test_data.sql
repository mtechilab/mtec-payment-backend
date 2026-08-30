-- Replace REAL_PHONE with your actual Orange Money number (format 23276XXXXXXX)
-- before running this in Supabase's SQL Editor. Amount is set small (NLe 100
-- per period) for a real-money test — adjust if you want smaller.

with prog as (
  insert into programmes (id, name, department, duration_years)
  values (gen_random_uuid(), 'Diploma in Computer Science & Digital Innovation', 'ICT', 2)
  on conflict (name) do update set department = excluded.department
  returning id
),
pin as (
  insert into application_pins (id, pin, academic_year, intake, status, source, applicant_name, applicant_phone, programme_interest)
  values (gen_random_uuid(), 'MTEC-LIVE-TEST', '2026', 'Sept', 'used', 'monime_payment', 'Live Test Student', 'REAL_PHONE', 'Diploma in Computer Science & Digital Innovation')
  returning id
),
app as (
  insert into applications (id, application_number, pin_id, status, full_name, programme, academic_year)
  select gen_random_uuid(), 'MTEC/APP/2026/LIVETEST', pin.id, 'accepted', 'Live Test Student', 'Diploma in Computer Science & Digital Innovation', '2026'
  from pin
  returning id
),
student as (
  insert into students (id, student_id, student_pin, application_id, full_name, phone, programme, academic_year, first_login_complete)
  select gen_random_uuid(), 'MTEC-2026-LIVETEST', '111111', app.id, 'Live Test Student', 'REAL_PHONE', 'Diploma in Computer Science & Digital Innovation', '2026', true
  from app
  returning id
),
plan as (
  insert into payment_plans (id, student_row_id, programme_id, label, frequency, period_amount, total_amount, plan_start_date, plan_end_date)
  select gen_random_uuid(), student.id, prog.id, 'Semester 1', 'monthly', 100, 400, '2026-09-01', '2026-12-31'
  from student, prog
  returning id
)
insert into payment_periods (payment_plan_id, period_label, period_index, due_date, amount_due, amount_paid, status)
select plan.id, label, idx, due::date, 100, 0, status
from plan,
  (values ('September 2026', 1, '2026-09-01', 'due'),
          ('October 2026', 2, '2026-10-01', 'upcoming'),
          ('November 2026', 3, '2026-11-01', 'upcoming'),
          ('December 2026', 4, '2026-12-01', 'upcoming')
  ) as periods(label, idx, due, status);

-- Confirm it worked:
select s.student_id, s.full_name, s.phone, pp.label, pp.total_amount
from students s
join payment_plans pp on pp.student_row_id = s.id
where s.student_id = 'MTEC-2026-LIVETEST';
