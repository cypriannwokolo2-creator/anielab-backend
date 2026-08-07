# syntax=docker/dockerfile:1.7
#
# AnieLab backend — Next.js API server (port 3001).
#
# Multi-stage build:
#   deps    → full `npm ci` (incl. devDependencies) supplies the TypeScript
#             toolchain that `next build` needs.
#   builder → compiles the app with `npm run build`.
#   runner  → production deps only (`npm ci --only=production`) + the compiled
#             `.next` output. Lean, non-root, no devDeps shipped.

# ─── Stage 1: dependencies (full, incl. devDependencies) ───────────────
# next build compiles .ts route handlers, which requires typescript and
# eslint-config-next (both devDependencies). A single `npm ci --only=production`
# here would break the build; devDeps stay confined to this throwaway stage.
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ─── Stage 2: builder ───────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ─── Stage 3: runner (production deps only) ────────────────────────────
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# next start reads PORT to choose the listen port; HOSTNAME=0.0.0.0 binds
# inside the container so Caddy can reach it from the host network.
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

# Run as the non-root `node` user (uid 1000) baked into the image — runbook
# item 48 (P0): containers must not run as root.
COPY --chown=node:node package.json package-lock.json ./
USER node
RUN npm ci --only=production && npm cache clean --force

# Runtime artifacts copied from the build stage.
COPY --chown=node:node --from=builder /app/.next ./.next
COPY --chown=node:node --from=builder /app/public ./public
COPY --chown=node:node --from=builder /app/next.config.ts ./next.config.ts
# Backend-only: the Soroban WASM read at runtime by src/lib/stellar/deployer.ts
# (readFileSync(process.env.WASM_PATH ?? './contracts/revenue_splitter.wasm')).
# Without this, the deploy-contract endpoint fails.
COPY --chown=node:node --from=builder /app/contracts ./contracts

EXPOSE 3001
CMD ["npm", "start"]
