-- AnieLab migration 3: escrow milestones, pledges, challenges, platform settings
-- Extends the schema to support milestone-gated escrow funding,
-- individual pledge tracking, Creative Sprints, and platform fee management.

-- ── Projects: add escrow tracking ──────────────────────────────────────

alter table public.projects
  add column if not exists platform_fee_bps integer not null default 0,
  add column if not exists total_pledged bigint not null default 0,
  add column if not exists milestone_count integer not null default 0;

-- Expand status check constraint to include completed + cancelled.
alter table public.projects drop constraint if exists projects_status_check;
alter table public.projects add constraint projects_status_check
  check (status in ('draft', 'active', 'funded', 'completed', 'cancelled', 'archived'));

-- ── Milestones table ───────────────────────────────────────────────────

create table if not exists public.milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  pct_bps integer not null check (pct_bps > 0 and pct_bps <= 10000),
  released boolean not null default false,
  sort_order integer not null default 0,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_id, sort_order)
);

-- Index for fetching milestones by project.
create index if not exists idx_milestones_project_id
  on public.milestones(project_id);

-- ── Pledges table ──────────────────────────────────────────────────────

create table if not exists public.pledges (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  backer_address text not null,
  user_id uuid references public.users(id) on delete set null,
  amount bigint not null check (amount > 0),
  fee bigint not null default 0,
  currency text not null default 'USDC',
  tx_hash text,
  created_at timestamptz not null default now()
);

create index if not exists idx_pledges_project_id
  on public.pledges(project_id);
create index if not exists idx_pledges_backer
  on public.pledges(backer_address);

-- ── Challenges (Creative Sprints) ─────────────────────────────────────

create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  theme text,
  prize_pool bigint not null default 0,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'upcoming'
    check (status in ('upcoming', 'active', 'judging', 'completed', 'cancelled')),
  cover_image_key text,
  created_by uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint challenges_dates check (ends_at > starts_at)
);

-- ── Challenge entries ──────────────────────────────────────────────────

create table if not exists public.challenge_entries (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  description text,
  submission_url text,
  cover_image_key text,
  votes integer not null default 0,
  rank integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (challenge_id, user_id)
);

create index if not exists idx_challenge_entries_challenge
  on public.challenge_entries(challenge_id);

-- ── Platform settings (singleton) ──────────────────────────────────────

create table if not exists public.platform_settings (
  id integer primary key default 1 check (id = 1),
  platform_fee_bps integer not null default 500,
  platform_wallet text,
  updated_at timestamptz not null default now()
);

-- Seed default settings row.
insert into public.platform_settings (id) values (1) on conflict do nothing;

-- ── RLS for new tables ────────────────────────────────────────────────

alter table public.milestones enable row level security;
alter table public.pledges enable row level security;
alter table public.challenges enable row level security;
alter table public.challenge_entries enable row level security;
alter table public.platform_settings enable row level security;

-- milestones: publicly readable, owner writes (via service role or project owner)
create policy "milestones are publicly readable" on public.milestones
  for select using (true);

create policy "project owners manage milestones" on public.milestones
  for all using (
    exists (
      select 1 from public.projects p
      where p.id = milestones.project_id and p.owner_id = auth.uid()
    )
  );

-- pledges: publicly readable, inserts via service role (backend)
create policy "pledges are publicly readable" on public.pledges
  for select using (true);

create policy "backers read own pledges" on public.pledges
  for select using (user_id = auth.uid());

create policy "pledges insert via service role" on public.pledges
  for insert with check (true);

-- challenges: publicly readable, admin writes
create policy "challenges are publicly readable" on public.challenges
  for select using (true);

create policy "challenge creator manages" on public.challenges
  for all using (auth.uid() = created_by);

-- challenge_entries: publicly readable, user manages own
create policy "entries are publicly readable" on public.challenge_entries
  for select using (true);

create policy "users insert own entries" on public.challenge_entries
  for insert with check (auth.uid() = user_id);

create policy "users update own entries" on public.challenge_entries
  for update using (auth.uid() = user_id);

create policy "users delete own entries" on public.challenge_entries
  for delete using (auth.uid() = user_id);

-- platform_settings: publicly readable, no public writes (admin via service role)
create policy "settings are publicly readable" on public.platform_settings
  for select using (true);

create policy "settings no public writes" on public.platform_settings
  for all using (false) with check (false);

-- ── Updated RLS: expanded project status doesn't need new policies ────
-- The existing policies already handle CRUD correctly.

-- ── Helper function: update project totals after pledge ────────────────

create or replace function public.update_project_pledge_total()
returns trigger as $$
begin
  update public.projects
  set total_pledged = total_pledged + new.amount,
      updated_at = now()
  where id = new.project_id;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_pledge_update_total on public.pledges;
create trigger trg_pledge_update_total
  after insert on public.pledges
  for each row execute function public.update_project_pledge_total();
