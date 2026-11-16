// Kill switches (flags.json): every declared switch defaults off, each new one is read through one helper and named by a test of
// its off path, and a switch read anywhere in the bridge, relay or Mac app without an entry fails here.
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { mainHook } from '../apps/bridge/src/apps/hook-cli.ts'
import { appsSwitch } from '../apps/bridge/src/apps/switch.ts'
import { flag, loadEnv as loadBridgeEnv } from '../apps/bridge/src/config.ts'
import { resolveExplainerClaude } from '../apps/bridge/src/permission/explainer.ts'
import { loadEnv as loadRelayEnv } from '../apps/relay/src/env.ts'
import { checkFlags, readRegistry } from './flags-check.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'flags-'))
  dirs.push(d)
  return d
}
const expected = (d: string): unknown => (d === 'off' ? false : d === 'on' ? true : d)

describe('flags.json, the kill-switch registry', () => {
  it('this repository passes the check: every switch read is registered, every entry is read where it says', () => {
    expect(checkFlags(root)).toEqual([])
  })

  it('every bridge switch with a config key comes out at its declared default with nothing set', () => {
    const home = tmp()
    const env = loadBridgeEnv({ TALOS_APP_HOME: home, HOME: home, PATH: '' }) as unknown as Record<string, unknown>
    const keyed = readRegistry(root).filter((f) => f.surface === 'bridge' && f.key)
    expect(keyed.length).toBeGreaterThan(0)
    for (const f of keyed) expect(env[f.key as string], f.name).toEqual(expected(f.default))
  })

  it('every relay switch comes out at its declared default with only the required variables set', () => {
    const env = loadRelayEnv({
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: 'https://relay.example.com',
      RP_ID: 'relay.example.com',
      DATA_KEY: randomBytes(32).toString('base64'),
    }) as unknown as Record<string, unknown>
    const relay = readRegistry(root).filter((f) => f.surface === 'relay')
    expect(relay.length).toBeGreaterThan(0)
    for (const f of relay) expect(env[f.key ?? f.name], f.name).toEqual(f.unset ?? expected(f.default))
  })
})

describe('flag(): on only for exactly 1; the first source with a value decides', () => {
  it('unset, empty or any other value is off (today behaviour)', () => {
    for (const v of [undefined, '', '0', 'true', 'on', 'yes', ' 1'])
      expect(flag('TALOS_APP_X', [{ TALOS_APP_X: v }]), String(v)).toBe(false)
    expect(flag('TALOS_APP_X', [{ TALOS_APP_X: '1' }])).toBe(true)
  })
  it('sources in order: an empty value passes to the next, a set one decides, the fallback is last', () => {
    expect(flag('TALOS_APP_X', [{ TALOS_APP_X: '0' }, { TALOS_APP_X: '1' }])).toBe(false)
    expect(flag('TALOS_APP_X', [{ TALOS_APP_X: '' }, { TALOS_APP_X: '1' }])).toBe(true)
    expect(flag('TALOS_APP_X', [undefined, {}])).toBe(false)
    expect(flag('TALOS_APP_X', [{}], true)).toBe(true)
    expect(flag('TALOS_APP_X', [{ TALOS_APP_X: '0' }], true)).toBe(false)
  })
})

describe('the check itself, on a made-up tree', () => {
  const tree = (files: Record<string, string>, registry: unknown[]) => {
    const r = tmp()
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(r, p)), { recursive: true })
      writeFileSync(join(r, p), text)
    }
    writeFileSync(join(r, 'flags.json'), JSON.stringify({ flags: registry }))
    return r
  }
  const entry = (o: Record<string, unknown>) => ({
    surface: 'bridge',
    default: 'off',
    owner: 'bridge',
    added: '2026-11-12',
    removeBy: null,
    readers: ['apps/bridge/src/x.ts'],
    test: 'flag:TALOS_APP_NEW',
    ...o,
  })
  const BRIDGE = "export const on = flag('TALOS_APP_NEW', [env])\n"
  const TEST = { 'apps/bridge/test/x.test.ts': "test('flag:TALOS_APP_NEW off: nothing happens', () => {})\n" }

  it('a registered switch with its off-path test passes', () => {
    expect(checkFlags(tree({ 'apps/bridge/src/x.ts': BRIDGE, ...TEST }, [entry({ name: 'TALOS_APP_NEW' })]))).toEqual(
      [],
    )
  })
  it('a switch read without an entry fails: through flag(), a bare compare, a relay 0|1 or a Mac environment read', () => {
    const cases: Record<string, string> = {
      'apps/bridge/src/x.ts': BRIDGE,
      'apps/bridge/src/y.ts': "const on = env.TALOS_APP_OTHER === '1'\n",
      'apps/relay/src/env.ts': "  NEW_SWITCH: flag01,\n  RAW_SWITCH: z.enum(['0', '1']).default('0'),\n",
      'apps/desktop/Sources/A/B.swift': 'if ProcessInfo.processInfo.environment["TALOS_MAC_NEW"] == "1" {}\n',
    }
    const problems = checkFlags(tree(cases, [])).join('\n')
    for (const n of ['TALOS_APP_NEW', 'TALOS_APP_OTHER', 'NEW_SWITCH', 'RAW_SWITCH', 'TALOS_MAC_NEW'])
      expect(problems).toContain(`${n} is read`)
  })
  it('test files are not scanned for reads', () => {
    expect(checkFlags(tree({ 'apps/bridge/src/x.test.ts': BRIDGE }, []))).toEqual([])
  })
  it('an entry fails when a reader it names does not read it, or names no reader', () => {
    const r = tree({ 'apps/bridge/src/x.ts': '// nothing\n', ...TEST }, [entry({ name: 'TALOS_APP_NEW' })])
    expect(checkFlags(r).join('\n')).toContain('TALOS_APP_NEW: apps/bridge/src/x.ts does not read it')
    const r2 = tree({ ...TEST }, [entry({ name: 'TALOS_APP_NEW', readers: [] })])
    expect(checkFlags(r2).join('\n')).toContain('TALOS_APP_NEW: no readers')
  })
  it('a new (not legacy) switch must default off and name a test that exists', () => {
    const files = { 'apps/bridge/src/x.ts': BRIDGE }
    expect(checkFlags(tree(files, [entry({ name: 'TALOS_APP_NEW', default: 'on' })])).join('\n')).toContain(
      'TALOS_APP_NEW: a new switch defaults off',
    )
    expect(checkFlags(tree(files, [entry({ name: 'TALOS_APP_NEW' })])).join('\n')).toContain(
      'TALOS_APP_NEW: no test is named flag:TALOS_APP_NEW',
    )
    expect(checkFlags(tree(files, [entry({ name: 'TALOS_APP_NEW', test: undefined })])).join('\n')).toContain(
      'TALOS_APP_NEW: no test is named',
    )
  })
  it('a legacy entry keeps its real default and needs no tagged test, but must say why it is legacy', () => {
    const files = { 'apps/bridge/src/x.ts': BRIDGE }
    expect(
      checkFlags(
        tree(files, [
          entry({ name: 'TALOS_APP_NEW', default: 'on', test: undefined, legacy: 'older than flags.json' }),
        ]),
      ),
    ).toEqual([])
    expect(checkFlags(tree(files, [entry({ name: 'TALOS_APP_NEW', legacy: '' })])).join('\n')).toContain(
      'TALOS_APP_NEW: no test is named',
    )
  })
  it('a malformed or duplicate entry fails', () => {
    const files = { 'apps/bridge/src/x.ts': BRIDGE, ...TEST }
    const dup = [entry({ name: 'TALOS_APP_NEW' }), entry({ name: 'TALOS_APP_NEW' })]
    expect(checkFlags(tree(files, dup)).join('\n')).toContain('TALOS_APP_NEW: listed twice')
    expect(checkFlags(tree(files, [entry({ name: 'TALOS_APP_NEW', surface: 'web' })])).join('\n')).toContain(
      'TALOS_APP_NEW: surface must be bridge, relay or mac',
    )
  })
})

// Each legacy switch's EFFECTIVE value through its real reader, against literals read by hand from the readers as they were
// before the registry (git show 48b41d27:<file>), for the values e2e passes and the edge values: so a routing change (flag(),
// precedence) can never quietly flip one. A literal changes only with a deliberate change of meaning.
describe('legacy switches keep their meaning (pinned to the readers at 48b41d27)', () => {
  const bridge = (env: Record<string, string | undefined>, file?: string) => {
    const home = tmp()
    if (file !== undefined) writeFileSync(join(home, 'bridge.env'), file)
    return loadBridgeEnv({ TALOS_APP_HOME: home, HOME: home, PATH: '', ...env })
  }

  it('TALOS_APP_BRIDGE (live): only 1 is on; e2e passes 1', () => {
    const cases: [string | undefined, boolean][] = [
      [undefined, false],
      ['', false],
      ['0', false],
      ['1', true],
      ['true', false],
      ['on', false],
    ]
    for (const [v, live] of cases) expect(bridge({ TALOS_APP_BRIDGE: v }).live, String(v)).toBe(live)
    // the process wins over bridge.env (loadEnv's merge); an empty process value leaves the file's
    expect(bridge({ TALOS_APP_BRIDGE: '0' }, 'TALOS_APP_BRIDGE=1\n').live).toBe(false)
    expect(bridge({ TALOS_APP_BRIDGE: '' }, 'TALOS_APP_BRIDGE=1\n').live).toBe(true)
  })

  it("TALOS_APP_BRIDGE in the hook: the hook's own environment only, never bridge.env", async () => {
    const reads = async (env: Record<string, string | undefined>, file?: string) => {
      const home = tmp()
      if (file !== undefined) writeFileSync(join(home, 'bridge.env'), file)
      let read = false
      await mainHook(['post-tool-use'], {
        readStdin: async () => {
          read = true
          return ''
        },
        write: () => {},
        env: { TALOS_APP_HOME: home, ...env },
        now: () => 0,
      })
      return read // a live hook reads its input; any other returns before
    }
    expect(await reads({})).toBe(false)
    expect(await reads({ TALOS_APP_BRIDGE: '1' })).toBe(true)
    expect(await reads({ TALOS_APP_BRIDGE: 'true' })).toBe(false)
    expect(await reads({}, 'TALOS_APP_BRIDGE=1\n')).toBe(false)
  })

  it('TALOS_APP_APPS: only 1 is on; e2e passes 1, and an empty value to switch it off', () => {
    for (const [v, on] of [
      [undefined, false],
      ['', false],
      ['0', false],
      ['1', true],
      ['true', false],
    ] as const)
      expect(bridge({ TALOS_APP_APPS: v }).apps, String(v)).toBe(on)
  })

  it('TALOS_APP_APPS in appsSwitch: bridge.env first, then the process, then the fallback', () => {
    const sw = (file: string | undefined, env: Record<string, string | undefined>, fallback?: boolean) => {
      const home = tmp()
      if (file !== undefined) writeFileSync(join(home, 'bridge.env'), file)
      return appsSwitch(home, env, fallback)
    }
    expect(sw(undefined, {})).toBe(false)
    expect(sw(undefined, {}, true)).toBe(true)
    expect(sw(undefined, { TALOS_APP_APPS: '1' })).toBe(true)
    expect(sw(undefined, { TALOS_APP_APPS: '' }, true)).toBe(true)
    expect(sw('TALOS_APP_APPS=0\n', { TALOS_APP_APPS: '1' })).toBe(false)
    expect(sw('TALOS_APP_APPS=1\n', { TALOS_APP_APPS: '0' })).toBe(true)
    expect(sw('TALOS_APP_APPS=\n', { TALOS_APP_APPS: '1' })).toBe(true)
    expect(sw('TALOS_APP_APPS=yes\n', { TALOS_APP_APPS: '1' }, true)).toBe(false)
  })

  it('TALOS_APP_SCHEDULER: auto unless exactly off or chronos', () => {
    const cases: [string | undefined, string][] = [
      [undefined, 'auto'],
      ['', 'auto'],
      ['auto', 'auto'],
      ['off', 'off'],
      ['chronos', 'chronos'],
      ['0', 'auto'],
      ['OFF', 'auto'],
    ]
    for (const [v, s] of cases) expect(bridge({ TALOS_APP_SCHEDULER: v }).scheduler, String(v)).toBe(s)
  })

  it('TALOS_APP_CHRONOS_AUTODISCOVER: on unless off (e2e and the bridge tests set off, in the process)', () => {
    const saved = process.env.TALOS_APP_CHRONOS_AUTODISCOVER
    try {
      delete process.env.TALOS_APP_CHRONOS_AUTODISCOVER
      for (const [v, on] of [
        [undefined, true],
        ['', true],
        ['0', true],
        ['off', false],
      ] as const)
        expect(bridge({ TALOS_APP_CHRONOS_AUTODISCOVER: v }).chronosAutoDiscover, String(v)).toBe(on)
      process.env.TALOS_APP_CHRONOS_AUTODISCOVER = 'off' // e2e/harness/global-setup.ts: from the process, under a hand-built env
      expect(bridge({}).chronosAutoDiscover).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.TALOS_APP_CHRONOS_AUTODISCOVER
      else process.env.TALOS_APP_CHRONOS_AUTODISCOVER = saved
    }
  })

  it('TALOS_EXPLAINER: on (a claude on PATH) unless off, 0, false or no, any case; e2e passes off', () => {
    const bin = tmp()
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
    expect(resolveExplainerClaude({ PATH: bin })).toBe(join(bin, 'claude'))
    for (const v of ['off', '0', 'false', 'no', 'OFF', ' no '])
      expect(resolveExplainerClaude({ PATH: bin, TALOS_EXPLAINER: v }), v).toBeUndefined()
    expect(resolveExplainerClaude({ PATH: bin, TALOS_EXPLAINER: 'on' })).toBe(join(bin, 'claude'))
    expect(bridge({ TALOS_EXPLAINER: 'off' }).explainer).toBe('off')
    expect(bridge({}).explainer).toBeUndefined()
  })

  it('the relay switches with only the required variables: force off, proof 0, integrations allow, share on', () => {
    const env = loadRelayEnv({
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: 'https://relay.example.com',
      RP_ID: 'relay.example.com',
      DATA_KEY: randomBytes(32).toString('base64'),
    })
    expect(env.BRIDGE_PUBKEY_FORCE).toBe(false)
    expect(env.DEVICE_PROOF_REQUIRED).toBe('0')
    expect(env.WORK_INTEGRATIONS).toBe('allow')
    expect(env.SHARE_ENABLED).toBe(true)
  })
})
