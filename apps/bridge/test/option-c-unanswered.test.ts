// Option C: a worker that ends between `read_inbound` and its answer. The phone showed 'seen' and the deadline stood down,
// so the hub posts one row. Every state that doesn't prove the run ended must post nothing. Real hub, a real worker-mode
// bridge claiming over read_inbound, and workers.json written the way the desktop supervisor writes it. No real claude.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { pgidOf } from '../src/hub/server.ts'
import { nullLogger } from '../src/log.ts'
import { ThreadRouter } from '../src/router/router.ts'
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
          voice_context: 'recent',
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
          session: 'dedicated',
        },
      ],
      dedicated: { enabled: true },
    })) as never,
  })
  h = hub
  await waitFor(() => existsSync(join(hub.home, 'hub.sock')))
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

describe('a worker that ends after claiming', () => {
  test('a run that was parked or failed leaves one row, however many messages and ticks', async () => {
    const { hub } = await claimed(3)
    writeWorkers(hub.home, { state: 'parked', restarts: [new Date().toISOString()] })
    await ticks(hub, 4)
    expect(rows(hub)).toHaveLength(1)
  })

  test('failed, the same', async () => {
    const { hub } = await claimed()
    writeWorkers(hub.home, { state: 'failed' })
    await ticks(hub)
    expect(rows(hub)).toHaveLength(1)
  })

  test('a new run started after the claim: the old turn is gone even though the state reads live', async () => {
    const { hub, me } = await claimed()
    await sleep(5)
    writeWorkers(hub.home, { state: 'live', pane_pid: me, started_at: new Date().toISOString() })
    await ticks(hub)
    expect(rows(hub)).toHaveLength(1)
  })

  test('a hub restart does not repeat it', async () => {
    const { hub } = await claimed()
    writeWorkers(hub.home, { state: 'parked' })
    await ticks(hub)
    expect(rows(hub)).toHaveLength(1)
    // a fresh router over the same database, as after a restart
    new ThreadRouter(hub.bridge.ctx, async () => {}).tick(() => {})
    await sleep(30)
    expect(rows(hub)).toHaveLength(1)
  })
})

describe('nothing proves the run ended, so no row', () => {
  test('still running, even with no answer yet', async () => {
    const { hub, me, startedAt } = await claimed()
    for (const state of ['live', 'busy', 'stopping', 'parking', 'starting']) {
      writeWorkers(hub.home, { state, pane_pid: me, started_at: startedAt })
      await ticks(hub)
    }
    expect(rows(hub)).toHaveLength(0)
  })

  test('no date to compare, or one that cannot be read', async () => {
    const { hub, me } = await claimed()
    writeWorkers(hub.home, { state: 'live', pane_pid: me })
    await ticks(hub)
    writeWorkers(hub.home, { state: 'live', pane_pid: me, started_at: 'soon' })
    await ticks(hub)
    expect(rows(hub)).toHaveLength(0)
  })

  test('the supervisor is down: then it comes back and the row goes out', async () => {
    const { hub } = await claimed()
    writeWorkers(hub.home, { state: 'parked' }, new Date(Date.now() - 60_000).toISOString())
    await ticks(hub)
    expect(rows(hub)).toHaveLength(0)
    writeWorkers(hub.home, { state: 'parked' })
    await ticks(hub)
    expect(rows(hub)).toHaveLength(1)
  })

  test('the file has no entry for the thread, or no file parses', async () => {
    const { hub } = await claimed()
    writeWorkers(hub.home, null)
    await ticks(hub)
    writeFileSync(join(hub.home, 'workers.json'), '{ half a file')
    await ticks(hub)
    expect(rows(hub)).toHaveLength(0)
  })

  test('a state from a newer build', async () => {
    const { hub } = await claimed()
    writeWorkers(hub.home, { state: 'draining' })
    await ticks(hub)
    expect(rows(hub)).toHaveLength(0)
  })
})

describe('answered, so no row', () => {
  test('the worker replied after the claim', async () => {
    const { hub } = await claimed()
    await worker?.callTool('reply', { thread_id: 'trip', text: 'On it.' })
    await waitFor(() =>
      hub.bridge.ctx.store.page({ thread_id: 'trip', limit: 50 }).messages.some((m) => m.author === 'agent'),
    )
    writeWorkers(hub.home, { state: 'parked' })
    await ticks(hub)
    expect(rows(hub)).toHaveLength(0)
    expect(hub.bridge.router?.store.openClaims()).toHaveLength(0)
  })

  test('a reply before the claim does not count', async () => {
    const { hub } = await claimed()
    const claim = hub.bridge.router?.store.openClaims()[0]
    expect(claim).toBeDefined()
    expect(hub.bridge.router?.store.answeredSince('trip', (claim?.at ?? 0) + 1)).toBe(false)
  })

  test('the worker raised a card after the claim', async () => {
    const { hub } = await claimed()
    hub.bridge.router?.store.setCardRaiser('c_01', 'trip', Date.now() + 1)
    writeWorkers(hub.home, { state: 'parked' })
    await ticks(hub)
    expect(rows(hub)).toHaveLength(0)
  })

  test('a card tap the worker read needs no answer', async () => {
    const { hub } = await claimed(0)
    const store = hub.bridge.router?.store as WorkerStore
    const now = Date.now()
    store.addRoute({
      message_id: 'a_01',
      thread_id: 'trip',
      notification: { content: '', meta: { kind: 'card_action', thread_id: 'trip' } },
      woke_at: now,
      deadline_at: now + 60_000,
      cold: false,
    })
    store.claim('a_01', 'worker:trip', now)
    writeWorkers(hub.home, { state: 'parked' })
    await ticks(hub)
    expect(rows(hub)).toHaveLength(0)
  })

  test("main's own claims are never reported", async () => {
    const { hub } = await claimed(0)
    const store = hub.bridge.router?.store as WorkerStore
    const now = Date.now()
    store.addRoute({
      message_id: 'm_02',
      thread_id: 'trip',
      notification: { content: 'x', meta: { kind: 'text', thread_id: 'trip' } },
      woke_at: now,
      deadline_at: now + 60_000,
      cold: false,
    })
    store.claim('m_02', 'main', now)
    writeWorkers(hub.home, { state: 'parked' })
    await ticks(hub)
    expect(rows(hub)).toHaveLength(0)
  })
})

describe('an approval the worker read and then did not finish', () => {
  /** The worker raises a card, the owner taps `action` on it, and the worker reads the tap. */
  async function approvedAndRead(action: 'primary' | 'kill' = 'primary') {
    const { hub, me, startedAt } = await claimed(0)
    const res = await (worker as Bridge).callTool('card', {
      thread_id: 'trip',
      kind: 'decision',
      title: 'Book the hotel',
      primary_label: 'Book',
      kill_label: 'Kill it',
      risk: 'low',
      origin: 'chat',
      destination: [],
    })
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    const created = await hub.relay.expectFrame('card.create', (f) => f.card.thread_id === 'trip', {
      direction: 'from_bridge',
    })
    await hub.app.resolveCard(created.card, action, created.card.payload_hash)
    await waitFor(() => (hub.bridge.router?.store.unclaimed('trip').length ?? 0) === 1)
    const read = await (worker as Bridge).callTool('read_inbound', {})
    const r = JSON.parse(read.content[0]?.text ?? '{}')
    expect(r.messages[0]?.meta).toMatchObject({ kind: 'card_action', card_id: created.card.id })
    const id = created.card.id
    const notes = () =>
      hub.bridge.ctx.store
        .page({ thread_id: 'trip', limit: 50 })
        .messages.filter((m) => m.author === 'system' && m.text?.includes('Book the hotel'))
        .map((m) => m.text ?? '')
    return { hub, me, startedAt, id, notes, state: () => hub.bridge.ctx.ledger.get(id)?.state }
  }

  test('the run ends with the card unfinished: it ends as "may have run", the owner is told once', async () => {
    const t = await approvedAndRead()
    writeWorkers(t.hub.home, { state: 'failed' })
    await ticks(t.hub, 3)
    expect(t.state()).toBe('failed')
    const upd = await t.hub.relay.expectFrame('card.update', (f) => f.card_id === t.id && f.state === 'failed', {
      direction: 'from_bridge',
    })
    expect(upd.result).toMatchObject({ ok: false, ran: 'unknown' })
    await waitFor(() => t.notes().length === 1, 5000, 'the owner notice')
    expect(t.notes()[0]).toContain('It may have run')
    expect(t.hub.bridge.router?.store.openClaims()).toHaveLength(0)
  })

  test('a worker that dies after sending its result but before the Mac records it: the card stays done, no failure, no note', async () => {
    const t = await approvedAndRead()
    // The worker's own card_result sends the update over the real hub socket, then records the result. Stop it between the
    // two, as a crash would: the update reaches the hub and the relay, and the worker never finishes the card.
    ;(worker as Bridge).ctx.ledger.finish = () => {
      throw new Error('the worker died here')
    }
    await (worker as Bridge).callTool('card_result', { card_id: t.id, ok: true, text: 'Booked.' })
    await t.hub.relay.expectFrame('card.update', (f) => f.card_id === t.id && f.state === 'done', {
      direction: 'from_bridge',
    })
    expect(t.state()).toBe('resolved') // nothing recorded it
    writeWorkers(t.hub.home, { state: 'failed' })
    await ticks(t.hub, 3)
    const updates = t.hub.relay.frames.filter(
      (r) =>
        r.direction === 'from_bridge' &&
        r.frame.type === 'card.update' &&
        (r.frame as { card_id: string }).card_id === t.id,
    )
    expect(updates.map((r) => (r.frame as { state: string }).state)).toEqual(['resolved', 'done']) // the phone's last word is done
    expect(t.notes()).toHaveLength(0)
  })

  test('a Kill the worker read needs no result: the run ending settles it quietly', async () => {
    const t = await approvedAndRead('kill')
    // a Kill is closed to `done` when the tap is held; put it back as a crash before that would have left it
    t.hub.bridge.ctx.store.db.query("UPDATE cards SET state = 'resolved' WHERE id = ?").run(t.id)
    writeWorkers(t.hub.home, { state: 'failed' })
    await ticks(t.hub, 3)
    expect(t.notes()).toHaveLength(0)
    expect(t.state()).toBe('resolved') // nothing to fail: no result is owed for a Kill
    expect(t.hub.bridge.router?.store.openClaims()).toHaveLength(0)
  })

  test('the card is ended before its claim is settled, so a crash between leaves a claim to try again', async () => {
    const t = await approvedAndRead()
    const store = t.hub.bridge.router?.store as WorkerStore
    let openWhenEnded: number | undefined
    const ledger = t.hub.bridge.ctx.ledger
    const finish = ledger.finish.bind(ledger)
    ledger.finish = (id, ok) => {
      openWhenEnded = store.openClaims().length
      return finish(id, ok)
    }
    writeWorkers(t.hub.home, { state: 'failed' })
    await ticks(t.hub, 2)
    expect(openWhenEnded).toBe(1)
    expect(store.openClaims()).toHaveLength(0)
  })

  test('the worker is still running: the card stays open, and its own result ends it with no note', async () => {
    const t = await approvedAndRead()
    for (const state of ['live', 'busy']) {
      writeWorkers(t.hub.home, { state, pane_pid: t.me, started_at: t.startedAt })
      await ticks(t.hub)
    }
    expect(t.state()).toBe('resolved')
    expect(t.notes()).toHaveLength(0)
    const done = await (worker as Bridge).callTool('card_result', { card_id: t.id, ok: true, text: 'Booked.' })
    expect(done.isError, done.content[0]?.text).toBeFalsy()
    await waitFor(() => t.state() === 'done')
    writeWorkers(t.hub.home, { state: 'parked' })
    await ticks(t.hub, 3)
    expect(t.notes()).toHaveLength(0)
    expect(t.state()).toBe('done')
  })
})

describe('the folder check with ~/.claude a symlink', () => {
  function roots() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'talos-home-')))
    mkdirSync(join(home, 'dotfiles', 'claude', 'projects'), { recursive: true })
    mkdirSync(join(home, 'proj'))
    symlinkSync(join(home, 'dotfiles', 'claude'), join(home, '.claude'))
    symlinkSync(join(home, '.claude', 'projects'), join(home, 'innocent'))
    return { home, talosHome: join(home, 't') }
  }

  test('its real folder, and anything linked to it, are refused', () => {
    const r = roots()
    for (const p of ['dotfiles/claude', 'dotfiles/claude/projects', '.claude/projects', 'innocent'])
      expect(checkWorkerFolder(join(r.home, p), r), p).toContain('.claude')
  })

  test('its neighbours are not', () => {
    const r = roots()
    expect(checkWorkerFolder(join(r.home, 'proj'), r)).toBeNull()
    expect(checkWorkerFolder(join(r.home, 'dotfiles'), r)).toBeNull()
  })
})
