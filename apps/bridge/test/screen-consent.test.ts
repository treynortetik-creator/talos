// Screen helper lane 3: the owner's consent, one card per app per Mac. The real bridge, FakeRelay and a signing FakeApp; the Mac's
// screen socket is a fake that answers the way TalosDesktopCore's ScreenProtocol does and refuses what it refuses: an `allow`
// whose owner signature, device or binding does not check out against devices.json allows nothing.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CardT,
  CONFIG_PROPOSE_FEATURE,
  type JwkP256T,
  sha256Hex,
  verifyOwnerSignedString,
} from '@talos-app/protocol'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { pgidOf } from '../src/hub/server.ts'
import { nullLogger } from '../src/log.ts'
import type { ScreenAnswer } from '../src/screen.ts'
import { displayName, SCREEN_CONSENT_TEXT, SCREEN_NOT_NOW_MS } from '../src/screen-consent.ts'
import { callTool } from '../src/tools/index.ts'
import { screenTransport } from '../src/tools/screen.ts'
import { eventually, type Harness, sleep, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
const workers: Bridge[] = []
const original = screenTransport.request
afterEach(async () => {
  screenTransport.request = original
  for (const w of workers.splice(0)) await w.stop()
  await h?.stop()
  h = undefined
})

const ASK = 'Aa0Bb1Cc2Dd3Ee4Ff5Gg6H' // 22 characters, as the Mac makes them
const NOTES = {
  bundle_id: 'com.example.notes',
  team_id: 'ABCDE12345',
  requirement: 'anchor apple generic and identifier "com.example.notes" and certificate leaf[subject.OU] = ABCDE12345',
  name: 'Notes Example',
  signer: 'developer',
}

/** The Mac's side: refuses an app off its list with an ask, answers ask_info from its own record, and allows only a proof that checks out. */
class FakeMac {
  allowed = new Set<string>()
  measured: Record<string, unknown> = NOTES
  seen: Array<Record<string, unknown>> = []
  proofs: Array<Record<string, string>> = []
  running = true
  constructor(private readonly pinned: () => Record<string, JwkP256T>) {}

  async answer(req: Record<string, unknown>): Promise<ScreenAnswer> {
    this.seen.push(req)
    if (!this.running) return { ok: false, code: 'not_running', text: '' }
    const bundle = String(this.measured.bundle_id)
    switch (req.op) {
      case 'type':
        if (this.allowed.has(bundle)) return { ok: true, body: { events: 1, read_back: 'verified' } }
        return {
          ok: false,
          code: 'app_not_allowed',
          text: `${bundle} isn't on this Mac's allowed list yet.`,
          app: bundle,
          ask: ASK,
          app_name: String(this.measured.name),
        }
      case 'ask_info':
        if (req.ask !== ASK)
          return {
            ok: false,
            code: 'ask_unknown',
            text: 'That request is too old or unknown. Use the app again to ask the owner.',
          }
        return { ok: true, body: { ...this.measured } }
      case 'allow': {
        const p = req.proof as Record<string, string>
        this.proofs.push(p)
        const why = await this.check(p)
        if (why)
          return {
            ok: false,
            code: 'allow_refused',
            text: `The approval did not check out on this Mac (${why}), so nothing was allowed.`,
          }
        const b = JSON.parse(p.binding) as { payload: { screen_allow: { bundle_id: string } } }
        this.allowed.add(b.payload.screen_allow.bundle_id)
        return { ok: true, body: { bundle_id: b.payload.screen_allow.bundle_id } }
      }
      default:
        return { ok: false, code: 'unknown_op', text: '' }
    }
  }

  /** ScreenAllowProofCheck's steps, in TypeScript. */
  async check(p: Record<string, string>): Promise<string | null> {
    const key = this.pinned()[p.device_id]
    if (!key) return 'device'
    if (!(await verifyOwnerSignedString(p.signed, p.osig, p.device_id, key))) return 'signature'
    const s = JSON.parse(p.signed) as Record<string, unknown>
    if (s.type !== 'card.resolve' || s.action !== 'primary' || 'edited' in s || s.device_id !== p.device_id)
      return 'frame'
    const b = JSON.parse(p.binding) as Record<string, unknown>
    if (s.payload_hash !== `sha256:${sha256Hex(p.binding)}` || b.kind !== 'config' || b.id !== s.card_id)
      return 'binding'
    const a = (b.payload as { screen_allow?: Record<string, unknown> }).screen_allow
    const same = (k: string) => a?.[k] === this.measured[k]
    if (!a || Object.keys(a).length !== 5 || !Object.keys(this.measured).every(same)) return 'binding'
    return null
  }
}

async function start(o: { features?: string[]; dedicated?: boolean } = {}) {
  h = await startHarness({
    relay: { relayFeatures: o.features ?? ['schedules/1', CONFIG_PROPOSE_FEATURE] },
    ...(o.dedicated
      ? {
          config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
            ...c,
            dedicated: { enabled: true },
            threads: [
              ...c.threads,
              {
                id: 'trip',
                name: 'Trip',
                kind: 'fixed',
                order: 5,
                notify: 'all',
                voice_context: 'recent',
                archived: false,
                created_at: '2026-10-28T00:00:00.000Z',
                session: 'dedicated',
              },
            ],
          })) as never,
        }
      : {}),
  })
  const x = h
  if (x.bridge.ctx.screenConsent) x.bridge.ctx.screenConsent.macName = () => 'Test Mac'
  const mac = new FakeMac(() => x.pinned)
  screenTransport.request = (_ctx, req) => mac.answer(req)
  return { x, mac }
}

const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('')
const screenCards = (x: Harness) =>
  x.relay.frames
    .filter((f) => f.direction === 'from_bridge' && f.raw.type === 'card.create')
    .map((f) => f.raw.card as CardT)
const updates = (x: Harness, id: string) =>
  x.relay.frames
    .filter((f) => f.direction === 'from_bridge' && f.raw.type === 'card.update' && f.raw.card_id === id)
    .map((f) => f.raw as Record<string, unknown>)
const typeHi = (x: Harness) => callTool(x.bridge.ctx, 'screen_type', { text: 'hi' })

describe('the first use of an app asks the owner once', () => {
  test('the tool answers at once and one card goes to the owner; asking again while it waits makes no second card', async () => {
    const { x } = await start()
    const t0 = Date.now()
    const r = await typeHi(x)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.isError).toBe(true)
    expect(text(r)).toBe('Asked the owner to allow Notes Example on this Mac. Try again after they answer.')
    await eventually(() => expect(screenCards(x)).toHaveLength(1))
    const card = screenCards(x)[0] as CardT
    expect(card.kind).toBe('config')
    expect(card.title).toBe('Let your agent control Notes Example on this Mac?')
    expect(card.primary_label).toBe('Allow')
    expect(card.kill_label).toBe('Not now')
    expect(card.allow_edit).toBe(false)
    expect(card.allow_revise).toBe(false)
    expect(card.summary).toBe(
      'Any session of yours on this Mac could then see its windows and click and type in it. Remove it any time on the Mac: Talos → Settings → Permissions → "Apps your agent may control".',
    )
    expect(SCREEN_CONSENT_TEXT.restarted).toContain('Settings → Permissions → "Apps your agent may control"')
    expect(card.body).toContain('App id: com.example.notes')
    expect(card.body).toContain('Signed by: developer team ABCDE12345')
    expect((card.payload as { screen_allow: unknown }).screen_allow).toEqual(NOTES)
    // twice more, two of them at the same moment
    const again = await Promise.all([typeHi(x), typeHi(x), typeHi(x)])
    for (const a of again) expect(text(a)).toBe(SCREEN_CONSENT_TEXT.asked('Notes Example'))
    await sleep(200)
    expect(screenCards(x)).toHaveLength(1)
  })

  test('Allow: the owner’s signed tap reaches the Mac, the Mac checks it, and the next try goes through', async () => {
    const { x, mac } = await start()
    await typeHi(x)
    await eventually(() => expect(screenCards(x)).toHaveLength(1))
    const card = screenCards(x)[0] as CardT
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    await eventually(() => expect(updates(x, card.id).some((u) => u.state === 'done')).toBe(true))
    const done = updates(x, card.id).find((u) => u.state === 'done') as { result: { text: string } }
    expect(done.result.text).toBe('Allowed. Your agent can now use Notes Example on this Mac.')
    expect(mac.proofs).toHaveLength(1)
    const proof = mac.proofs[0] as Record<string, string>
    expect(await mac.check(proof)).toBeNull()
    // The Swift side is built against this exact output (packages/protocol/fixtures/screen-allow, ScreenAllowFixtureTests).
    if (process.env.UPDATE_SCREEN_ALLOW_FIXTURE === '1') {
      const dir = join(import.meta.dir, '../../../packages/protocol/fixtures/screen-allow')
      mkdirSync(dir, { recursive: true })
      const fixture = { proof, jwk: x.pinned[proof.device_id as string], measured: NOTES }
      writeFileSync(join(dir, 'allow-proof.json'), `${JSON.stringify(fixture, null, 2)}\n`)
    }
    const r = await typeHi(x)
    expect(r.isError).toBeFalsy()
    expect(text(r)).toBe('Typed 2 characters.')
    // the agent was never told (a bridge-handled card)
    expect(x.notes.filter((n) => n.meta?.kind === 'card_action')).toHaveLength(0)
  })

  test('a Mac that refuses the proof allows nothing, and the owner sees why', async () => {
    const { x, mac } = await start()
    await typeHi(x)
    await eventually(() => expect(screenCards(x)).toHaveLength(1))
    const card = screenCards(x)[0] as CardT
    // the Mac's device list no longer has this phone
    mac.check = async () => 'device'
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    await eventually(() => expect(updates(x, card.id).some((u) => u.state === 'failed')).toBe(true))
    const failed = updates(x, card.id).find((u) => u.state === 'failed') as { result: { text: string; ok: boolean } }
    expect(failed.result.ok).toBe(false)
    expect(failed.result.text).toContain('Nothing was allowed: The approval did not check out on this Mac (device)')
    expect(mac.allowed.size).toBe(0)
  })

  test('Talos.app closed when the owner taps Allow: the card fails in words, nothing allowed', async () => {
    const { x, mac } = await start()
    await typeHi(x)
    await eventually(() => expect(screenCards(x)).toHaveLength(1))
    const card = screenCards(x)[0] as CardT
    mac.running = false
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    await eventually(() => expect(updates(x, card.id).some((u) => u.state === 'failed')).toBe(true))
    const failed = updates(x, card.id).find((u) => u.state === 'failed') as { result: { text: string } }
    expect(failed.result.text).toBe(SCREEN_CONSENT_TEXT.macOff)
  })

  test('Not now holds for an hour: no card meanwhile, then the next use asks again', async () => {
    const { x } = await start()
    await typeHi(x)
    await eventually(() => expect(screenCards(x)).toHaveLength(1))
    const card = screenCards(x)[0] as CardT
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(updates(x, card.id).some((u) => u.state === 'done')).toBe(true))
    expect(text(await typeHi(x))).toBe(SCREEN_CONSENT_TEXT.notNow('Notes Example'))
    await sleep(150)
    expect(screenCards(x)).toHaveLength(1)
    // an hour on (the record says when it ends; move it, as the clock would)
    const ctx = x.bridge.ctx
    const key = ctx.store.kvKeys('scr:')[0] as string
    const rec = JSON.parse(ctx.store.kvGet(key) as string) as { not_now_until: number }
    expect(rec.not_now_until - Date.now()).toBeGreaterThan(SCREEN_NOT_NOW_MS - 60_000)
    ctx.store.kvSet(key, JSON.stringify({ ...rec, not_now_until: Date.now() - 1 }))
    expect(text(await typeHi(x))).toBe(SCREEN_CONSENT_TEXT.asked('Notes Example'))
    await eventually(() => expect(screenCards(x)).toHaveLength(2))
  })

  test('an impostor with the same id but another signature is another app: its own card, never folded into the real one', async () => {
    const { x, mac } = await start()
    await typeHi(x)
    await eventually(() => expect(screenCards(x)).toHaveLength(1))
    mac.measured = { ...NOTES, team_id: null, requirement: 'cdhash H"0011"', signer: 'adhoc' }
    expect(text(await typeHi(x))).toBe(SCREEN_CONSENT_TEXT.asked('Notes Example'))
    await eventually(() => expect(screenCards(x)).toHaveLength(2))
    expect(screenCards(x)[1]?.body).toContain('Signed by: no developer (this exact build only; an update asks again)')
  })
})

describe('what can never be asked', () => {
  test('an ask id the Mac never gave makes no card', async () => {
    const { x } = await start()
    const r = await x.bridge.ctx.screenConsent?.ask('ZZ0Bb1Cc2Dd3Ee4Ff5Gg6H', 'Notes Example')
    expect(r?.text).toBe(
      SCREEN_CONSENT_TEXT.cantAsk(
        'Notes Example',
        'That request is too old or unknown. Use the app again to ask the owner.',
      ),
    )
    await sleep(150)
    expect(screenCards(x)).toHaveLength(0)
  })

  test('Talos itself is never put to the owner', async () => {
    const { x, mac } = await start()
    mac.measured = { ...NOTES, bundle_id: 'app.talos.desktop', name: 'Talos' }
    expect(text(await typeHi(x))).toBe(SCREEN_CONSENT_TEXT.talos)
    await sleep(150)
    expect(screenCards(x)).toHaveLength(0)
  })

  test('a relay without settings cards: the agent is told the owner could not be asked', async () => {
    const { x } = await start({ features: ['schedules/1'] })
    expect(text(await typeHi(x))).toBe(SCREEN_CONSENT_TEXT.cantAsk('Notes Example', SCREEN_CONSENT_TEXT.relayOld))
    expect(screenCards(x)).toHaveLength(0)
  })

  test('a measured app with a hostile name is one clipped line on the card', async () => {
    const { x, mac } = await start()
    mac.measured = { ...NOTES, name: `Evil\u202e\nApp ${'x'.repeat(200)}` }
    await typeHi(x)
    await eventually(() => expect(screenCards(x)).toHaveLength(1))
    const card = screenCards(x)[0] as CardT
    expect(card.title).not.toContain('\n')
    expect(card.title).not.toContain('\u202e')
    expect(card.title.length).toBeLessThanOrEqual(120)
    expect(displayName('  ')).toBe('That app')
  })
})

describe('a thread session asks through the main bridge', () => {
  test('the session hands over only the Mac’s id; the card names what the Mac measured, once', async () => {
    const { x, mac } = await start({ dedicated: true })
    await waitFor(() => Bun.file(join(x.home, 'run', 'hub.sock')).size >= 0)
    const at = new Date(Date.now() + 30 * 60_000).toISOString()
    writeFileSync(
      join(x.home, 'workers.json'),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: at, workers_supported: true },
        threads: {
          trip: {
            state: 'live',
            session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
            tmux: 't-trip',
            pane_pid: pgidOf(process.pid) as number,
            cwd: x.home,
            error: null,
          },
        },
      }),
    )
    mkdirSync(join(x.home, 'workers', 'trip'), { recursive: true })
    writeFileSync(join(x.home, 'workers', 'trip', 'nonce'), 'test-nonce-0123456789abcdef')
    const w = await Bridge.create({
      env: loadEnv({
        TALOS_APP_HOME: x.home,
        TALOS_APP_RELAY_URL: x.relay.httpUrl,
        TALOS_APP_WORKER_THREAD: 'trip',
        TALOS_APP_WORKER_NONCE: 'test-nonce-0123456789abcdef',
      }),
      logger: nullLogger,
    })
    workers.push(w)
    expect(await w.startWorker()).toBe(true)
    const r = await w.callTool('screen_type', { text: 'hi' })
    expect(text(r)).toBe(SCREEN_CONSENT_TEXT.asked('Notes Example'))
    await eventually(() => expect(screenCards(x)).toHaveLength(1))
    // the main bridge asked the Mac what the app is; the session sent nothing but the id
    expect(mac.seen.filter((s) => s.op === 'ask_info')).toEqual([{ op: 'ask_info', ask: ASK }])
    // a session that makes up an id gets no card
    const forged = await w.hubClient?.rpc('screen_ask', { ask: 'ZZ0Bb1Cc2Dd3Ee4Ff5Gg6H', app: 'Terminal' })
    expect(forged?.ok).toBe(false)
    expect(forged?.text).toContain("Terminal isn't on this Mac's allowed list yet, and Talos couldn't ask the owner")
    const bad = await w.hubClient?.rpc('screen_ask', { ask: '../../x' })
    expect(bad?.text).toBe('screen_ask needs the id the Mac gave. Nothing was asked.')
    await sleep(150)
    expect(screenCards(x)).toHaveLength(1)
  })
})

describe('how many apps are asked about at once (R1-5)', () => {
  const app = (i: number) => ({ ...NOTES, bundle_id: `com.example.app${i}`, name: `App ${i}` })

  test('at most three cards wait at once; a fourth app is told to try later, with no card', async () => {
    const { x, mac } = await start()
    for (let i = 0; i < 3; i++) {
      mac.measured = app(i)
      expect(text(await typeHi(x))).toBe(SCREEN_CONSENT_TEXT.asked(`App ${i}`))
    }
    await eventually(() => expect(screenCards(x)).toHaveLength(3))
    mac.measured = app(3)
    expect(text(await typeHi(x))).toBe('Talos is already asking the owner about several apps; try again later.')
    // an app already asked about still gets its own line
    mac.measured = app(1)
    expect(text(await typeHi(x))).toBe(SCREEN_CONSENT_TEXT.asked('App 1'))
    await sleep(150)
    expect(screenCards(x)).toHaveLength(3)
  })

  test('at most ten cards an hour, even when the owner answers each one', async () => {
    const { x, mac } = await start()
    for (let i = 0; i < 10; i++) {
      mac.measured = app(i)
      expect(text(await typeHi(x))).toBe(SCREEN_CONSENT_TEXT.asked(`App ${i}`))
      await eventually(() => expect(screenCards(x)).toHaveLength(i + 1))
      const card = screenCards(x)[i] as CardT
      await x.app.resolveCard(card, 'kill', card.payload_hash)
      await eventually(() => expect(updates(x, card.id).some((u) => u.state === 'done')).toBe(true))
    }
    mac.measured = app(10)
    expect(text(await typeHi(x))).toBe(SCREEN_CONSENT_TEXT.busy)
    await sleep(150)
    expect(screenCards(x)).toHaveLength(10)
  })
})
