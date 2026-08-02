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

## Notes

- `deployer.ts` will move to the typed `revenue-splitter-bindings` client
  (published from anielab-contracts) once that package exists.
- `siws.ts` implements Ed25519-over-sha256 verification for now; swap to
  SEP-30 SIWS payloads when Freighter's `signMessage` stabilizes.
