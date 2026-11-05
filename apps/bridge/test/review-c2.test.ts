// Review C2 (adversarial), red-first. Every test here FAILS on feat/cc-c2; each names the behaviour the fix must give.
import { describe, expect, test } from 'bun:test'
import { MOD_LIVE_WINDOW_MS } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import type { BridgeContext } from '../src/context.ts'
import { type ModEventSink, ModLink } from '../src/mod/link.ts'
import { talosModHello, talosModSync } from '../src/tools/mod.ts'
import { signingLink } from './mod-sign.ts'

const log = { debug() {}, info() {}, warn() {}, error() {}, security() {} }
const state = (at: string) => ({
  session_id: 'sess_1',
  source: 'mod',
  capabilities: ['inventory'],
  busy: false,
  compacting: false,
  stopped_at_mac: false,
  rate_limits: [],
  surfaces: ['terminal'],
  at,
})

function rig() {
  const clock = fakeClock()
  const calls: string[] = []
  const published: Array<{ at: string }> = []
  const sink = new Proxy({} as ModEventSink, {
    get: (_t, name: string) => (v: { at?: string }) => {
      calls.push(name)
      if (name === 'state' && v?.at) published.push({ at: v.at })
    },
  })
  let secret = ''
  const raw = new ModLink({
    clock,
    log,
    sink,
    keys: {
      read: () => secret,
      write: (k) => {
        secret = k
      },
    },
  })
  const link = signingLink(raw, () => clock.now())
  // the mod's way in: read the key file, say hello with it, read the rotated key
  const connect = () => {
    const h = link.hello(secret)
    if (!h.ok) throw new Error('hello')
    return secret
  }
  return { clock, link, calls, published, connect, secret: () => secret, ctx: { mod: raw } as unknown as BridgeContext }
}

describe('C2 review: degradation without the mod', () => {
  // No mod loaded (a plain `claude` in the agent folder, a `--bg` worker, a hooks failure): nothing guards the two
  // tools, so any model call, e.g. one an `trust=external` inbox message talked it into, takes the link. The key comes
  // back in the tool result, i.e. in the transcript, and the forged state reaches the phone as `source: 'mod'`.
  test('a hello that carries no proof it comes from the mod is refused', async () => {
    const r = rig()
    const res = await talosModHello.handler(r.ctx, {})
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res)).not.toMatch(/[A-Za-z0-9_-]{43}/)
  })

  test('so a forged sync from that caller never reaches the app', async () => {
    const r = rig()
    const hello = await talosModHello.handler(r.ctx, {})
    const key = (() => {
      try {
        return (JSON.parse((hello.content?.[0] as { text?: string })?.text ?? '{}') as { mod_key?: string }).mod_key
      } catch {
        return undefined // a refusal is plain text
      }
    })()
    await talosModSync.handler(r.ctx, { mod_key: key, state: state(r.clock.iso()) })
    await talosModSync.handler(r.ctx, { mod_key: r.secret(), state: state(r.clock.iso()) }) // even the file's key, with no hello
    expect(r.calls).not.toContain('state')
  })
})

describe('C2 review: a dead mod must not leave live-looking data behind', () => {
  // The relay keeps the last session.state for `ready` (C2.5). When the session quits, the bridge goes quiet: the
  // window lapses inside ModLink.live, but nobody is told, so the app keeps showing the last busy/model/context as now.
  test('when the live window lapses with no sync, the sink hears about it', () => {
    const r = rig()
    const key = r.connect()
    r.link.sync({ mod_key: key, state: state(r.clock.iso()) })
    const before = r.calls.length
    r.clock.advance(MOD_LIVE_WINDOW_MS + 5_000)
    expect(r.link.snapshot().live).toBe(false)
    expect(r.calls.length).toBeGreaterThan(before)
  })

  // publishState drops a state equal to the last one, `at` included, so a live mod whose state has not changed for a
  // minute and a mod that died a minute ago produce the same frames: the app cannot tell them apart by `at`.
  test('a live mod with unchanged state still refreshes `at` inside the live window', () => {
    const r = rig()
    const key = r.connect()
    for (let i = 0; i < 30; i++) {
      r.link.sync({ mod_key: key, state: state(r.clock.iso()) })
      r.clock.advance(2_000)
    }
    const last = r.published.at(-1)
    expect(last).toBeDefined()
    expect(r.clock.now() - Date.parse(last?.at ?? '')).toBeLessThanOrEqual(MOD_LIVE_WINDOW_MS)
  })
})

describe('C2 review: the guard must cover $.mcp.call too', () => {
  // `$.mcp.call` is an op event (claude-code.d.ts `mcp.call`, "No permission prompt: the plugin's call, seen by the
  // hooks above it, is the grant"). It never raises tool.call or tool.check, so another plugin, or a mod the model
  // writes into a dev-mods folder, reaches talos_mod_hello past both guards. The test kit's `$` has no op nouns, so
  // this is checked the way the engine reads the module: validate's gatingHooks must list an mcp.call gate with .catch.
  const claude = Bun.which('claude')
  test.skipIf(!claude)('validate lists a gating mcp.call hook with .catch', () => {
    const home = `${process.env.TMPDIR ?? '/tmp'}/talos-review-home-${process.pid}`
    const out = Bun.spawnSync([claude as string, 'plugin', 'validate', '--json', 'plugins/talos-app-mod'], {
      cwd: `${import.meta.dir}/../../..`,
      env: { ...process.env, HOME: home },
    })
    const report = JSON.parse(out.stdout.toString()) as {
      contents: Array<{ gatingHooks?: Array<{ pattern: string; hasCatch: boolean }> }>
    }
    const gates = report.contents.flatMap((c) => c.gatingHooks ?? [])
    expect(gates.some((g) => g.pattern === 'mcp.call' && g.hasCatch)).toBe(true)
  })
})
