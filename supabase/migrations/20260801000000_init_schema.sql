-- AnieLab initial schema: users, projects, contributions, auth_challenges
-- Owned by anielab-backend. Frontend reads via anon key + RLS.

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  stellar_address text not null unique,
  display_name text,
  avatar_ipfs_cid text,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  description text,
  cover_ipfs_cid text,
  contract_id text unique,
  funding_goal bigint,
  status text not null default 'draft' check (status in ('draft', 'active', 'funded', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.contributions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null,
  share_pct numeric(5, 2) not null check (share_pct > 0 and share_pct <= 100),
  ipfs_cid text,
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);

create table if not exists public.auth_challenges (
  id uuid primary key default gen_random_uuid(),
  stellar_address text not null,
  nonce text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- RLS ---------------------------------------------------------------------

alter table public.users enable row level security;
alter table public.projects enable row level security;
alter table public.contributions enable row level security;
alter table public.auth_challenges enable row level security;

-- users: readable by everyone; writable only by the matching user
create policy "users are publicly readable" on public.users
  for select using (true);

create policy "users insert own row" on public.users
  for insert with check (auth.uid() = id);

create policy "users update own row" on public.users
  for update using (auth.uid() = id);

-- projects: readable by everyone; owner-only writes
create policy "projects are publicly readable" on public.projects
  for select using (true);

create policy "owners insert projects" on public.projects
  for insert with check (auth.uid() = owner_id);

create policy "owners update projects" on public.projects
  for update using (auth.uid() = owner_id);

create policy "owners delete projects" on public.projects
  for delete using (auth.uid() = owner_id);

-- contributions: readable by everyone; contributors manage their own rows
create policy "contributions are publicly readable" on public.contributions
  for select using (true);

create policy "contributors insert own rows" on public.contributions
  for insert with check (auth.uid() = user_id);

create policy "contributors update own rows" on public.contributions
  for update using (auth.uid() = user_id);

create policy "contributors delete own rows" on public.contributions
  for delete using (auth.uid() = user_id);

-- auth_challenges: only the backend (service role) touches this table
create policy "backend only" on public.auth_challenges
  for all using (false) with check (false);
