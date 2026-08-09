/**
 * Centralized, validated environment config. Fails fast at boot when a
 * required variable is missing so a misdeployed instance never half-runs.
 *
 * Env names keep backward compatibility with the old backend's .env
 * (NEXT_PUBLIC_* aliases) so the same file can be reused on the VM.
 */

function required(name: string, aliases: string[] = []): string {
  const value = process.env[name] ?? aliases.map((a) => process.env[a]).find(Boolean)
  if (!value) {
    throw new Error(`Missing required env var: ${name}${aliases.length ? ` (or ${aliases.join(' / ')})` : ''}`)
  }
  return value
}

function optional(name: string, fallback: string, aliases: string[] = []): string {
  return process.env[name] ?? aliases.map((a) => process.env[a]).find(Boolean) ?? fallback
}

export const config = {
  port: Number(optional('PORT', '3001')),
  env: optional('NODE_ENV', 'development'),

  supabaseUrl: required('SUPABASE_URL', ['NEXT_PUBLIC_SUPABASE_URL']),
  supabaseServiceKey: required('SUPABASE_SERVICE_ROLE_KEY'),

  minio: {
    endpoint: optional('MINIO_ENDPOINT', 'localhost'),
    port: Number(optional('MINIO_PORT', '9000')),
    useSSL: optional('MINIO_USE_SSL', 'false') === 'true',
    accessKey: required('MINIO_ACCESS_KEY'),
    secretKey: required('MINIO_SECRET_KEY'),
    bucket: optional('MINIO_BUCKET', 'anielab-media'),
  },

  /** Public base URL where media objects are served (Caddy → MinIO). */
  mediaBaseUrl: optional('MEDIA_BASE_URL', 'https://minio.anielab.app', ['NEXT_PUBLIC_MEDIA_BASE_URL']),

  stellar: {
    network: optional('STELLAR_NETWORK', 'TESTNET', ['NEXT_PUBLIC_STELLAR_NETWORK']),
    rpcUrl: optional('SOROBAN_RPC_URL', 'https://soroban-testnet.stellar.org', ['NEXT_PUBLIC_SOROBAN_RPC_URL']),
    deployerSecret: process.env.DEPLOYER_SECRET_KEY ?? '',
    wasmPath: optional('WASM_PATH', './contracts/revenue_splitter.wasm'),
  },

  adminPassword: process.env.ADMIN_PASSWORD ?? '',

  /**
   * CORS allowlist — only these origins may call the API. Comma-separated
   * override via ALLOWED_ORIGINS; Vercel preview deployments get their own
   * subdomain, so production deployments should list the custom domain.
   */
  allowedOrigins: new Set(
    optional(
      'ALLOWED_ORIGINS',
      'https://anielab.app,https://www.anielab.app,https://app.anielab.app'
    )
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  ),

  /** Global rate limit: requests per window per IP. */
  rateLimit: {
    windowMs: Number(optional('RATE_LIMIT_WINDOW_MS', '60000')),
    max: Number(optional('RATE_LIMIT_MAX', '300')),
  },
} as const

export const isProd = config.env === 'production'
