# anielab-backend

The trust boundary of AnieLab: Supabase schema + every server-side operation
that needs a secret credential. Holds **all** secrets (service-role key, Pinata
JWT, platform deployer keypair) and never ships them to the frontend repo.

## Layout

```
anielab-backend/
├── supabase/
│   ├── config.toml
│   └── migrations/20260801000000_init_schema.sql
├── src/
│   ├── app/api/
│   │   ├── auth/challenge/route.ts        # issue SIWS nonce
│   │   ├── auth/verify/route.ts           # verify signature, upsert user
│   │   ├── upload/route.ts                # pin file to IPFS (auth required)
│   │   └── projects/deploy-contract/route.ts  # deploy per-project contract instance
│   └── lib/
│       ├── supabaseAdmin.ts               # service-role client
│       ├── pinata.ts
│       └── stellar/
│           ├── deployer.ts                # platform deployer key
│           └── siws.ts                    # sign-in-with-stellar verification
└── .env.local
```

## Public contract with anielab-web

| Route | Purpose |
|---|---|
| `POST /api/auth/challenge` | Issue a SIWS nonce for a wallet address |
| `POST /api/auth/verify` | Verify signature, return verified user |
| `POST /api/upload` | Pin a file to IPFS via Pinata (Bearer token auth) |
| `POST /api/projects/deploy-contract` | Deploy + return a new per-project `RevenueSplitter` instance |

Everything else (reading projects/contributions/users) the frontend does
directly against Supabase with the anon key + RLS — no backend round-trip.

## Local development

```bash
npm install
supabase link --project-ref <your-project-ref>   # or: supabase start for local
supabase db push                                  # apply migrations

# copy the compiled contract artifact from anielab-contracts:
#   cp ../anielab-contracts/target/wasm32-unknown-unknown/release/revenue_splitter.wasm contracts/

npm run dev
```

## Deploying

Deploy as its own Vercel (or platform) project, separate from the frontend, so
`SUPABASE_SERVICE_ROLE_KEY` and `DEPLOYER_SECRET_KEY` never appear in the web
repo's environment. CI (`/.github/workflows/ci.yml`) pushes schema changes via
`supabase db push --db-url ${{ secrets.SUPABASE_DB_URL }}`.

## Continuous deployment (auto-deploy on push)

The production VM polls GitHub once a minute and redeploys itself whenever
`main` moves in this repo or in anielab-web — no SSH, no manual rebuilds, no
downtime (the old containers keep serving while the new images build; only the
final swap takes ~1–2s).

How it fits together:

| File | Role |
|---|---|
| `scripts/deploy.sh` | Pulls both repos, **always rebuilds** both images, `docker compose up -d`, smoke test. Old containers serve during the build. |
| `scripts/auto-deploy.sh` | Cron entry point: `git fetch` both repos, compare HEAD vs tracking branch; on change, run deploy.sh, restart Caddy only if the Caddyfile changed, prune dangling images. `flock` prevents overlapping runs. Logs to `$APP_DIR/auto-deploy.log`. |
| `scripts/install-auto-deploy.sh` | Idempotent bootstrap: clones the web repo if missing, installs the once-per-minute cron entry, creates log/lock files. |

### Install on a VM (or migrate to a new VPS)

```bash
# 1. get the repo
sudo mkdir -p /opt/anielab && sudo chown $USER /opt/anielab
git clone https://github.com/cypriannwokolo2-creator/anielab-backend.git \
    /opt/anielab/anielab-backend
cd /opt/anielab/anielab-backend

# 2. secrets (one time) — deploy.sh copies .env.example to .env and aborts
#    until it is filled in
cp .env.example .env && nano .env

# 3. install cron + run the first deploy (builds images, starts the stack)
bash scripts/install-auto-deploy.sh --deploy-now

# 4. point DNS at this machine's IP
```

After that: **push to `main` in either repo → the site updates itself within
~1 minute**. Watch it with `tail -f /opt/anielab/auto-deploy.log`.

Re-running the installer is always safe (idempotent). To uninstall, remove the
`auto-deploy` line from `crontab -e`.

### Notes & troubleshooting

- The automation lives **inside this repo**, so it updates itself whenever the
  backend repo is pulled — nothing extra to copy between machines.
- Requires: docker + docker compose (any modern version), `git`, `flock`
  (util-linux), `md5sum` (coreutils), and a crontab for the deploy user.
- Repos must be checked out on a branch with an upstream (`git clone` does this
  by default) — `auto-deploy.sh` and `deploy.sh` both rely on it.
- Builds on the 1 GiB VM take ~4–5 min. If a build fails or OOMs, the log shows
  it and the running site is untouched (the swap never happens).
- `.env` is never committed; if a fresh VM deploys before `.env` exists,
  deploy.sh fails loudly — fill it in and re-run.
- Every deploy re-runs the one-shot `minio-init` and `smoke` containers
  (compose `up -d` behavior) — harmless and expected.

## Notes

- `deployer.ts` will move to the typed `revenue-splitter-bindings` client
  (published from anielab-contracts) once that package exists.
- `siws.ts` implements Ed25519-over-sha256 verification for now; swap to
  SEP-30 SIWS payloads when Freighter's `signMessage` stabilizes.
