-- Dual auth (email + wallet) support:
-- users.id always maps to a Supabase auth.users id, so RLS on auth.uid() and
-- supabase.auth.getUser() work identically for both signup methods.
alter table public.users
  alter column stellar_address drop not null;

alter table public.users
  add column if not exists auth_method text not null default 'email'
  check (auth_method in ('email', 'wallet'));

create index if not exists users_auth_method_idx on public.users (auth_method);
