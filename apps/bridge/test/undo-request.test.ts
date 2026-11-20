// "Undo to here" from the phone at the bridge: a signed undo.request gets the undo card for that owner message, or why
// not, once per control_id. A message's undo point rides on its `delivered` receipt and its history rows, only to a relay
// that says undo/1 (an older relay never sees the field); a point recorded after the receipt is sent on a second one.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CardT, newUlid, UNDO_FEATURE } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { HISTORY_RESET_KEY } from '../src/history-recover.ts'
import { UndoPoints } from '../src/undo/points.ts'
import { NO_POINT_TEXT } from '../src/undo/request.ts'
import { type Snapshot, type SnapshotOpts, snapshotFolder } from '../src/undo/snapshot.ts'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'

setDefaultTimeout(30_000)

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Alex Example',
  GIT_AUTHOR_EMAIL: 'alex@example.com',
  GIT_COMMITTER_NAME: 'Alex Example',
  GIT_COMMITTER_EMAIL: 'alex@example.com',
}
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv })
function repo(): string {
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'talos-undo-request-')))
  git(r, 'init', '-q', '-b', 'main')
  writeFileSync(join(r, '.gitignore'), '.env\n')
  writeFileSync(join(r, 'a.txt'), 'a\n')
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'one')
  return r
}

/** Main's folder is a repo, so the router takes a point before each hand-over; the relay says undo/1 unless told. */
type Later = (s: Snapshot) => Promise<Snapshot>
const trip = {
  id: 'trip',
  name: 'Trip',
  kind: 'fixed',
  order: 5,
  notify: 'all',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  session: 'dedicated',
}
async function up(o: { undo?: boolean; snapshot?: Later; dedicated?: boolean } = {}) {
  const r = repo()
  h = await startHarness({
    ...(o.dedicated
      ? {
          config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
            ...c,
            threads: [...c.threads, trip],
            dedicated: { enabled: true },
          })) as never,
        }
      : {}),
    relay: { relayFeatures: ['schedules/1', ...(o.undo === false ? [] : [UNDO_FEATURE])] },
    bridge: {
      undo: {
        agentDir: r,
        ...(o.snapshot ? { snapshot: async (x: SnapshotOpts) => (o.snapshot as Later)(await snapshotFolder(x)) } : {}),
      },
    },
  })
  const cards = h.bridge.ctx.undoCards
  if (cards) cards.seams = { probe: async () => true, fsTypeOf: async () => 'apfs', trustCache: new Map() }
  return { hh: h, r }
}

/** An owner message, handed over (its point taken first), and its `delivered` receipt. */
async function sent(hh: Harness, text = 'tidy the readme please') {
  const s = await hh.app.sendMessage('general', text)
  const id = s.client_msg_id as string
  await waitFor(() => new UndoPoints(hh.bridge.ctx.store.db).get(id) !== undefined, 8000, 'the point')
  const receipt = await hh.relay.expectFrame('receipt', (f) => f.message_id === id && f.state === 'delivered', {
    direction: 'from_bridge',
  })
  idle(hh)
  return { id, receipt }
}

/** Main's session is idle again, its turn over (the mod reports it idle, a turn started since): undo may be offered. */
function idle(hh: Harness) {
  const mod = hh.bridge.ctx.mod
  const base = mod.turnStarts()
  mod.liveState = () => ({ session_id: 's', source: 'cli', capabilities: [], busy: false }) as never
  mod.turnStarts = () => base + 1
}

const results = (hh: Harness, controlId: string) =>
  hh.relay.frames
    .filter((f) => f.direction === 'from_bridge' && f.frame.type === 'undo.request.result')
    .map((f) => f.frame as { control_id: string; ok: boolean; text: string; card_id?: string; code?: string })
    .filter((f) => f.control_id === controlId)
const result = (hh: Harness, controlId: string) =>
  hh.relay.expectFrame('undo.request.result', (f) => f.control_id === controlId, { direction: 'from_bridge' })
const undoCards = (hh: Harness) =>
  hh.relay.frames
    .filter((f) => f.direction === 'from_bridge' && f.frame.type === 'card.create')
    .map((f) => (f.frame as unknown as { card: CardT }).card)
    .filter((c) => c.kind === 'undo')

describe('undo.request at the bridge', () => {
  test('a message whose turn changed the folder: the undo card, and its id in the result', async () => {
    const { hh, r } = await up()
    const { id } = await sent(hh)
    writeFileSync(join(r, 'a.txt'), 'edited by the turn\n')
    const f = await hh.app.sendUndoRequest('general', id)
    const res = await result(hh, f.control_id)
    expect(res.ok).toBe(true)
    const cards = undoCards(hh)
    expect(cards).toHaveLength(1)
    expect(res.card_id).toBe(cards[0]?.id)
  })

  test('nothing to undo: no card, and why', async () => {
    const { hh } = await up()
    const { id } = await sent(hh)
    const f = await hh.app.sendUndoRequest('general', id)
    const res = await result(hh, f.control_id)
    expect(res).toMatchObject({ ok: false, text: 'Nothing to undo: the files already match.' })
    expect(undoCards(hh)).toHaveLength(0)
  })

  test("another thread's id, or a message with no point: refused, no card", async () => {
    const { hh, r } = await up()
    const { id } = await sent(hh)
    writeFileSync(join(r, 'a.txt'), 'edited by the turn\n')
    const wrong = await hh.app.sendUndoRequest('trip', id)
    expect(await result(hh, wrong.control_id)).toMatchObject({ ok: false, text: NO_POINT_TEXT })
    const none = await hh.app.sendUndoRequest('general', `m_${newUlid()}`)
    expect(await result(hh, none.control_id)).toMatchObject({ ok: false, text: NO_POINT_TEXT })
    expect(undoCards(hh)).toHaveLength(0)
  })

  test('the same control_id again: the stored result goes out again, and no second card', async () => {
    const { hh, r } = await up()
    const { id } = await sent(hh)
    writeFileSync(join(r, 'a.txt'), 'edited by the turn\n')
    const first = await hh.app.sendUndoRequest('general', id)
    const res = await result(hh, first.control_id)
    const again = await hh.app.sendUndoRequest('general', id, { control_id: first.control_id })
    await waitFor(() => results(hh, first.control_id).length >= 2, 4000, 'the stored result again')
    expect(again.id).not.toBe(first.id)
    expect(new Set(results(hh, first.control_id).map((x) => x.card_id))).toEqual(new Set([res.card_id]))
    expect(undoCards(hh)).toHaveLength(1)
  })

  test('signed before the history was reset: refused as stale, no card', async () => {
    const { hh, r } = await up()
    const { id } = await sent(hh)
    writeFileSync(join(r, 'a.txt'), 'edited by the turn\n')
    hh.bridge.ctx.store.kvSet(HISTORY_RESET_KEY, new Date(Date.now() + 60_000).toISOString())
    const f = await hh.app.sendUndoRequest('general', id)
    expect(await result(hh, f.control_id)).toMatchObject({ ok: false, code: 'control_stale' })
    expect(undoCards(hh)).toHaveLength(0)
  })

  test('unsigned, altered after signing, or with an unknown key: refused, no result, no card', async () => {
    const { hh, r } = await up()
    const { id } = await sent(hh)
    writeFileSync(join(r, 'a.txt'), 'edited by the turn\n')
    const control_id = newUlid()
    const signed = await hh.app.sign({ ...mkFrame('undo.request'), control_id, thread_id: 'general', message_id: id })
    hh.relay.sendToBridge({ ...signed, message_id: `m_${newUlid()}` }) // changed after signing
    const { osig: _dropped, ...unsigned } = signed
    hh.relay.sendToBridge({ ...unsigned, id: newUlid() }) // never signed
    const extra = await hh.app.sign({ ...mkFrame('undo.request'), control_id, thread_id: 'general', message_id: id })
    hh.relay.sendToBridge({ ...extra, also_delete: ['a.txt'] }) // a key the frame does not have
    await sleep(500)
    expect(results(hh, control_id)).toHaveLength(0)
    expect(undoCards(hh)).toHaveLength(0)
    idle(hh) // the refusals were told to the session: its turn on them is over too
    const good = await hh.app.sendUndoRequest('general', id) // and a sound one still goes through
    expect(await result(hh, good.control_id)).toMatchObject({ ok: true })
  })

  test('one signed more than 10 minutes ago (a relay that held it): refused, no card', async () => {
    const { hh, r } = await up()
    const { id } = await sent(hh)
    writeFileSync(join(r, 'a.txt'), 'edited by the turn\n')
    const control_id = newUlid()
    const ts = new Date(Date.now() - 11 * 60_000).toISOString()
    const old = await hh.app.sign({ ...mkFrame('undo.request'), ts, control_id, thread_id: 'general', message_id: id })
    hh.relay.sendToBridge(old)
    await sleep(500)
    expect(results(hh, control_id)).toHaveLength(0)
    expect(undoCards(hh)).toHaveLength(0)
  })

  test('asked while the message is still being handed over: refused as busy, behind it on its lane', async () => {
    const { hh } = await up()
    const s = await hh.app.sendMessage('general', 'tidy the readme please')
    const f = await hh.app.sendUndoRequest('general', s.client_msg_id as string)
    const res = await result(hh, f.control_id)
    expect(res.ok).toBe(false)
    expect(res.text).toContain('Stop the session first')
  })

  test("a slow card for one thread never holds up another thread's messages", async () => {
    let release = () => {}
    const slow = new Promise<boolean>((res) => {
      release = () => res(true)
    })
    const { hh, r } = await up({ dedicated: true })
    const { id } = await sent(hh)
    // A new file is offered only if its birth time is at or after the point's (restore.ts, provably new). Linux stamps file
    // times from its coarse clock, a millisecond or two behind the one the point is dated by, so a file written at once
    // could be born "before" the point (seen on Titan's WSL: -0.5 to -1.5 ms, 3 runs in 7) and is then, rightly, never
    // offered: "Nothing to undo". The turn writes it once the clock is clearly past the point, as a real turn always does.
    const takenAt = new UndoPoints(hh.bridge.ctx.store.db).get(id)?.created_at ?? 0
    while (Date.now() < takenAt + 20) await sleep(5)
    writeFileSync(join(r, 'new.txt'), 'made by the turn\n') // a new file: the plan runs the probe, which waits
    const born = statSync(join(r, 'new.txt')).birthtimeMs
    if (born > 0) expect(born).toBeGreaterThanOrEqual(takenAt) // the case under test, not the clock's granularity
    const cards = hh.bridge.ctx.undoCards
    if (cards) cards.seams = { probe: () => slow, fsTypeOf: async () => 'apfs', trustCache: new Map() }
    const f = await hh.app.sendUndoRequest('general', id)
    await sleep(200)
    const other = await hh.app.sendMessage('trip', 'and the trip notes')
    await waitFor(
      () => hh.bridge.ctx.store.getMessage(other.client_msg_id as string) !== undefined,
      8000,
      'the trip message',
    )
    expect(results(hh, f.control_id)).toHaveLength(0) // the card is still being made
    release()
    expect((await result(hh, f.control_id)).ok).toBe(true)
  })
})

describe("a message's undo point for the app", () => {
  test('rides on its delivered receipt, and on its history row', async () => {
    const { hh } = await up()
    const { id, receipt } = await sent(hh)
    expect(receipt.undo).toEqual({ state: 'ready' })
    await sleep(300)
    const delivered = hh.relay.frames.filter(
      (f) =>
        f.direction === 'from_bridge' &&
        f.frame.type === 'receipt' &&
        (f.frame as { message_id: string }).message_id === id,
    )
    expect(delivered).toHaveLength(1) // one receipt: the point was recorded before the hand-over
    const req = await hh.app.buildHistoryRequest('general', {})
    hh.relay.sendToBridge(req)
    const page = await hh.relay.expectFrame('history.page', (f) => f.request_id === req.request_id, {
      direction: 'from_bridge',
    })
    expect(page.messages.find((m) => m.id === id)?.undo).toEqual({ state: 'ready' })
  })

  test('to a relay without undo/1: no field anywhere, and receipts still flow', async () => {
    const { hh } = await up({ undo: false })
    const { id, receipt } = await sent(hh)
    expect(receipt.undo).toBeUndefined()
    expect(receipt.state).toBe('delivered')
    const req = await hh.app.buildHistoryRequest('general', {})
    hh.relay.sendToBridge(req)
    const page = await hh.relay.expectFrame('history.page', (f) => f.request_id === req.request_id, {
      direction: 'from_bridge',
    })
    const row = page.messages.find((m) => m.id === id)
    expect(row).toBeDefined()
    expect(row?.undo).toBeUndefined()
  })

  test('a point recorded after the hand-over goes on a second delivered receipt', async () => {
    let release = () => {}
    const slow = new Promise<void>((res) => {
      release = res
    })
    const { hh } = await up({
      snapshot: async (s) => {
        await slow // past the hold: delivery goes ahead without it
        return s
      },
    })
    const s = await hh.app.sendMessage('general', 'tidy the readme please')
    const id = s.client_msg_id as string
    const first = await hh.relay.expectFrame('receipt', (f) => f.message_id === id && f.state === 'delivered', {
      direction: 'from_bridge',
      timeoutMs: 10_000,
    })
    expect(first.undo).toBeUndefined()
    release()
    const second = await hh.relay.expectFrame('receipt', (f) => f.message_id === id && f.undo !== undefined, {
      direction: 'from_bridge',
    })
    expect(second).toMatchObject({ state: 'delivered', undo: { state: 'not_saved' } })
  })
})
