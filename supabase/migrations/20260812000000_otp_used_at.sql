-- Single-use OTP consumption markers.
--
-- Before this migration, signup_otp/admin_otp consumption was a
-- verify-then-delete sequence with a race window: two parallel requests
-- holding the same code could both pass the check and both finish. The
-- used_at column makes consumption an atomic claim (UPDATE ... WHERE
-- used_at IS NULL), so only the request that flips it to now() wins.

alter table public.signup_otp
  add column if not exists used_at timestamptz;

alter table public.admin_otp
  add column if not exists used_at timestamptz;