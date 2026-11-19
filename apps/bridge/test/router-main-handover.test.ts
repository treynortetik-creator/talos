// BSUP-4: a route the router claimed for main and was handing over when the bridge stopped must reach main on the next start,
// once. Real hub bridge for the context and the store; two routers over the same store play "before" and "after" a restart.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Notification } from '../src/notify.ts'
import { ThreadRouter } from '../src/router/router.ts'
import { BridgeStopping } from '../src/stopping.ts'
import { workerStoreOf } from '../src/tools/read-inbound.ts'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

async function hub() {
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
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
          session: 'dedicated',
        },
      ],
      dedicated: { enabled: true },
    })) as never,
  })
  await waitFor(() => existsSync(join((h as Harness).home, 'run', 'hub.sock')))
  return h
}

const note = (id: string, kind = 'owner'): Notification => ({
  content: 'Book it',
  meta: { message_id: id, thread_id: 'trip', kind } as Notification['meta'],
})

/** A route already past its deadline, as after a bridge that was down for a while. */
function seed(hh: Harness, n: Notification) {
  const store = workerStoreOf(hh.bridge.ctx)
  const now = Date.now()
  store.addRoute({
    message_id: n.meta.message_id as string,
    thread_id: 'trip',
    notification: n,
    woke_at: now - 60_000,
    deadline_at: now - 1,
    cold: false,
  })
  return store
}

/** An emit main's side never finishes until the test says so. */
function held() {
  const got: Notification[] = []
  let release: (e?: Error) => void = () => {}
  const gate = new Promise<void>((res, rej) => {
    release = (e) => (e ? rej(e) : res())
  })
  gate.catch(() => {})
  return {
    got,
    release,
    emit: async (n: Notification) => {
      got.push(n)
      await gate
    },
  }
}

function recorder() {
  const got: Notification[] = []
  return { got, emit: async (n: Notification) => void got.push(n) }
}

describe('BSUP-4: a fallback to main that a restart cut short', () => {
  test('(a) stopped after the claim and the hand-over began, main never got it: the next start hands it over once', async () => {
    const hh = await hub()
    const store = seed(hh, note('m-a'))
    const before = held()
    const a = new ThreadRouter(hh.bridge.ctx, before.emit, { store })
    a.resume() // past its deadline: fires now
    await waitFor(() => before.got.length === 1, 4000, 'the hand-over began')
    expect(store.claimedBy('m-a')).toBe('main')
    a.close() // the bridge stops; the emit is cut off
    before.release(new BridgeStopping())
    const after = recorder()
    const b = new ThreadRouter(hh.bridge.ctx, after.emit, { store })
    b.resume()
    await waitFor(() => after.got.length === 1, 4000, 'main got it after the restart')
    expect(after.got[0]?.meta).toMatchObject({ message_id: 'm-a', routed: 'fallback', reason: 'worker_unavailable' })
    b.resume()
    await sleep(100)
    expect(after.got).toHaveLength(1) // never twice, and a third start does not either
    const c = new ThreadRouter(hh.bridge.ctx, after.emit, { store })
    c.resume()
    await sleep(100)
    expect(after.got).toHaveLength(1)
    for (const r of [a, b, c]) r.close()
  })

  test('(b) main already got it before the stop: the next start does not hand it over again', async () => {
    const hh = await hub()
    const store = seed(hh, note('m-b'))
    const before = recorder()
    const a = new ThreadRouter(hh.bridge.ctx, before.emit, { store })
    a.resume()
    await waitFor(
      () => before.got.length === 1 && store.pendingMainHandovers().length === 0,
      4000,
      'delivered and recorded',
    )
    a.close()
    const after = recorder()
    const b = new ThreadRouter(hh.bridge.ctx, after.emit, { store })
    b.resume()
    await sleep(150)
    expect(after.got).toHaveLength(0)
    b.close()
  })

  test('(c) a graceful stop before the hand-over began: the claim goes back and the next start routes it as before', async () => {
    const hh = await hub()
    const store = seed(hh, note('m-c'))
    // the claim is taken (what claimForMain does) and the bridge closes before the hand-over: the claim is given back
    const a = new ThreadRouter(hh.bridge.ctx, recorder().emit, { store })
    ;(a as unknown as { claimForMain(id: string): boolean }).claimForMain('m-c')
    expect(store.claimedBy('m-c')).toBe('main')
    a.close()
    expect(store.claimedBy('m-c')).toBeUndefined()
    expect(store.allUnclaimed().map((r) => r.message_id)).toEqual(['m-c'])
    const after = recorder()
    const b = new ThreadRouter(hh.bridge.ctx, after.emit, { store })
    b.resume() // re-armed, past its deadline: falls back once
    await waitFor(() => after.got.length === 1, 4000, 'fell back')
    await sleep(100)
    expect(after.got).toHaveLength(1)
    b.close()
  })

  test('(d) a card decision cut off mid hand-over is ended once at the next start, never redelivered', async () => {
    const hh = await hub()
    const n = note('m-d', 'card_action')
    ;(n.meta as Record<string, unknown>).card_id = 'card-d'
    const store = seed(hh, n)
    const ended: string[] = []
    const before = held()
    const a = new ThreadRouter(hh.bridge.ctx, before.emit, { store, onCardUndelivered: (id) => ended.push(id) })
    a.resume()
    await waitFor(() => before.got.length === 1, 4000, 'the hand-over began')
    a.close()
    before.release(new BridgeStopping()) // stopping: not delivered, nobody ends the card (as today)
    await sleep(50)
    expect(ended).toEqual([]) // the stopping bridge does not end it
    const after = recorder()
    const told: unknown[] = []
    const b = new ThreadRouter(hh.bridge.ctx, after.emit, {
      store,
      onCardUndelivered: (id, t) => {
        ended.push(id)
        told.push(t)
      },
    })
    b.resume()
    b.resume()
    await sleep(150)
    expect(after.got).toHaveLength(0) // a decision is never replayed to main
    expect(ended).toEqual(['card-d'])
    expect(told).toEqual(['unknown'])
    expect(store.pendingMainHandovers()).toHaveLength(0)
    b.close()
  })

  test('(d2) a card decision main cannot be told about is ended once, and not redelivered later', async () => {
    const hh = await hub()
    const n = note('m-d2', 'card_action')
    ;(n.meta as Record<string, unknown>).card_id = 'card-d2'
    const store = seed(hh, n)
    const ended: string[] = []
    const a = new ThreadRouter(
      hh.bridge.ctx,
      async () => {
        throw new Error('main is gone')
      },
      { store, onCardUndelivered: (id) => ended.push(id) },
    )
    a.resume()
    await waitFor(() => ended.length === 1, 4000, 'the card ended')
    a.close()
    const after = recorder()
    const b = new ThreadRouter(hh.bridge.ctx, after.emit, { store, onCardUndelivered: (id) => ended.push(id) })
    b.resume()
    await sleep(150)
    expect(after.got).toHaveLength(0)
    expect(store.pendingMainHandovers()).toHaveLength(0)
    expect(ended).toEqual(['card-d2'])
    b.close()
  })

  test('(e) main got it but the bridge died before the record was written: main gets it a second time (nothing dedupes)', async () => {
    const hh = await hub()
    const store = seed(hh, note('m-e'))
    // the death between the two: the intent row is never cleared
    store.endMainHandover = () => {}
    const before = recorder()
    const a = new ThreadRouter(hh.bridge.ctx, before.emit, { store })
    a.resume()
    await waitFor(() => before.got.length === 1, 4000, 'main got it')
    await sleep(50)
    a.close()
    const after = recorder()
    const b = new ThreadRouter(hh.bridge.ctx, after.emit, { store })
    b.resume()
    await waitFor(() => after.got.length === 1, 4000, 'handed over again')
    // a duplicate, not a loss: main has no check for a repeated message id (see the comment at the record in router.ts)
    expect(before.got[0]?.meta.message_id).toBe('m-e')
    expect(after.got[0]?.meta.message_id).toBe('m-e')
    b.close()
  })

  test('(f) an old database: main claims with no intent row are never redelivered by a start', async () => {
    const hh = await hub()
    const store = seed(hh, note('m-f'))
    expect(store.claim('m-f', 'main', Date.now())).toBe(true) // claimed for main long ago, before intent rows existed
    const after = recorder()
    const b = new ThreadRouter(hh.bridge.ctx, after.emit, { store })
    b.resume()
    await sleep(150)
    expect(after.got).toHaveLength(0)
    b.close()
  })

  test("(g) a stop during route()'s own fallback: the restart does not hand it over, the relay replay does, once", async () => {
    const hh = await hub()
    const n = note('m-g', 'text')
    ;(n.meta as Record<string, unknown>).trust = 'owner'
    // a row for the same id exists (routed before the restart), unclaimed with its deadline ahead; no workers.json: fallback
    const store = workerStoreOf(hh.bridge.ctx)
    const now = Date.now()
    store.addRoute({
      message_id: 'm-g',
      thread_id: 'trip',
      notification: n,
      woke_at: now,
      deadline_at: now + 600_000,
      cold: false,
    })
    const before = held()
    const a = new ThreadRouter(hh.bridge.ctx, before.emit, { store })
    const routed = a.route(n).catch(() => {})
    await waitFor(() => before.got.length === 1, 4000, 'the hand-over began')
    a.close()
    before.release(new BridgeStopping())
    await routed
    const after = recorder()
    const b = new ThreadRouter(hh.bridge.ctx, after.emit, { store })
    b.resume()
    await sleep(150)
    await b.route(n) // the relay replays the frame the bridge never finished
    await sleep(100)
    expect(after.got).toHaveLength(1)
    b.close()
  })

  test('(h) a repeat after a restart takes the undo point only when the recorded one is of another folder', async () => {
    const hh = await hub()
    const store = seed(hh, { ...note('m-h', 'text'), meta: { ...note('m-h', 'text').meta, trust: 'owner' } as never })
    const points: Array<{ replace?: unknown }> = []
    const ctx = hh.bridge.ctx
    ctx.undo = {
      before: async (t: { replace?: unknown }) => void points.push(t),
      abandon() {},
      mainFolder: () => '/main',
      restoring: { waitFor: async () => {} },
      handOvers: { note() {} },
    } as never
    try {
      const before = held()
      const a = new ThreadRouter(ctx, before.emit, { store })
      a.resume()
      await waitFor(() => before.got.length === 1, 4000, 'the hand-over began')
      a.close()
      before.release(new BridgeStopping())
      expect(points.map((p) => p.replace)).toEqual([true]) // the original late fallback replaces the worker's point
      const after = recorder()
      const b = new ThreadRouter(ctx, after.emit, { store })
      b.resume()
      await waitFor(() => after.got.length === 1, 4000, 'main got it after the restart')
      expect(points.map((p) => p.replace)).toEqual([true, 'elsewhere'])
      b.close()
    } finally {
      ctx.undo = undefined
    }
  })

  test('(i) a repeat that keeps failing for its own reason is given up after 3 starts', async () => {
    const hh = await hub()
    const store = seed(hh, note('m-i'))
    const cut = held()
    const a = new ThreadRouter(hh.bridge.ctx, cut.emit, { store })
    a.resume()
    await waitFor(() => cut.got.length === 1, 4000, 'the hand-over began')
    a.close()
    cut.release(new BridgeStopping())
    let tries = 0
    const failing = async () => {
      tries++
      throw new Error('main is gone')
    }
    for (let start = 1; start <= 3; start++) {
      expect(store.pendingMainHandovers()).toHaveLength(1)
      const b = new ThreadRouter(hh.bridge.ctx, failing, { store })
      b.resume()
      await waitFor(() => tries === start, 4000, `start ${start} tried`)
      await sleep(30)
      b.close()
    }
    expect(store.pendingMainHandovers()).toHaveLength(0) // given up
    const after = recorder()
    const c = new ThreadRouter(hh.bridge.ctx, after.emit, { store })
    c.resume()
    await sleep(150)
    expect(after.got).toHaveLength(0)
    expect(tries).toBe(3)
    c.close()
  })

  test('(j) a hand-over row whose route is unclaimed (close gave the claim back): main gets it once, through the deadline', async () => {
    const hh = await hub()
    const store = seed(hh, note('m-j'))
    store.beginMainHandover('m-j', Date.now()) // written, then close() gave the claim back: no claim stands
    expect(store.claimedBy('m-j')).toBeUndefined()
    const after = recorder()
    const b = new ThreadRouter(hh.bridge.ctx, after.emit, { store })
    b.resume()
    await waitFor(() => after.got.length >= 1, 4000, 'main got it')
    await sleep(200)
    expect(after.got).toHaveLength(1)
    expect(store.pendingMainHandovers()).toHaveLength(0)
    b.close()
  })
})
