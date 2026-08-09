-- AnieLab migration 4: user roles
-- Allows users to select up to 3 roles during signup.
-- Roles are stored as a text array (e.g. '{"writer","illustrator"}').

alter table public.users
  add column if not exists roles text[] not null default '{}';

-- Index for finding users by role (GIN index on array).
create index if not exists idx_users_roles on public.users using gin (roles);

-- Constraint: max 3 roles per user.
alter table public.users
  add constraint users_max_roles check (array_length(roles, 1) is null or array_length(roles, 1) <= 3);
