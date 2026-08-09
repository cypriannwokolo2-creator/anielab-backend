-- Stellar network settings live in the DB (editable from the admin panel),
-- with the env values kept only as a boot-time fallback. The deployer secret
-- key is stored here too but is never returned by any public endpoint.
alter table public.platform_settings
  add column if not exists stellar_network text not null default 'TESTNET',
  add column if not exists soroban_rpc_url text,
  add column if not exists usdc_asset text,
  add column if not exists deployer_secret_key text;

-- Seed testnet defaults for the existing settings row.
update public.platform_settings set
  soroban_rpc_url = coalesce(nullif(soroban_rpc_url, ''), 'https://soroban-testnet.stellar.org'),
  usdc_asset = coalesce(nullif(usdc_asset, ''), 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA')
where id = 1;
