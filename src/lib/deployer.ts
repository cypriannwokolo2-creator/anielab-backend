import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  Address,
  Keypair,
  StrKey,
  rpc,
  Operation,
  TransactionBuilder,
  Networks,
  BASE_FEE,
} from '@stellar/stellar-sdk'
import { config } from '../config.js'
import { getStellarSettings } from './stellarSettings.js'

// ENVELOPE_TYPE_CONTRACT_ID_FROM_SOURCE_ACCOUNT (Soroban contract ID derivation)
const CONTRACT_ID_ENVELOPE = 0

/**
 * Platform deployer: instantiates a fresh per-project RevenueSplitter contract.
 * Holds only the deployer keypair — it never touches user funds.
 *
 * NOTE: once `revenue-splitter-bindings` is published (from anielab-contracts),
 * this can use the typed `Client.deploy()` helper instead of raw ops.
 */
export async function deployRevenueSplitter(): Promise<string> {
  // Network config is admin-panel-editable; read it fresh on every deploy.
  const stellar = await getStellarSettings()
  const networkPassphrase = stellar.network === 'PUBLIC' ? Networks.PUBLIC : Networks.TESTNET

  const secret = stellar.deployerSecret
  if (!secret) throw new Error('Deployer secret key is not set (admin panel → Network)')

  const wasm = readFileSync(config.stellar.wasmPath)

  const kp = Keypair.fromSecret(secret)
  const server = new rpc.Server(stellar.rpcUrl)

  const salt = randomBytes(32)
  const wasmHash = createHash('sha256').update(wasm).digest()
  const address = deriveContractAddress(kp, salt, networkPassphrase)

  const account = await server.getAccount(kp.publicKey())
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.uploadContractWasm({ wasm, source: kp.publicKey() })
    )
    .addOperation(
      Operation.createCustomContract({
        address: new Address(address),
        wasmHash,
        salt,
        source: kp.publicKey(),
      })
    )
    .setTimeout(30)
    .build()

  tx.sign(kp)

  const sendRes = await server.sendTransaction(tx)
  if (sendRes.status === 'ERROR') {
    throw new Error(
      `Deploy failed: ${sendRes.errorResult?.result().toString() ?? 'unknown'}`
    )
  }

  await waitForTransaction(server, sendRes.hash)
  return address
}

/**
 * contractId = hash(networkId | envelopeType | salt | sourceAccountEd25519)
 * https://soroban.stellar.org/docs/fundamentals-and-concepts/invoking-contracts
 */
function deriveContractAddress(kp: Keypair, salt: Buffer, networkPassphrase: string): string {
  const networkId = createHash('sha256').update(networkPassphrase).digest()
  const preimage = Buffer.concat([
    networkId,
    Buffer.from([CONTRACT_ID_ENVELOPE]),
    salt,
    kp.rawPublicKey(),
  ])
  return StrKey.encodeContract(createHash('sha256').update(preimage).digest())
}

async function waitForTransaction(server: rpc.Server, hash: string) {
  for (let i = 0; i < 15; i++) {
    const res = await server.getTransaction(hash)
    if (res.status === 'SUCCESS') return res
    if (res.status === 'FAILED') throw new Error('Transaction failed')
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('Transaction timeout')
}
