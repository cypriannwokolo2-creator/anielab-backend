-- AnieLab migration: signup email verification via Brevo-delivered OTP.
--
-- signup_otp: one-time codes issued when a brand-new user creates an account.
-- Mirrors admin_otp: scrypt-hashed code (format scrypt:<saltHex>:<hashHex>),
-- 5-minute expiry, at most 5 verification attempts. Keyed by email so the
-- verify step doesn't need to know the auth user id, and the user_id column
-- links the pending signup to the auth.users row created by the backend.
--
-- RLS enabled with NO policies, so only the service role (backend) can
-- read or write it.

create table if not exists public.signup_otp (
  email text primary key,
  user_id uuid references auth.users(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  last_sent_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.signup_otp enable row level security;