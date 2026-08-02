import Link from 'next/link'

export const dynamic = 'force-static'

const endpoints = [
  { method: 'POST', path: '/api/auth/challenge', desc: 'Issue a SIWS nonce for a wallet address' },
  { method: 'POST', path: '/api/auth/verify', desc: 'Verify signature, mark user verified' },
  { method: 'POST', path: '/api/upload', desc: 'Pin a file to IPFS via Pinata (auth: Bearer token)' },
  { method: 'POST', path: '/api/projects/deploy-contract', desc: 'Deploy a per-project RevenueSplitter instance' },
]

export default function Home() {
  return (
    <main style={{ fontFamily: 'monospace', padding: '2rem', maxWidth: 720 }}>
      <h1>anielab-backend</h1>
      <p>API-only service. Holds every secret credential (service role, Pinata JWT, deployer key).</p>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {endpoints.map((e) => (
          <li key={e.path} style={{ marginBottom: '0.75rem' }}>
            <code>{e.method} {e.path}</code>
            <div style={{ fontSize: '0.85rem', opacity: 0.7 }}>{e.desc}</div>
          </li>
        ))}
      </ul>
      <Link href="https://github.com/stellar/stellar-cli">stellar-cli docs</Link>
    </main>
  )
}
