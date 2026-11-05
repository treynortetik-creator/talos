// .env.example is the owner's checklist: it must name every variable the relay reads, and it must boot the relay once the
// blanks are filled in.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadEnv, RelayEnvSchema } from '../../src/env.ts'

const file = readFileSync(join(import.meta.dirname, '../../../../.env.example'), 'utf8')
const assigned = new Map<string, string>()
for (const line of file.split('\n')) {
  const m = /^#?\s?([A-Z][A-Z0-9_]+)=(.*)$/.exec(line)
  if (m) assigned.set(m[1] as string, (m[2] as string).trim())
}

describe('.env.example', () => {
  it('names every variable the relay reads', () => {
    const missing = Object.keys(RelayEnvSchema.shape).filter((k) => !assigned.has(k))
    expect(missing).toEqual([])
  })

  it('contains no real secret', () => {
    for (const k of ['DATA_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'OPENAI_API_KEY', 'BRIDGE_PUBKEY'])
      expect(assigned.get(k), k).toBe('')
  })

  it('boots the relay once the blanks are filled in', () => {
    const filled: Record<string, string> = {}
    for (const [k, v] of assigned) if (v !== '' && !file.includes(`# ${k}=`)) filled[k] = v
    const env = loadEnv({
      ...filled,
      PUBLIC_ORIGIN: 'https://relay.example.com',
      RP_ID: 'relay.example.com',
      DATA_KEY: Buffer.alloc(32, 7).toString('base64'),
      VAPID_PUBLIC_KEY: 'public',
      VAPID_PRIVATE_KEY: 'private',
    })
    expect(env.NODE_ENV).toBe('production')
    expect(env.DATA_DIR).toBe('/data')
    expect(env.TRUST_PROXY_HOPS).toBe(1)
  })
})
