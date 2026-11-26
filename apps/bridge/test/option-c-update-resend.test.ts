// Option C: a worker that ends between `read_inbound` and its answer. The phone showed 'seen' and the deadline stood down,
// so the hub posts one row. Every state that doesn't prove the run ended must post nothing. Real hub, a real worker-mode
// bridge claiming over read_inbound, and workers.json written the way the desktop supervisor writes it. No real claude.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CardT } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { pgidOf } from '../src/hub/server.ts'
import { nullLogger } from '../src/log.ts'
import { ThreadRouter } from '../src/router/router.ts'
import { MARKER_MAX_AGE_MS, noteTurnEnded, readInterrupted, UPDATE_RESEND_TEXT } from '../src/router/update-resend.ts'
import { BRIDGE_COMMIT } from '../src/version.ts'
import { checkWorkerFolder } from '../src/worker/patch-check.ts'
import type { WorkerStore } from '../src/worker/store.ts'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'

const NONCE = 'test-nonce-0123456789abcdef'
const SESSION = '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41'
const ROW = 'stopped before it answered'
let h: Harness | undefined
let worker: Bridge | undefined
afterEach(async () => {
  await worker?.stop()
  worker = undefined
  await h?.stop()
  h = undefined
})

type Entry = { state: string; pane_pid?: number; started_at?: string; restarts?: string[] }

function writeWorkers(home: string, entry: Entry | null, heartbeat = new Date().toISOString()) {
  const threads = entry
    ? {
        trip: {
          session_id: SESSION,
          tmux: 't-trip',
          pane_pid: 0,
          cwd: home,
          restarts: [],
          error: null,
          ...entry,
        },
      }
    : {}
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({ v: 1, supervisor: { pid: 1, heartbeat_at: heartbeat, workers_supported: true }, threads }),
  )
}

/** A hub with a live worker for `trip` that has claimed `n` messages. */
async function claimed(n = 1): Promise<{ hub: Harness; me: number; startedAt: string }> {
  const hub = await startHarness({
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
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
          session: 'dedicated',
        },
      ],
      dedicated: { enabled: true },
    })) as never,
  })
  h = hub
  await waitFor(() => existsSync(join(hub.home, 'run', 'hub.sock')))
  const me = pgidOf(process.pid) as number
  const startedAt = new Date(Date.now() - 60_000).toISOString()
  writeWorkers(hub.home, { state: 'live', pane_pid: me, started_at: startedAt })
  mkdirSync(join(hub.home, 'workers', 'trip'), { recursive: true })
  writeFileSync(join(hub.home, 'workers', 'trip', 'nonce'), NONCE)
  worker = await Bridge.create({
    env: loadEnv({
      TALOS_APP_HOME: hub.home,
      TALOS_APP_RELAY_URL: hub.relay.httpUrl,
      TALOS_APP_WORKER_THREAD: 'trip',
      TALOS_APP_WORKER_NONCE: NONCE,
    }),
    logger: nullLogger,
  })
  const ok = await worker.startWorker()
  expect(ok, `the worker was refused: ${JSON.stringify(worker.hubClient?.lastRefusal)}`).toBe(true)
  for (let i = 0; i < n; i++) await hub.app.sendMessage('trip', `message ${i}`)
  await waitFor(() => (hub.bridge.router?.store.unclaimed('trip').length ?? 0) === n)
  const r = JSON.parse((await worker.callTool('read_inbound', {})).content[0]?.text ?? '{}')
  expect(r.messages).toHaveLength(n)
  return { hub, me, startedAt }
}

function rows(hub: Harness): string[] {
  return hub.bridge.ctx.store
    .page({ thread_id: 'trip', limit: 50 })
    .messages.filter((m) => m.author === 'system' && m.text?.includes(ROW))
    .map((m) => m.text ?? '')
}

async function ticks(hub: Harness, n = 2) {
  for (let i = 0; i < n; i++) {
    hub.bridge.optionCTick()
    await sleep(30)
  }
}

/** Ticks until no claim is open: the run's end is settled. */
async function untilSettled(hub: Harness) {
  await waitFor(
    () => {
      if ((hub.bridge.router?.store.openClaims().length ?? 0) === 0) return true
      hub.bridge.optionCTick()
      return false
    },
    3000,
    'the claim to be settled',
  )
}

/** Ticks until the row lands: a loaded machine can finish a fixed number of ticks before it does. */
async function untilRow(hub: Harness) {
  await waitFor(
    () => {
      if (rows(hub).length > 0) return true
      hub.bridge.optionCTick()
      return false
    },
    3000,
    'the unanswered row',
  )
}

const COPY = '~again'
const DIR = (hub: Harness) => join(hub.home, 'auto-update')
const FILE = (hub: Harness) => join(DIR(hub), 'update-interrupted.json')

/** The marker as the Mac's updater leaves it: its own 0700 folder, a 0600 file, this bridge's commit (the release's git sha), and the manifest's own x.y.z as its version. */
function mark(hub: Harness, over: Record<string, unknown> = {}, o: { fileMode?: number; dirMode?: number } = {}) {
  mkdirSync(DIR(hub), { recursive: true, mode: 0o700 })
  chmodSync(DIR(hub), o.dirMode ?? 0o700)
  const at = new Date(Date.now() + 1000).toISOString()
  writeFileSync(
    FILE(hub),
    JSON.stringify({ v: 1, at, version: '1.5.0', commit: BRIDGE_COMMIT, threads: ['trip'], ...over }),
    {
      mode: o.fileMode ?? 0o600,
    },
  )
  chmodSync(FILE(hub), o.fileMode ?? 0o600)
  // this bridge started after the update wrote it (the test bridge started before the message, so move its start)
  const r = hub.bridge.router as unknown as { startedAt: number }
  r.startedAt = Date.parse(at) + 5000
}

const offers = (hub: Harness) =>
  hub.relay.frames
    .filter((f) => f.direction === 'from_bridge' && f.raw.type === 'card.create')
    .map((f) => f.raw.card as CardT)
    .filter((c) => (c.payload as { update_resend?: unknown } | undefined)?.update_resend !== undefined)

function ids(hub: Harness) {
  const claim = hub.bridge.router?.store.openClaims()[0]
  const id = claim?.message_id ?? ''
  return { id, copy: () => hub.bridge.router?.store.route(id + COPY) }
}

/** The thread session was restarted by the update: a newer run than the claim. */
async function restarted(hub: Harness, me: number) {
  await sleep(5)
  writeWorkers(hub.home, { state: 'live', pane_pid: me, started_at: new Date().toISOString() })
}

async function offered(hub: Harness) {
  await waitFor(
    () => {
      hub.bridge.optionCTick()
      return offers(hub).length > 0
    },
    3000,
    'the offer',
  )
  return offers(hub)[0] as CardT
}

describe('a turn an Update now cut off is offered again, never sent by itself', () => {
  test('(a) the row is offered in the thread, in plain words, with Send again and Dismiss', async () => {
    const { hub, me } = await claimed()
    mark(hub)
    await restarted(hub, me)
    const card = await offered(hub)
    expect(card.thread_id).toBe('trip')
    expect(card.body).toBe('Talos updated while Trip was working on this. It may have stopped partway.')
    expect(card.primary_label).toBe('Send again')
    expect(card.kill_label).toBe('Dismiss')
    expect(rows(hub)).toHaveLength(0) // the old "send it again" row is not posted as well
  })

  test('(b) nothing is sent until the owner taps, however many ticks pass', async () => {
    const { hub, me } = await claimed()
    const { copy } = ids(hub)
    mark(hub)
    await restarted(hub, me)
    await offered(hub)
    await ticks(hub, 6)
    expect(copy()).toBeUndefined()
    expect(offers(hub)).toHaveLength(1) // one offer per thread, not one per tick
  })

  test(
    '(c) a tap sends exactly one marked copy; a second tap or call sends nothing more',
    async () => {
      const { hub, me } = await claimed()
      const { id, copy } = ids(hub)
      mark(hub)
      await restarted(hub, me)
      const card = await offered(hub)
      await hub.app.resolveCard(card, 'primary', card.payload_hash)
      await waitFor(() => copy() !== undefined, 3000, 'the copy')
      expect(copy()?.notification.meta.redelivered).toBe('update')
      expect(copy()?.notification.content).toContain('restarted for an update')
      expect(copy()?.notification.content).toContain('message 0')
      expect(copy()?.notification.meta.trust).toBe('owner')
      const row = hub.bridge.ctx.ledger.get(card.id)
      expect(row).toBeDefined()
      await hub.bridge.ctx.updateResend?.onResolved(row as never, 'primary', 'card.resolve') // a replayed tap
      await ticks(hub, 3)
      expect(hub.bridge.router?.store.route(id + COPY + COPY)).toBeUndefined()
      expect(hub.bridge.ctx.store.kvGet(`update_resent:${id}`)).toBeDefined()
    },
    t(30_000),
  )

  test(
    'a send that fails is not marked sent, the card says so and names the message, and a later tap can still send it',
    async () => {
      const { hub, me } = await claimed()
      const { id, copy } = ids(hub)
      mark(hub)
      await restarted(hub, me)
      const card = await offered(hub)
      const deps = (hub.bridge.ctx.updateResend as unknown as { deps: { route: (n: unknown) => Promise<void> } }).deps
      const real = deps.route
      deps.route = async () => {
        throw new Error('the queue is full')
      }
      await hub.app.resolveCard(card, 'primary', card.payload_hash)
      const update = () =>
        hub.relay.frames.find(
          (f) =>
            f.direction === 'from_bridge' &&
            f.raw.type === 'card.update' &&
            f.raw.card_id === card.id &&
            f.raw.state !== 'resolved',
        )?.raw as { state: string; result: { ok: boolean; text: string } } | undefined
      await waitFor(() => update() !== undefined, 3000, 'the card update')
      expect(update()?.state).toBe('failed')
      expect(update()?.result.ok).toBe(false)
      expect(update()?.result.text).toContain('did not go')
      expect(update()?.result.text).toContain(card.fields[0]?.value as string)
      expect(copy()).toBeUndefined()
      expect(hub.bridge.ctx.store.kvGet(`update_resent:${id}`)).toBeUndefined() // not marked sent
      // the queue works again: a tap (here a direct call, as the replayed tap above) sends it, once
      deps.route = real
      await hub.bridge.ctx.updateResend?.onResolved(
        hub.bridge.ctx.ledger.get(card.id) as never,
        'primary',
        'card.resolve',
      )
      await waitFor(() => copy() !== undefined, 3000, 'the copy')
      expect(hub.bridge.ctx.store.kvGet(`update_resent:${id}`)).toBeDefined()
    },
    t(30_000),
  )

  test('Dismiss sends nothing', async () => {
    const { hub, me } = await claimed()
    const { copy } = ids(hub)
    mark(hub)
    await restarted(hub, me)
    const card = await offered(hub)
    await hub.app.resolveCard(card, 'kill', card.payload_hash)
    await ticks(hub, 3)
    expect(copy()).toBeUndefined()
  })

  test('only the in-app tap sends: any other way of answering the card is refused', async () => {
    const { hub, me } = await claimed()
    const { copy } = ids(hub)
    mark(hub)
    await restarted(hub, me)
    const card = await offered(hub)
    const row = hub.bridge.ctx.ledger.get(card.id)
    await hub.bridge.ctx.updateResend?.onResolved(row as never, 'primary', 'native.act')
    expect(copy()).toBeUndefined()
  })

  test(
    'a thread that had already replied is offered too: Talos cannot tell what else it did',
    async () => {
      const { hub, me } = await claimed()
      const { copy } = ids(hub)
      await worker?.callTool('reply', { thread_id: 'trip', text: 'Sent the email.' })
      await waitFor(() =>
        hub.bridge.ctx.store.page({ thread_id: 'trip', limit: 50 }).messages.some((m) => m.author === 'agent'),
      )
      mark(hub)
      await restarted(hub, me)
      await offered(hub)
      expect(copy()).toBeUndefined()
    },
    t(30_000),
  )

  test('a thread whose turn the owner ended (Stop, Restart, Start fresh) after the message is not offered', async () => {
    const { hub, me } = await claimed()
    await sleep(5)
    noteTurnEnded(hub.bridge.ctx, 'trip')
    mark(hub)
    await restarted(hub, me)
    await ticks(hub, 4)
    expect(offers(hub)).toHaveLength(0)
    await untilRow(hub) // the plain "send it again" row, as for any ended turn
  })

  test("a Stop of ANOTHER thread does not hide this thread's offer", async () => {
    const { hub, me } = await claimed()
    await sleep(5)
    noteTurnEnded(hub.bridge.ctx, 'other')
    mark(hub)
    await restarted(hub, me)
    await offered(hub)
  })
})

describe('a planted or stale marker offers nothing', () => {
  async function none(hub: Harness, me: number) {
    await restarted(hub, me)
    await ticks(hub, 4)
    expect(offers(hub)).toHaveLength(0)
    expect(ids(hub).copy()).toBeUndefined()
  }

  test('wrong file mode: refused and deleted', async () => {
    const { hub, me } = await claimed()
    mark(hub, {}, { fileMode: 0o644 })
    await none(hub, me)
    expect(existsSync(FILE(hub))).toBe(false)
  })

  test('wrong folder mode: refused', async () => {
    const { hub, me } = await claimed()
    mark(hub, {}, { dirMode: 0o755 })
    await none(hub, me)
  })

  test('a link in place of the file: refused', async () => {
    const { hub, me } = await claimed()
    mark(hub)
    rmSync(FILE(hub))
    writeFileSync(join(hub.home, 'elsewhere.json'), '{"v":1}')
    symlinkSync(join(hub.home, 'elsewhere.json'), FILE(hub))
    await none(hub, me)
  })

  test('another commit: refused and left for the bridge it is for', async () => {
    const { hub, me } = await claimed()
    mark(hub, { commit: 'f'.repeat(40) })
    await none(hub, me)
    expect(existsSync(FILE(hub))).toBe(true)
  })

  test('older than an hour, a torn file, or the wrong shape: refused and deleted', async () => {
    const { hub, me } = await claimed()
    mark(hub, { at: new Date(Date.now() - MARKER_MAX_AGE_MS - 60_000).toISOString() })
    await none(hub, me)
    expect(existsSync(FILE(hub))).toBe(false)
    mark(hub, { v: 2 })
    await ticks(hub, 2)
    expect(existsSync(FILE(hub))).toBe(false)
    writeFileSync(FILE(hub), '{ half a file', { mode: 0o600 })
    await ticks(hub, 2)
    expect(offers(hub)).toHaveLength(0)
  })

  test('a bridge that started before the marker was written leaves it alone', async () => {
    const { hub, me } = await claimed()
    mark(hub)
    ;(hub.bridge.router as unknown as { startedAt: number }).startedAt = Date.now() - 3600_000
    await none(hub, me)
    expect(existsSync(FILE(hub))).toBe(true)
  })

  test('it names a thread the claim is not in: nothing is offered', async () => {
    const { hub, me } = await claimed()
    mark(hub, { threads: ['other'] })
    await none(hub, me)
  })

  test('an accepted marker is read once: the file is gone and a second bridge finds nothing', async () => {
    const { hub, me } = await claimed()
    mark(hub)
    await restarted(hub, me)
    await offered(hub)
    expect(existsSync(FILE(hub))).toBe(false)
    const again = readInterrupted(FILE(hub), {
      now: Date.now(),
      startedAt: Date.now() + 10_000,
      commit: BRIDGE_COMMIT,
    })
    expect(again).toEqual({ list: null, why: 'absent' })
  })

  test('the file is private to the app: lstat of what the test wrote is 0600 in a 0700 folder', async () => {
    const { hub } = await claimed()
    mark(hub)
    expect(lstatSync(FILE(hub)).mode & 0o777).toBe(0o600)
    expect(lstatSync(DIR(hub)).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(FILE(hub), 'utf8')).threads).toEqual(['trip'])
    expect(UPDATE_RESEND_TEXT.body('Trip')).toContain('may have stopped partway')
  })

  test("a marker with a manifest-shaped version (x.y.z) and this bridge's commit is accepted: the version name never has to match", async () => {
    expect(BRIDGE_COMMIT).toBeDefined()
    const now = Date.now()
    const dir = join(tmpdir(), `talos-marker-${Date.now()}`)
    mkdirSync(dir, { mode: 0o700 })
    const f = join(dir, 'update-interrupted.json')
    const write = (o: Record<string, unknown>) => {
      writeFileSync(f, JSON.stringify({ v: 1, at: new Date(now).toISOString(), threads: ['t'], ...o }), { mode: 0o600 })
    }
    const seen = { now, startedAt: now + 1000, commit: BRIDGE_COMMIT }
    write({ version: '1.5.0', commit: BRIDGE_COMMIT })
    expect(readInterrupted(f, seen).why).toBe('accepted')
    write({ version: '1.5.0', commit: (BRIDGE_COMMIT ?? '').slice(0, 12) }) // a short sha of the same commit
    expect(readInterrupted(f, seen).why).toBe('accepted')
    write({ version: BRIDGE_COMMIT ? '1.5.0' : '', commit: '0'.repeat(40) })
    expect(readInterrupted(f, seen)).toEqual({ list: null, why: 'other_commit' })
    write({ version: '1.5.0' }) // no commit: nothing to bind it to
    expect(readInterrupted(f, seen).list).toBeNull()
    write({ version: '1.5.0', commit: 'not-hex' })
    expect(readInterrupted(f, seen).list).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('the card shows what it will send', () => {
  test("each message's first line is on the card, clipped to 80 characters, and bound by its hash", async () => {
    const { hub, me } = await claimed(2)
    mark(hub)
    await restarted(hub, me)
    const card = await offered(hub)
    expect(card.fields.map((f) => f.value)).toEqual(['message 0', 'message 1'])
    expect(card.fields.every((f) => f.editable === false)).toBe(true)
    // changing what is shown changes the hash the owner's tap is checked against
    const other = { ...card, fields: card.fields.map((f) => ({ ...f, value: 'something else' })) }
    const { bindingFrom, payloadHash } = await import('@talos-app/protocol')
    expect(payloadHash(bindingFrom(other))).not.toBe(card.payload_hash)
  })

  test('a long or odd first line is clipped and cleaned', async () => {
    const { shownLine } = await import('../src/router/update-resend.ts')
    const n = { content: `\n\u0007${'x'.repeat(200)}\nsecond`, meta: {} }
    const line = shownLine(n)
    expect(line.length).toBeLessThanOrEqual(81)
    expect([...line].some((c) => c.charCodeAt(0) < 32)).toBe(false)
    expect(shownLine(undefined)).toBe('(no text)')
  })

  test('more than five messages: the newest five are on the card and the rest get the plain notice, never silence', async () => {
    const { hub, me } = await claimed(7)
    mark(hub)
    await restarted(hub, me)
    const card = await offered(hub)
    expect(card.fields).toHaveLength(5)
    await untilRow(hub) // the plain "send the message again" notice for the older ones
    expect(rows(hub)).toHaveLength(1)
  })

  test('a tap is refused when what is held no longer matches what the card showed', async () => {
    const { hub, me } = await claimed()
    const { copy } = ids(hub)
    mark(hub)
    await restarted(hub, me)
    const card = await offered(hub)
    const row = hub.bridge.ctx.ledger.get(card.id)
    const forged = {
      ...(row as object),
      binding: {
        ...(row as { binding: object }).binding,
        fields: [{ key: 'm1', label: 'Message 1', value: 'wire the money', editable: false, multiline: false }],
      },
    }
    await hub.bridge.ctx.updateResend?.onResolved(forged as never, 'primary', 'card.resolve')
    expect(copy()).toBeUndefined()
  })
})

describe('an offer is not a settings card', () => {
  test('it does not count as a pending settings card, in settings_read or in the limit', async () => {
    const { hub, me } = await claimed()
    mark(hub)
    await restarted(hub, me)
    await offered(hub)
    const { isUpdateResendCard } = await import('../src/router/update-resend.ts')
    const pendingUpdate = hub.bridge.ctx.ledger.list('pending').filter((r) => isUpdateResendCard(r.binding))
    expect(pendingUpdate.length).toBeGreaterThan(0)
    const r = await hub.bridge.callTool('settings_read', { thread_id: 'trip' })
    expect(r.content[0]?.text ?? '').toContain('Pending settings cards: none')
  })
})
