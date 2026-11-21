// The relay says which RELEASE it is (build-time TALOS_RELEASE, strict X.Y.Z) next to its commit `version`: /healthz,
// /api/me and the health report carry `release` only when it is set. A relay that deploys from main sets nothing.
import { HealthStatus, routes } from '@talos-app/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './core/harness.ts'
import { type RealRelay, startRealRelay } from './review/real-relay.ts'

const state = vi.hoisted(() => ({ release: undefined as string | undefined }))
vi.mock('../src/version.ts', async (orig) => {
  const real = await orig<typeof import('../src/version.ts')>()
  return {
    ...real,
    get RELEASE() {
      return state.release
    },
  }
})

describe('releaseFrom (the one read of TALOS_RELEASE)', () => {
  it('keeps a strict X.Y.Z and nothing else, and says once why it dropped a value', async () => {
    const { releaseFrom } = await vi.importActual<typeof import('../src/version.ts')>('../src/version.ts')
    const said: string[] = []
    const warn = (m: string) => said.push(m)
    expect(releaseFrom('0.1.8', warn)).toBe('0.1.8')
    expect(releaseFrom('10.20.300', warn)).toBe('10.20.300')
    expect(said).toEqual([])
    for (const bad of ['v0.1.8', '0.1', 'latest', '0.1.8-rc1', '01.2.3', ' 0.1.8', 'x'.repeat(200), '0.1.8\n0.1.9']) {
      expect(releaseFrom(bad, warn), bad).toBeUndefined()
    }
    expect(said).toHaveLength(8)
    for (const m of said) expect(m).not.toContain('xxxx') // never echoes the value back
    expect(releaseFrom(undefined, warn)).toBeUndefined()
    expect(releaseFrom('', warn)).toBeUndefined()
    expect(said).toHaveLength(8) // unset is normal, not worth a line
  })

  it('RELEASE is read from TALOS_RELEASE when the module loads', async () => {
    vi.stubEnv('TALOS_RELEASE', '0.1.8')
    vi.resetModules()
    const real = await vi.importActual<typeof import('../src/version.ts')>('../src/version.ts')
    expect(real.RELEASE).toBe('0.1.8')
    vi.unstubAllEnvs()
  })
})

describe('/healthz and the health report', () => {
  let relay: TestRelay | null = null
  afterEach(async () => {
    await relay?.stop()
    relay = null
    state.release = undefined
  })

  it('release: "0.1.8" when set; no field at all when unset', async () => {
    state.release = '0.1.8'
    relay = await startTestRelay()
    const on = (await (await fetch(`${relay.httpBase}/healthz`)).json()) as Record<string, unknown>
    expect(on.release).toBe('0.1.8')
    expect(typeof on.version).toBe('string') // `version` (the commit) is unchanged
    expect(routes.healthz.res.parse(on).release).toBe('0.1.8')
    await relay.stop()
    state.release = undefined
    relay = await startTestRelay()
    const off = (await (await fetch(`${relay.httpBase}/healthz`)).json()) as Record<string, unknown>
    expect(off).not.toHaveProperty('release')
    expect(routes.healthz.res.parse(off).release).toBeUndefined()
  })

  it('the health report says the same, and parses with and without it', async () => {
    state.release = '0.1.8'
    relay = await startTestRelay()
    const res = await fetch(`${relay.httpBase}/api/status`, { headers: relay.appHeaders })
    const body = (await res.json()) as { relay: { version: string } }
    expect(HealthStatus.parse(body).relay.release).toBe('0.1.8')
    expect(body.relay.version).toEqual(expect.any(String))
  })
})

describe('/api/me', () => {
  let r: RealRelay | null = null
  afterEach(async () => {
    await r?.stop()
    r = null
    state.release = undefined
  })
  it('carries release only when set', async () => {
    state.release = '0.1.8'
    r = await startRealRelay()
    const owner = await r.owner()
    const me = async () =>
      (await (await fetch(`${r?.httpBase}/api/me`, { headers: { Cookie: owner.cookie } })).json()) as Record<
        string,
        unknown
      >
    expect((await me()).release).toBe('0.1.8')
    expect(routes.me.res.parse(await me()).release).toBe('0.1.8')
    state.release = undefined
    expect(await me()).not.toHaveProperty('release')
  })
})
