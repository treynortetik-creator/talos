import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RelayConnectFile, RelayRedeployRequest, RelayRedeployResult } from '../src/relay-redeploy.ts'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'relay-redeploy')
const fx = (n: string) => JSON.parse(readFileSync(join(dir, `${n}.json`), 'utf8')) as Record<string, unknown>

describe('relay-connect.json', () => {
  it('parses what the Mac app writes (no token, no kind) and what `relay connect` writes', () => {
    expect(RelayConnectFile.parse(fx('connect-app')).via).toBe('app')
    const t = RelayConnectFile.parse(fx('connect-token'))
    expect(t).toMatchObject({ via: 'token', kind: 'project', auto_update: false, domain: 'relay.example.com' })
  })
  it('a token connection says which kind of token; a file with no via is refused', () => {
    const { kind: _k, ...noKind } = fx('connect-token')
    expect(RelayConnectFile.safeParse(noKind).success).toBe(false)
    const { via: _v, ...noVia } = fx('connect-token')
    expect(RelayConnectFile.safeParse(noVia).success).toBe(false)
  })
  it('the domain is a bare hostname: no scheme, port, path or space', () => {
    for (const bad of [
      'https://relay.example.com',
      'relay.example.com:443',
      'relay.example.com/x',
      'a b',
      '',
      '-x.com',
    ])
      expect(RelayConnectFile.safeParse({ ...fx('connect-app'), domain: bad }).success, bad).toBe(false)
  })
  it('unknown fields from a newer app are ignored; an id with odd characters is refused', () => {
    expect(RelayConnectFile.parse({ ...fx('connect-app'), later: 1 })).not.toHaveProperty('later')
    expect(RelayConnectFile.safeParse({ ...fx('connect-app'), service_id: 'a b;c' }).success).toBe(false)
    expect(RelayConnectFile.safeParse({ ...fx('connect-app'), v: 2 }).success).toBe(false)
  })
  it('no fixture holds a token field', () => {
    for (const f of readdirSync(dir))
      for (const key of Object.keys(JSON.parse(readFileSync(join(dir, f), 'utf8')) as object))
        expect(key).not.toMatch(/token|secret|bearer|password|key/i)
  })
})

describe('the redeploy request and result', () => {
  it('parse the fixtures', () => {
    expect(RelayRedeployRequest.parse(fx('request')).release).toBe('0.1.8')
    expect(RelayRedeployResult.parse(fx('result-ok')).ok).toBe(true)
    expect(RelayRedeployResult.parse(fx('result-error'))).toMatchObject({ ok: false, code: 'no_card' })
  })
  it('an unknown error code parses as other, and a long error text is cut', () => {
    expect(RelayRedeployResult.parse({ ...fx('result-error'), code: 'brand_new' }).code).toBe('other')
    expect(RelayRedeployResult.parse({ ...fx('result-error'), code: 7 }).code).toBe('other')
    expect(
      RelayRedeployResult.parse({ ...fx('result-error'), error: 'x'.repeat(900) }).error?.length,
    ).toBeLessThanOrEqual(200)
  })
  it('a release that is not X.Y.Z, or a missing id, is refused', () => {
    for (const bad of ['0.1', 'v0.1.8', '0.1.8-rc1', '']) {
      expect(RelayRedeployRequest.safeParse({ ...fx('request'), release: bad }).success, bad).toBe(false)
      expect(RelayRedeployResult.safeParse({ ...fx('result-ok'), release: bad }).success, bad).toBe(false)
    }
    const { id: _i, ...noId } = fx('result-ok')
    expect(RelayRedeployResult.safeParse(noId).success).toBe(false)
  })
})
