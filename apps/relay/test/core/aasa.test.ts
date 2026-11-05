// WP-I6: the relay serves the Apple App Site Association for passkeys in the iPhone shell, and only when it is configured.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { aasaDocument } from '../../src/core/aasa.ts'
import { startTestRelay, type TestRelay } from './harness.ts'

const PATH = '/.well-known/apple-app-site-association'
const IDS = { APNS_TEAM_ID: 'TEAMID1234', APNS_BUNDLE_ID: 'com.example.talos' }
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

describe('aasaDocument', () => {
  it('needs both a well-formed team id and bundle id', () => {
    expect(aasaDocument(IDS)).toEqual({ webcredentials: { apps: ['TEAMID1234.com.example.talos'] } })
    expect(aasaDocument({})).toBeNull()
    expect(aasaDocument({ APNS_TEAM_ID: 'TEAMID1234' })).toBeNull()
    expect(aasaDocument({ APNS_BUNDLE_ID: 'com.example.talos' })).toBeNull()
    expect(aasaDocument({ ...IDS, APNS_TEAM_ID: 'teamid1234' })).toBeNull()
    expect(aasaDocument({ ...IDS, APNS_BUNDLE_ID: 'has space' })).toBeNull()
    expect(aasaDocument({ ...IDS, APNS_BUNDLE_ID: 'a/../b' })).toBeNull()
  })
})

describe('GET /.well-known/apple-app-site-association', () => {
  it('is a JSON 404 when the team or bundle id is unset (inert)', async () => {
    relay = await startTestRelay()
    const res = await fetch(`${relay.httpBase}${PATH}`, { redirect: 'manual' })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type') ?? '').toContain('application/json')
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('serves webcredentials for TEAM.bundle: 200, application/json, no redirect, no auth', async () => {
    relay = await startTestRelay({ env: IDS })
    const res = await fetch(`${relay.httpBase}${PATH}`, { redirect: 'manual' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ webcredentials: { apps: ['TEAMID1234.com.example.talos'] } })
  })

  it('needs only the team and bundle id, not the push key', async () => {
    relay = await startTestRelay({ env: IDS })
    expect(relay.relay.services.env.APNS_KEY_P8).toBeUndefined()
    expect((await fetch(`${relay.httpBase}${PATH}`)).status).toBe(200)
  })

  it('is a 404 for a malformed team id and never echoes it', async () => {
    relay = await startTestRelay({ env: { ...IDS, APNS_TEAM_ID: 'nope' } })
    const res = await fetch(`${relay.httpBase}${PATH}`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('nope')
  })

  it('wins over the web app fallback (and is a JSON 404, never index.html, when unset)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-web-'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>')
    relay = await startTestRelay({ webDir: dir, env: IDS })
    const ok = await fetch(`${relay.httpBase}${PATH}`)
    expect(ok.headers.get('content-type')).toBe('application/json')
    expect(await ok.json()).toHaveProperty('webcredentials')
    await relay.stop()
    relay = await startTestRelay({ webDir: dir })
    const off = await fetch(`${relay.httpBase}${PATH}`)
    expect(off.status).toBe(404)
    expect(off.headers.get('content-type') ?? '').not.toContain('text/html')
  })
})
