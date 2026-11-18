// BYOR: GET /.well-known/talos-relay is public, minted once per database, and min_app is only advisory.
import { PROTOCOL_VERSION, RelayDescriptor } from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { VERSION } from '../../src/version.ts'
import { startTestRelay, type TestRelay } from './harness.ts'

const PATH = '/.well-known/talos-relay'
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const get = async (r: TestRelay) => (await fetch(`${r.httpBase}${PATH}`)).json() as Promise<Record<string, unknown>>

describe('GET /.well-known/talos-relay', () => {
  it('answers 200 with exactly the descriptor, no session needed', async () => {
    relay = await startTestRelay()
    const res = await fetch(`${relay.httpBase}${PATH}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['kind', 'min_app', 'protocol', 'relay_id', 'relay_version'])
    expect(RelayDescriptor.parse(body)).toEqual(body)
    expect(body).toMatchObject({ protocol: PROTOCOL_VERSION, relay_version: VERSION, kind: 'self', min_app: '0.0.0' })
  })

  it('keeps one relay_id per database file and gives a fresh database its own', async () => {
    relay = await startTestRelay()
    const first = (await get(relay)).relay_id
    expect(first).toMatch(/^r_[a-z2-7]{20}$/)
    expect((await get(relay)).relay_id).toBe(first)
    await relay.stopKeepData()
    const again = await startTestRelay({ dir: relay.dir })
    expect((await get(again)).relay_id).toBe(first)
    await again.stopKeepData()
    const fresh = await startTestRelay()
    expect((await get(fresh)).relay_id).not.toBe(first)
    await fresh.stop()
    relay = null
    const { rmSync } = await import('node:fs')
    rmSync(again.dir, { recursive: true, force: true })
  })

  it('mints the relay_id at start; a GET only reads what start made', async () => {
    relay = await startTestRelay()
    const db = relay.relay.services.db
    const first = (db.prepare('select relay_id from core_relay_meta').get() as { relay_id: string }).relay_id
    db.prepare('delete from core_relay_meta').run() // a GET that minted or read the table would now differ
    expect((await get(relay)).relay_id).toBe(first)
    expect(db.prepare('select count(*) as n from core_relay_meta').get()).toEqual({ n: 0 })
  })

  it('shows RELAY_KIND and MIN_APP_VERSION', async () => {
    relay = await startTestRelay({ env: { RELAY_KIND: 'hosted', MIN_APP_VERSION: '1.2.3' } })
    expect(await get(relay)).toMatchObject({ kind: 'hosted', min_app: '1.2.3' })
  })

  it('refuses to boot on a bad RELAY_KIND or MIN_APP_VERSION', async () => {
    await expect(startTestRelay({ env: { RELAY_KIND: 'mine' } })).rejects.toThrow(/RELAY_KIND/)
    await expect(startTestRelay({ env: { MIN_APP_VERSION: '1.2' } })).rejects.toThrow(/MIN_APP_VERSION/)
  })
})
