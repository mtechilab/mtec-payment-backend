-- Run this in the Supabase SQL Editor for the mtecdigital project.
-- Adds the admin_accounts table the new Admin Dashboard login needs.
-- No accounts are created by this script — the first one is created via
-- a one-time call to POST /admin/setup after this table exists.

create table admin_accounts (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  full_name text not null,
  role text not null default 'administrator',
  created_at timestamptz not null default now()
);

alter table admin_accounts enable row level security;

-- Server-only table (service role bypasses RLS) — no anon policy, same
-- pattern as processed_webhook_events. Nothing in the app should ever
-- read/write this table with the anon key.
