-- Admin panel authentication: hashed panel passwords + OTP verification.
--
-- admin_credentials: one row per admin user. password_hash uses scrypt
-- (format scrypt:<saltHex>:<hashHex>), produced by the backend.
-- admin_otp: single-use one-time codes issued at panel login. code_hash
-- is the same scrypt format; codes expire after 5 minutes and allow at
-- most 5 verification attempts.
--
-- Both tables have RLS enabled with NO policies, so only the service
-- role key (used by the backend) can read or write them.

create table if not exists public.admin_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_otp (
  user_id uuid primary key references public.admin_credentials(user_id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  last_sent_at timestamptz
);

alter table public.admin_credentials enable row level security;

alter table public.admin_otp enable row level security;
