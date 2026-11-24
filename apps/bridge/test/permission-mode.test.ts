// `permission_mode`: the agent, asked by the owner, changes how Main asks permission (Auto, Ask me, Bypass all). The bridge writes
// permission-mode-request.json for the Mac app (the shape PermissionModeRequest.swift reads). Real live bridge over the FakeRelay;
// the Mac app is not here: these tests read the file the bridge leaves for it. A looser change needs the owner's own words with no
// outside text since (trust.ts ownerAskedIn, the rule config_propose uses); otherwise it is a card the owner answers.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CardT,
  CONFIG_PROPOSE_FEATURE,
  cardNotice,
  createPhoneKeys,
  newUlid,
  shownHash,
  signNativeAct,
  signNativeGrant,
} from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { pgidOf } from '../src/hub/server.ts'
import { nullLogger } from '../src/log.ts'
import {
  isPermissionModeCard,
  PERMISSION_MODE_REQUEST_FILE,
  PERMISSION_MODE_TEXT,
  PERMISSION_NOT_NOW_MS,
} from '../src/permission-mode.ts'
import { OWNER_HOST_TEST } from '../src/platform.ts'
import { toolsFor } from '../src/tools/index.ts'
import { AGENT_TOOLS } from '../src/tools/table.ts'
import { noteOutsideText, SETTINGS_LOCKED } from '../src/trust.ts'
import { HANDOFF_SCHEMA_SQL } from '../src/worker/handoff.ts'
import { eventually, type Harness, sleep, startHarness, waitFor } from './helpers.ts'

// the waits of one test (the harness start, the card, the answer) add up past bun's 5 s default
setDefaultTimeout(t(30_000))

let h: Harness | undefined
const bridges: Bridge[] = []
afterEach(async () => {
  OWNER_HOST_TEST.host = 'mac'
  for (const b of bridges.splice(0)) await b.stop().catch(() => {})
  await h?.stop()
  h = undefined
})

async function start(o: { lock?: boolean; features?: string[] } = {}) {
  h = await startHarness({
    relay: { relayFeatures: o.features ?? ['schedules/1', CONFIG_PROPOSE_FEATURE] },
    ...(o.lock ? { config: ((c: Record<string, unknown>) => ({ ...c, settings_lock: true })) as never } : {}),
  })
  return h
}

const thread = () => (h as Harness).bridge.ctx.config.config.default_thread
const call = async (args: Record<string, unknown>) => {
  const r = await (h as Harness).bridge.callTool('permission_mode', { thread_id: thread(), ...args })
  return { error: r.isError === true, text: r.content[0]?.text ?? '' }
}
const reqPath = () => join((h as Harness).home, PERMISSION_MODE_REQUEST_FILE)
const readReq = () => JSON.parse(readFileSync(reqPath(), 'utf8')) as Record<string, unknown>
/** The owner said something in the thread (his own words). */
async function ownerAsks(text = 'switch yourself to ask me') {
  const x = h as Harness
  await x.app.sendMessage(thread(), text)
  await waitFor(
    () => x.bridge.ctx.store.ownerRowsSince(new Date(Date.now() - 60_000).toISOString(), 9).length >= 1,
    5000,
    'the owner row',
  )
  await sleep(20)
}
/** Outside text (an email, a page, a peer) reached the agent in the thread after the owner spoke. */
function outsideText() {
  noteOutsideText((h as Harness).bridge.ctx, { meta: { thread_id: thread(), trust: 'external' } })
}
const cards = () =>
  (h as Harness).relay.frames
    .filter((f) => f.direction === 'from_bridge' && f.raw.type === 'card.create')
    .map((f) => f.raw.card as CardT)
    .filter(isPermissionModeCard)
const updates = (id: string) =>
  (h as Harness).relay.frames
    .filter((f) => f.direction === 'from_bridge' && f.raw.type === 'card.update' && f.raw.card_id === id)
    .map((f) => f.raw as { state?: string; result?: { ok: boolean; text: string } })
const ended = (id: string, state: 'done' | 'failed') => updates(id).find((u) => u.state === state)

describe('the record', () => {
  test('main-only, live-only, never headless, never for a thread session', () => {
    const r = AGENT_TOOLS.permission_mode
    expect(r).toBeDefined()
    expect(r?.worker).toBe(false)
    expect(r?.headless).toBe(false)
    expect(r?.liveOnly).toBe(true)
    expect(r?.told).toEqual(['main'])
    expect(toolsFor({ scheduler: 'auto' }).map((t) => t.name)).toContain('permission_mode')
    for (const scheduler of ['auto', 'off'])
      expect(toolsFor({ scheduler, workerThread: 'trip' }).map((t) => t.name)).not.toContain('permission_mode')
  })
})

describe('a stricter change needs no ask; a looser one needs the owner’s words', () => {
  test(
    'ask, with no owner words: the request file is written in the exact shape the Mac parses, mode 0600',
    async () => {
      await start()
      const r = await call({ mode: 'ask' })
      expect(r.error, r.text).toBe(false)
      const req = readReq()
      expect(Object.keys(req).sort()).toEqual(['action', 'control_id', 'mode', 'ts', 'v'])
      expect(req.v).toBe(1)
      expect(req.action).toBe('set_permission_mode')
      expect(req.mode).toBe('ask')
      expect(String(req.control_id)).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
      expect(typeof req.ts).toBe('number')
      expect(Math.abs(Date.now() - (req.ts as number))).toBeLessThan(10_000)
      expect(lstatSync(reqPath()).mode & 0o777).toBe(0o600)
      expect(r.text).toContain('Ask me')
      expect(r.text).toContain('Main will restart')
      expect(r.text).toContain('development-channel dialog')
      expect(r.text).toContain('this session will end')
      expect(cards()).toHaveLength(0)
    },
    t(85_000),
  )

  for (const mode of ['auto', 'bypass'] as const) {
    test(
      `${mode}, the owner asked and no outside text since: written straight away`,
      async () => {
        await start()
        await ownerAsks()
        const r = await call({ mode })
        expect(r.error, r.text).toBe(false)
        expect(readReq().mode).toBe(mode)
        expect(cards()).toHaveLength(0)
      },
      t(100_000),
    )

    test(
      `${mode}, the owner never asked: a card names the mode, nothing is written`,
      async () => {
        await start()
        const r = await call({ mode })
        expect(r.error).toBe(true)
        expect(r.text).toBe(PERMISSION_MODE_TEXT.asked(mode))
        expect(existsSync(reqPath())).toBe(false)
        await eventually(() => expect(cards()).toHaveLength(1))
        const card = cards()[0] as CardT
        const label = mode === 'auto' ? 'Auto (recommended)' : 'Bypass all'
        expect(card.kind).toBe('config')
        expect(card.title).toBe(`Allow the agent to switch to ${label}?`)
        expect(card.primary_label).toBe('Allow')
        expect(card.kill_label).toBe('Not now')
        expect(card.allow_edit).toBe(false)
        expect(card.allow_revise).toBe(false)
        expect((card.payload as { permission_mode: { mode: string } }).permission_mode).toEqual({ mode })
      },
      t(95_000),
    )

    test(
      `${mode}, outside text reached the agent after the owner spoke: a card, nothing is written`,
      async () => {
        await start()
        await ownerAsks()
        outsideText()
        const r = await call({ mode })
        expect(r.error).toBe(true)
        expect(r.text).toBe(PERMISSION_MODE_TEXT.asked(mode))
        expect(existsSync(reqPath())).toBe(false)
        await eventually(() => expect(cards()).toHaveLength(1))
      },
      t(110_000),
    )
  }

  test(
    'while a card for the mode waits, asking again makes no second card (even at the same moment)',
    async () => {
      await start()
      const r = await Promise.all([call({ mode: 'bypass' }), call({ mode: 'bypass' }), call({ mode: 'bypass' })])
      for (const x of r) expect(x.text).toBe(PERMISSION_MODE_TEXT.asked('bypass'))
      await eventually(() => expect(cards()).toHaveLength(1))
      await sleep(t(200)) // timing-ok: negative window: three asks at once leave exactly one card
      expect(cards()).toHaveLength(1)
    },
    t(95_000),
  )
})

describe('the owner answers the card', () => {
  test(
    'Allow: the request is written, the card ends ok, the agent is not told',
    async () => {
      await start()
      await call({ mode: 'bypass' })
      await eventually(() => expect(cards()).toHaveLength(1))
      const card = cards()[0] as CardT
      expect(existsSync(reqPath())).toBe(false)
      await (h as Harness).app.resolveCard(card, 'primary', card.payload_hash)
      await eventually(() => expect(ended(card.id, 'done')).toBeDefined())
      expect(ended(card.id, 'done')?.result?.ok).toBe(true)
      expect(ended(card.id, 'done')?.result?.text).toBe(PERMISSION_MODE_TEXT.allowed('bypass'))
      expect(readReq()).toMatchObject({ v: 1, action: 'set_permission_mode', mode: 'bypass' })
      expect(lstatSync(reqPath()).mode & 0o777).toBe(0o600)
      expect((h as Harness).notes.filter((n) => n.meta?.kind === 'card_action')).toHaveLength(0)
    },
    t(105_000),
  )

  test(
    'Not now: nothing is written, the next ask is told so, and an hour on it asks again',
    async () => {
      await start()
      await call({ mode: 'auto' })
      await eventually(() => expect(cards()).toHaveLength(1))
      const card = cards()[0] as CardT
      await (h as Harness).app.resolveCard(card, 'kill', card.payload_hash)
      await eventually(() => expect(ended(card.id, 'done')).toBeDefined())
      expect(existsSync(reqPath())).toBe(false)
      const again = await call({ mode: 'auto' })
      expect(again.error).toBe(true)
      expect(again.text).toBe(PERMISSION_MODE_TEXT.notNow('auto'))
      await sleep(t(150)) // timing-ok: negative window: the refused ask raises no second card
      expect(cards()).toHaveLength(1)
      const ctx = (h as Harness).bridge.ctx
      const key = ctx.store.kvKeys('pmc:')[0] as string
      const rec = JSON.parse(ctx.store.kvGet(key) as string) as { not_now_until: number }
      expect(rec.not_now_until - Date.now()).toBeGreaterThan(PERMISSION_NOT_NOW_MS - 60_000)
      ctx.store.kvSet(key, JSON.stringify({ ...rec, not_now_until: Date.now() - 1 }))
      expect((await call({ mode: 'auto' })).text).toBe(PERMISSION_MODE_TEXT.asked('auto'))
      await eventually(() => expect(cards()).toHaveLength(2))
    },
    t(115_000),
  )

  test(
    'the owner turns Lock on between the card and his Allow: the card fails in words and nothing is written',
    async () => {
      await start()
      await call({ mode: 'bypass' })
      await eventually(() => expect(cards()).toHaveLength(1))
      const card = cards()[0] as CardT
      const ctx = (h as Harness).bridge.ctx
      ctx.config.applyPatch(ctx.config.config.rev, { settings_lock: true }, Date.now())
      await (h as Harness).app.resolveCard(card, 'primary', card.payload_hash)
      await eventually(() => expect(ended(card.id, 'failed')).toBeDefined())
      expect(ended(card.id, 'failed')?.result?.ok).toBe(false)
      expect(ended(card.id, 'failed')?.result?.text).toContain(SETTINGS_LOCKED)
      expect(existsSync(reqPath())).toBe(false)
    },
    t(105_000),
  )

  test(
    'the settings-card list never shows these cards',
    async () => {
      await start()
      await call({ mode: 'bypass' })
      await eventually(() => expect(cards()).toHaveLength(1))
      const r = await (h as Harness).bridge.callTool('settings_read', {})
      const t = r.content[0]?.text ?? ''
      expect(t).toContain('Pending settings cards: none')
      expect(t).not.toContain((cards()[0] as CardT).id)
    },
    t(95_000),
  )

  test(
    'a relay without settings cards: the agent is told the owner could not be asked, no card, nothing written',
    async () => {
      await start({ features: ['schedules/1'] })
      const r = await call({ mode: 'bypass' })
      expect(r.error).toBe(true)
      expect(r.text).toContain('could not ask the owner')
      expect(cards()).toHaveLength(0)
      expect(existsSync(reqPath())).toBe(false)
    },
    t(85_000),
  )
})

describe('the Lock refuses every mode', () => {
  for (const mode of ['auto', 'ask', 'bypass'] as const) {
    test(
      `${mode}: the one sentence, no file, no card (even when the owner asked)`,
      async () => {
        await start({ lock: true })
        await ownerAsks()
        const r = await call({ mode })
        expect(r.error).toBe(true)
        expect(r.text).toBe(SETTINGS_LOCKED)
        expect(existsSync(reqPath())).toBe(false)
        await sleep(t(150)) // timing-ok: negative window: a Locked refusal raises no card
        expect(cards()).toHaveLength(0)
      },
      t(100_000),
    )
  }
})

describe('who and where', () => {
  test(
    'a thread session (a lead) calling it is refused and writes nothing',
    async () => {
      const NONCE = 'test-nonce-0123456789abcdef'
      h = await startHarness({
        config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
          ...c,
          threads: [
            ...c.threads,
            {
              id: 'trip',
              name: 'Trip',
              kind: 'fixed',
              order: 5,
              notify: 'all',
              voice_context: 'recent',
              mirror: true,
              archived: false,
              created_at: '2026-10-28T00:00:00.000Z',
              session: 'dedicated',
            },
          ],
          dedicated: { enabled: true },
        })) as never,
      })
      await waitFor(() => existsSync(join((h as Harness).home, 'run', 'hub.sock')))
      writeFileSync(
        join(h.home, 'workers.json'),
        JSON.stringify({
          v: 1,
          supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
          threads: {
            trip: {
              session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
              tmux: 't-trip',
              pane_pid: pgidOf(process.pid) as number,
              cwd: h.home,
              restarts: [],
              error: null,
              state: 'live',
            },
          },
        }),
      )
      mkdirSync(join(h.home, 'workers', 'trip'), { recursive: true })
      writeFileSync(join(h.home, 'workers', 'trip', 'nonce'), NONCE)
      const trip = await Bridge.create({
        env: loadEnv({
          TALOS_APP_HOME: h.home,
          TALOS_APP_RELAY_URL: h.relay.httpUrl,
          TALOS_APP_WORKER_THREAD: 'trip',
          TALOS_APP_WORKER_NONCE: NONCE,
        }),
        logger: nullLogger,
      })
      bridges.push(trip)
      expect(await trip.startWorker()).toBe(true)
      const r = await trip.callTool('permission_mode', { thread_id: 'trip', mode: 'ask' })
      expect(r.isError).toBe(true)
      expect(existsSync(reqPath())).toBe(false)
    },
    t(90_000),
  )

  test(
    'a headless bridge is refused',
    async () => {
      await start()
      const headless = await Bridge.create({
        env: loadEnv({ TALOS_APP_HOME: (h as Harness).home, TALOS_APP_RELAY_URL: (h as Harness).relay.httpUrl }),
        logger: nullLogger,
      })
      bridges.push(headless)
      const r = await headless.callTool('permission_mode', { thread_id: thread(), mode: 'ask' })
      expect(r.isError).toBe(true)
      expect(existsSync(reqPath())).toBe(false)
    },
    t(85_000),
  )

  test(
    'on a computer that is not a Mac it says so and writes nothing',
    async () => {
      await start()
      OWNER_HOST_TEST.host = 'linux'
      const r = await call({ mode: 'ask' })
      expect(r.error).toBe(true)
      expect(r.text).toBe(PERMISSION_MODE_TEXT.notMac)
      expect(existsSync(reqPath())).toBe(false)
    },
    t(85_000),
  )

  test(
    'a bad mode, a missing or unknown thread: refused in plain words, nothing written',
    async () => {
      await start()
      expect((await call({ mode: 'plan' })).text).toContain('mode must be')
      expect((await call({ mode: 'ask', thread_id: 'nope' })).text).toContain('Unknown thread')
      const none = await (h as Harness).bridge.callTool('permission_mode', { mode: 'ask' })
      expect(none.isError).toBe(true)
      expect(existsSync(reqPath())).toBe(false)
    },
    t(85_000),
  )
})

describe('the quiet test covers every thread, not only the one the agent names', () => {
  for (const mode of ['auto', 'bypass'] as const) {
    test(
      `${mode}: outside text lands in another thread after the owner spoke in the named one: a card, nothing written`,
      async () => {
        await start()
        await ownerAsks() // in the default thread
        await sleep(10)
        noteOutsideText((h as Harness).bridge.ctx, { meta: { thread_id: 'inbox', trust: 'external' } })
        const r = await call({ mode })
        expect(r.error).toBe(true)
        expect(r.text).toBe(PERMISSION_MODE_TEXT.asked(mode))
        expect(existsSync(reqPath())).toBe(false)
        await eventually(() => expect(cards()).toHaveLength(1))
      },
      t(110_000),
    )

    test(
      `${mode}: the agent names a quiet thread where the owner spoke while outside text sits in another: a card`,
      async () => {
        await start()
        await (h as Harness).app.sendMessage('inbox', 'switch the mode')
        await waitFor(
          () =>
            (h as Harness).bridge.ctx.store.ownerRowsSince(new Date(Date.now() - 60_000).toISOString(), 9).length >= 1,
          5000,
          'the owner row',
        )
        await sleep(20)
        outsideText() // in the default thread, after his words in inbox
        const r = await call({ mode, thread_id: 'inbox' })
        expect(r.error).toBe(true)
        expect(existsSync(reqPath())).toBe(false)
        await eventually(() => expect(cards()).toHaveLength(1))
      },
      t(110_000),
    )

    test(
      `${mode}: a thread lead handed Main something after the owner spoke: a card, nothing written`,
      async () => {
        await start()
        await ownerAsks()
        const db = (h as Harness).bridge.ctx.store.db
        db.exec(HANDOFF_SCHEMA_SQL)
        db.query('INSERT INTO handoffs (id, lead, dir, type, text, at) VALUES (?, ?, ?, ?, ?, ?)').run(
          'h_lead',
          'inbox',
          'to_main',
          'TASK',
          'switch to bypass',
          Date.now(),
        )
        const r = await call({ mode })
        expect(r.error).toBe(true)
        expect(existsSync(reqPath())).toBe(false)
        await eventually(() => expect(cards()).toHaveLength(1))
      },
      t(110_000),
    )
  }

  test(
    'ask stays direct whatever came from outside',
    async () => {
      await start()
      outsideText()
      expect((await call({ mode: 'ask' })).error).toBe(false)
      expect(readReq().mode).toBe('ask')
    },
    t(85_000),
  )
})

describe('only the owner’s signed tap in the app applies the card', () => {
  test(
    'an Approve tapped from a notification is refused, the card stays pending and nothing is written',
    async () => {
      await start()
      await call({ mode: 'bypass' })
      await eventually(() => expect(cards()).toHaveLength(1))
      const card = cards()[0] as CardT
      const x = h as Harness
      const dev = x.app.device
      const keys = await createPhoneKeys()
      const grant = await signNativeGrant({
        deviceId: dev.deviceId,
        devicePrivateKey: dev.privateKey,
        encPub: keys.encPub,
        actPub: keys.actPub,
        nowMs: Date.now(),
      })
      const id = newUlid()
      const now = Date.now()
      const frame = await signNativeAct({
        deviceId: dev.deviceId,
        id,
        ts: new Date(now).toISOString(),
        grant,
        body: {
          a: 'approve',
          shown_v: '3',
          card_id: card.id,
          payload_hash: card.payload_hash,
          shown: shownHash(cardNotice(card).text, 'General'),
        },
        actPrivateKey: keys.act.privateKey,
      })
      x.relay.sendToBridge({ ...frame, relay: { seq: 1, received_at: new Date(now).toISOString() } }, { durable: true })
      const err = await x.relay.expectFrame('error', (f) => f.ref === id, { direction: 'from_bridge' })
      expect(err.code).toBe('open_in_app')
      expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
      expect(existsSync(reqPath())).toBe(false)
    },
    t(100_000),
  )

  test(
    'the branch itself applies only a signed card.resolve: any other frame kind fails the card and writes nothing',
    async () => {
      await start()
      await call({ mode: 'bypass' })
      await eventually(() => expect(cards()).toHaveLength(1))
      const card = cards()[0] as CardT
      const ctx = (h as Harness).bridge.ctx
      const row = ctx.ledger.get(card.id)
      if (!row) throw new Error('no row')
      await ctx.permissionModeConsent?.onResolved(row, 'primary', 'native.act')
      expect(existsSync(reqPath())).toBe(false)
      await eventually(() => expect(ended(card.id, 'failed')).toBeDefined())
    },
    t(105_000),
  )
})

describe('what the card says is right in both directions', () => {
  test(
    'auto: no "asks you less often" claim; it runs without routine prompts and asks for the rest',
    async () => {
      await start()
      await call({ mode: 'auto' })
      await eventually(() => expect(cards()).toHaveLength(1))
      const card = cards()[0] as CardT
      expect(card.summary).toContain('without routine prompts')
      expect(card.summary).toContain('ask for the rest')
      expect(`${card.summary} ${card.warning ?? ''}`).not.toMatch(/less often|fewer/)
    },
    t(95_000),
  )
  test(
    'bypass keeps its plain warning',
    async () => {
      await start()
      await call({ mode: 'bypass' })
      await eventually(() => expect(cards()).toHaveLength(1))
      const card = cards()[0] as CardT
      expect(card.warning).toBe('The agent could then do anything without asking you.')
    },
    t(95_000),
  )
})

describe('one request at a time, two minutes apart', () => {
  test(
    'a request the Mac has not taken yet is never written over',
    async () => {
      await start()
      writeFileSync(reqPath(), '{"v":1,"unhandled":true}')
      const before = readFileSync(reqPath(), 'utf8')
      const r = await call({ mode: 'ask' })
      expect(r.error).toBe(true)
      expect(r.text).toBe(PERMISSION_MODE_TEXT.pending)
      expect(readFileSync(reqPath(), 'utf8')).toBe(before)
    },
    t(85_000),
  )

  test(
    'a second request inside two minutes is refused with the wait; after it, it goes through',
    async () => {
      await start()
      expect((await call({ mode: 'ask' })).error).toBe(false)
      rmSync(reqPath()) // the Mac took it
      const soon = await call({ mode: 'ask' })
      expect(soon.error).toBe(true)
      expect(soon.text).toContain('less than 2 minutes ago')
      expect(existsSync(reqPath())).toBe(false)
      const ctx = (h as Harness).bridge.ctx
      ctx.store.kvSet('pmr:last', String(Date.now() - 121_000))
      expect((await call({ mode: 'ask' })).error).toBe(false)
      expect(existsSync(reqPath())).toBe(true)
    },
    t(85_000),
  )

  test(
    'an Allow inside the gap fails its card in words and writes nothing',
    async () => {
      await start()
      expect((await call({ mode: 'ask' })).error).toBe(false)
      rmSync(reqPath())
      await call({ mode: 'bypass' }) // owner never asked: a card (the gap is not checked for a card, only for a write)
      await eventually(() => expect(cards()).toHaveLength(1))
      const card = cards()[0] as CardT
      await (h as Harness).app.resolveCard(card, 'primary', card.payload_hash)
      await eventually(() => expect(ended(card.id, 'failed')).toBeDefined())
      expect(ended(card.id, 'failed')?.result?.text).toContain('less than 2 minutes ago')
      expect(existsSync(reqPath())).toBe(false)
    },
    t(105_000),
  )
})
