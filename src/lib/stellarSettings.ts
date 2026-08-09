import { supabaseAdmin } from './supabaseAdmin.js'
import { config } from '../config.js'
import { decryptSecret } from './secretBox.js'

export interface StellarSettings {
  network: 'TESTNET' | 'PUBLIC'
  rpcUrl: string
  deployerSecret: string
  usdcAsset: string
}

const TESTNET_USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

/**
 * Live Stellar network configuration. The admin panel edits these in
 * platform_settings; env values (config.stellar) only serve as fallback so
 * the API still boots before the row exists. Read at call time — switching
 * TESTNET↔PUBLIC from the panel takes effect without a redeploy.
 */
export async function getStellarSettings(): Promise<StellarSettings> {
  const { data } = await supabaseAdmin()
    .from('platform_settings')
    .select('stellar_network, soroban_rpc_url, usdc_asset, deployer_secret_key')
    .eq('id', 1)
    .maybeSingle()

  const network: StellarSettings['network'] =
    data?.stellar_network === 'PUBLIC' ? 'PUBLIC' : 'TESTNET'

  // Deployer key is stored AES-256-GCM encrypted; fall back to the env seed
  // when it's unset or fails to decrypt.
  const storedDeployer = decryptSecret((data?.deployer_secret_key as string) ?? '')

  return {
    network,
    rpcUrl: (data?.soroban_rpc_url as string) || config.stellar.rpcUrl,
    deployerSecret: storedDeployer || config.stellar.deployerSecret,
    usdcAsset: (data?.usdc_asset as string) || (network === 'TESTNET' ? TESTNET_USDC : ''),
  }
}
