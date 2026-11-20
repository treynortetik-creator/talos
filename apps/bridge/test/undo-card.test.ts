// The undo card (card.ts): "Undo to here" shows a card of kind 'undo', risk high (the passkey), that says what comes
// back, that ignored files (like .env) aren't restored, that a git point is the whole repo, and lists every new file
// that would be deleted. Only an approved card restores, once; a replay, an expired card or a card bound to another
// thread's message restores nothing. A relay without undo/1 gets no card.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindingFrom, type CardT, editedHash, payloadHash, UNDO_FEATURE, UndoCardPayload } from '@talos-app/protocol'
import { UndoPoints } from '../src/undo/points.ts'
import { snapshotFolder } from '../src/undo/snapshot.ts'
import { type Harness, pushCardResolvePastRelay, sleep, startHarness, waitFor } from './helpers.ts'

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
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'talos-undo-card-')))
  git(r, 'init', '-q', '-b', 'main')
  writeFileSync(join(r, '.gitignore'), '.env\n')
  writeFileSync(join(r, 'a.txt'), 'a\n')
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'one')
  return r
}
const read = (p: string) => readFileSync(p, 'utf8')

const thread = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: 'fixed',
  order: 5,
  notify: 'all',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...extra,
})

async function setup(o: { features?: string[]; dedicated?: boolean; mainIsRepo?: boolean } = {}) {
  const r = repo()
  h = await startHarness({
    relay: { relayFeatures: o.features ?? ['schedules/1', UNDO_FEATURE] },
    bridge: { undo: { agentDir: o.mainIsRepo ? r : undefined } },
    ...(o.dedicated
      ? {
          config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
            ...c,
            threads: [...c.threads, thread('trip', 'Trip', { session: 'dedicated' })],
            dedicated: { enabled: true },
          })) as never,
        }
      : {}),
  })
  // birth times trusted whatever the file system the tests run on (restore.ts has the probe's own tests)
  const cards = h.bridge.ctx.undoCards
  if (cards) cards.seams = { probe: async () => true, fsTypeOf: async () => 'apfs', trustCache: new Map() }
  const where = o.dedicated ? 'trip' : 'general'
  const sent = await h.app.sendMessage(where, 'tidy the readme please')
  if (!o.dedicated) await h.waitNotes(1)
  const id = sent.client_msg_id as string
  if (o.dedicated) await waitFor(() => h?.bridge.ctx.store.getMessage(id) !== undefined, 4000, 'the message row')
  // the router's own point for this message first: this one, recorded after it, is the one the test works with
  const pts = new UndoPoints(h.bridge.ctx.store.db)
  await waitFor(() => pts.get(id) !== undefined, 8000, "the router's point")
  const s = await snapshotFolder({ folder: r, thread: where, turn: id, undoDir: join(h.home, 'undo') })
  pts.record({ message_id: id, thread_id: where, turn: id, snapshot: s, at: 1 }, { replace: true })
  // the turn: an edit, a new file, an ignored file changed
  writeFileSync(join(r, 'a.txt'), 'edited\n')
  writeFileSync(join(r, 'made.txt'), 'made by the turn\n')
  writeFileSync(join(r, 'mine.txt'), 'the owner wants this one\n')
  writeFileSync(join(r, '.env'), 'KEY=after\n')
  return { hh: h, r, id }
}

const workers = (hh: Harness, state: string, cwd: string, heartbeatMs = Date.now()) =>
  writeFileSync(
    join(hh.home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date(heartbeatMs).toISOString(), workers_supported: true },
      threads: {
        trip: {
          state,
          session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
          tmux: 't-trip',
          pane_pid: 0,
          cwd,
          error: null,
        },
      },
    }),
  )
const modBusy = (hh: Harness) => {
  hh.bridge.ctx.mod.liveState = () => ({ session_id: 's', source: 'cli', capabilities: [], busy: true }) as never
}
/**
 * The mod reports main idle, as the real one does (an idle state has no turn id), after `turnsSince` turns started
 * since the test began (the link counts turn starts).
 */
const modIdle = (hh: Harness, turnsSince = 1) => {
  const mod = hh.bridge.ctx.mod
  const base = mod.turnStarts()
  mod.liveState = () => ({ session_id: 's', source: 'cli', capabilities: [], busy: false }) as never
  mod.turnStarts = () => base + turnsSince
}
/** A scheduler that is there and ready, with this job's state today. */
const scheduleRunning = (hh: Harness, runner: 'headless' | 'session', today = 'running') => {
  const svc = hh.bridge.ctx.schedules
  if (!svc) throw new Error('no schedules')
  svc.disc = { state: 'ready' } as never
  svc.problem = null
  svc.lastGood = { schedules: [{ id: 'nightly', name: 'Nightly', runner, today }] } as never
  svc.safeSnapshot = async () => svc.lastGood as never // read only: what the test set
}

const undoCards = (hh: Harness) =>
  hh.relay.frames
    .filter(
      (f) => f.direction === 'from_bridge' && f.raw.type === 'card.create' && (f.raw.card as CardT).kind === 'undo',
    )
    .map((f) => f.raw.card as CardT)

async function propose(hh: Harness, id: string): Promise<CardT> {
  const r = await hh.bridge.ctx.undoCards?.propose(id)
  if (!r?.ok) throw new Error(`no card: ${JSON.stringify(r)}`)
  await waitFor(() => undoCards(hh).length === 1, 4000, 'the undo card')
  return undoCards(hh)[0] as CardT
}
const finished = (hh: Harness, cardId: string) =>
  hh.relay.frames.find(
    (f) =>
      f.direction === 'from_bridge' &&
      f.raw.type === 'card.update' &&
      f.raw.card_id === cardId &&
      (f.raw.state === 'done' || f.raw.state === 'failed'),
  )?.raw

describe('the undo card', () => {
  // longer than every wait a test makes in turn, so one that fails says which, never just "timed out"
  setDefaultTimeout(30_000)
  test('kind undo, risk high; says what comes back, that ignored files stay, that it is the whole repo, and what goes', async () => {
    const { hh, r, id } = await setup()
    const card = await propose(hh, id)
    expect(card.kind).toBe('undo')
    expect(card.risk).toBe('high')
    expect(card.thread_id).toBe('general')
    expect(card.warning).toContain("ignored files (like .env) aren't restored")
    expect(card.body).toContain('a.txt')
    expect(card.body).toContain('whole repository')
    expect(card.body).toContain(r)
    const del = card.fields.find((f) => f.key === 'delete')
    expect(del?.editable).toBe(true)
    expect(del?.value.split('\n').sort()).toEqual(['made.txt', 'mine.txt'])
    expect(UndoCardPayload.parse(card.payload)).toMatchObject({ message_id: id, kind: 'git', root: r })
  })

  test('approved: the files come back, only the listed new files go, and the card is done', async () => {
    const { hh, r, id } = await setup()
    const card = await propose(hh, id)
    const edits = { fields: [{ key: 'delete', value: 'made.txt' }] }
    await pushCardResolvePastRelay(hh, card, card.payload_hash, 'primary', {
      edited: edits,
      edited_hash: editedHash(bindingFrom(card), edits),
    })
    await waitFor(() => finished(hh, card.id) !== undefined, 6000, 'the card to finish')
    expect(finished(hh, card.id)?.state).toBe('done')
    expect(read(join(r, 'a.txt'))).toBe('a\n')
    expect(existsSync(join(r, 'made.txt'))).toBe(false)
    expect(read(join(r, 'mine.txt'))).toBe('the owner wants this one\n')
    expect(read(join(r, '.env'))).toBe('KEY=after\n')
    await waitFor(() => hh.notes.some((n) => n.content.includes('Files were undone back to')), 4000, 'the line')
  })

  test('a replayed approval restores nothing a second time', async () => {
    const { hh, r, id } = await setup()
    const card = await propose(hh, id)
    const frame = await pushCardResolvePastRelay(hh, card, card.payload_hash, 'primary')
    await waitFor(() => finished(hh, card.id) !== undefined, 6000, 'the card to finish')
    writeFileSync(join(r, 'a.txt'), 'edited again after the undo\n')
    hh.relay.sendToBridge(frame)
    await pushCardResolvePastRelay(hh, card, card.payload_hash, 'primary')
    await hh.bridge.inbound?.idle()
    expect(read(join(r, 'a.txt'))).toBe('edited again after the undo\n')
  })

  test('kill: nothing is restored', async () => {
    const { hh, r, id } = await setup()
    const card = await propose(hh, id)
    await pushCardResolvePastRelay(hh, card, card.payload_hash, 'kill')
    await waitFor(() => hh.bridge.ctx.ledger.get(card.id)?.state !== 'pending', 4000, 'the card to close')
    await hh.bridge.inbound?.idle()
    expect(read(join(r, 'a.txt'))).toBe('edited\n')
  })

  test('an expired card restores nothing', async () => {
    const { hh, r, id } = await setup()
    const card = await propose(hh, id)
    const past = new Date(Date.now() - 60_000).toISOString()
    const old: CardT = { ...card, id: 'c_01JBF3V7Q8K2M4N6P8R0S9T9T8', created_at: past, expires_at: past }
    old.payload_hash = payloadHash(bindingFrom(old))
    hh.bridge.ctx.ledger.create(old, 'bridge')
    await pushCardResolvePastRelay(hh, old, old.payload_hash, 'primary')
    await waitFor(() => hh.bridge.ctx.ledger.get(old.id)?.state === 'expired', 4000, 'the card to expire')
    await hh.bridge.inbound?.idle()
    expect(read(join(r, 'a.txt'))).toBe('edited\n')
  })

  test("a card in one thread bound to another thread's message restores nothing", async () => {
    const { hh, r, id } = await setup()
    const card = await propose(hh, id)
    const forged: CardT = { ...card, id: 'c_01JBF3V7Q8K2M4N6P8R0S9T9T7', thread_id: 'inbox' }
    forged.payload_hash = payloadHash(bindingFrom(forged))
    hh.bridge.ctx.ledger.create(forged, 'bridge')
    await pushCardResolvePastRelay(hh, forged, forged.payload_hash, 'primary')
    await waitFor(() => finished(hh, forged.id) !== undefined, 6000, 'the card to finish')
    expect(finished(hh, forged.id)?.state).toBe('failed')
    expect(read(join(r, 'a.txt'))).toBe('edited\n')
  })

  test('an edited box can only delete new files, by their exact name', async () => {
    const { hh, r, id } = await setup()
    const card = await propose(hh, id)
    writeFileSync(join(tmpdir(), 'talos-undo-outside.txt'), 'outside\n')
    const value = ['a.txt', '.env', '../talos-undo-outside.txt', join(r, 'made.txt'), ' mine.txt', 'made.txt '].join(
      '\n',
    )
    const edits = { fields: [{ key: 'delete', value }] }
    await pushCardResolvePastRelay(hh, card, card.payload_hash, 'primary', {
      edited: edits,
      edited_hash: editedHash(bindingFrom(card), edits),
    })
    await waitFor(() => finished(hh, card.id) !== undefined, 6000, 'the card to finish')
    expect(read(join(r, 'a.txt'))).toBe('a\n') // restored, never deleted
    expect(read(join(r, '.env'))).toBe('KEY=after\n')
    expect(existsSync(join(tmpdir(), 'talos-undo-outside.txt'))).toBe(true)
    expect(existsSync(join(r, 'made.txt'))).toBe(true)
    expect(existsSync(join(r, 'mine.txt'))).toBe(true)
  })

  test('a point taken again for the message after the card was shown: refused', async () => {
    const { hh, r, id } = await setup()
    const card = await propose(hh, id)
    const s = await snapshotFolder({ folder: r, thread: 'general', turn: id, undoDir: join(hh.home, 'undo') })
    new UndoPoints(hh.bridge.ctx.store.db).record(
      { message_id: id, thread_id: 'general', turn: id, snapshot: s, at: 2 },
      { replace: true },
    )
    await pushCardResolvePastRelay(hh, card, card.payload_hash, 'primary')
    await waitFor(() => finished(hh, card.id) !== undefined, 6000, 'the card to finish')
    expect(finished(hh, card.id)?.state).toBe('failed')
    expect(read(join(r, 'a.txt'))).toBe('edited\n')
  })

  test('a copy point taken again for the message after the card was shown: refused', async () => {
    h = await startHarness({
      relay: { relayFeatures: ['schedules/1', UNDO_FEATURE] },
      bridge: { undo: { agentDir: undefined } },
    })
    const hh = h
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-undo-card-copy-')))
    writeFileSync(join(d, 'a.txt'), 'a\n')
    const sent = await hh.app.sendMessage('general', 'a folder outside git')
    await hh.waitNotes(1)
    const id = sent.client_msg_id as string
    const points = new UndoPoints(hh.bridge.ctx.store.db)
    const take = async (at: number) =>
      points.record(
        {
          message_id: id,
          thread_id: 'general',
          turn: id,
          snapshot: await snapshotFolder({ folder: d, thread: 'general', turn: id, undoDir: join(hh.home, 'undo') }),
          at,
        },
        { replace: true },
      )
    await take(1)
    writeFileSync(join(d, 'a.txt'), 'edited\n')
    const card = await propose(hh, id)
    await take(2) // the same copy folder, now holding the edited file
    await pushCardResolvePastRelay(hh, card, card.payload_hash, 'primary')
    await waitFor(() => finished(hh, card.id) !== undefined, 6000, 'the card to finish')
    expect(finished(hh, card.id)?.state).toBe('failed')
  })

  test('a point taken again while the restore waited its turn: refused, nothing restored', async () => {
    const { hh, r, id } = await setup()
    const card = await propose(hh, id)
    const undo = hh.bridge.ctx.undo
    if (!undo) throw new Error('no undo seam')
    const real = undo.exclusive.bind(undo)
    // a record queued on the chain ahead of the restore: it runs first
    undo.exclusive = async (threads, fn) => {
      const s = await snapshotFolder({ folder: r, thread: 'general', turn: id, undoDir: join(hh.home, 'undo') })
      new UndoPoints(hh.bridge.ctx.store.db).record(
        { message_id: id, thread_id: 'general', turn: id, snapshot: s, at: 3 },
        { replace: true },
      )
      return real(threads, fn)
    }
    await pushCardResolvePastRelay(hh, card, card.payload_hash, 'primary')
    await waitFor(() => finished(hh, card.id) !== undefined, 6000, 'the card to finish')
    expect(finished(hh, card.id)?.state).toBe('failed')
    expect(read(join(r, 'a.txt'))).toBe('edited\n')
  })

  test('a bridge that restarted while an approved undo ran: the card says so, never left working', async () => {
    const { hh, id } = await setup()
    const card = await propose(hh, id)
    const out = hh.bridge.ctx.ledger.resolve(
      { card_id: card.id, action: 'primary', payload_hash: card.payload_hash, ts: new Date().toISOString() },
      Date.now(),
    )
    expect(out.ok).toBe(true) // approved, then the process died before it finished
    await hh.bridge.ctx.undoCards?.recover()
    await waitFor(() => finished(hh, card.id) !== undefined, 4000, 'the card to end')
    expect(finished(hh, card.id)).toMatchObject({ state: 'failed' })
    expect(finished(hh, card.id)?.result).toMatchObject({ text: expect.stringContaining('restarted') })
  })

  test("main's session busy: no card, and the answer says to stop it first", async () => {
    const { hh, id } = await setup()
    hh.bridge.ctx.mod.liveState = () => ({ session_id: 's', source: 'cli', capabilities: [], busy: true }) as never
    const r = await hh.bridge.ctx.undoCards?.propose(id)
    expect(r).toMatchObject({ ok: false })
    expect(r?.ok === false && r.why).toContain('Stop the session first')
    expect(undoCards(hh)).toHaveLength(0)
  })

  test("main's state unknown (no mod): the card is made and says Talos can't tell", async () => {
    const { hh, id } = await setup()
    const card = await propose(hh, id)
    expect(card.body).toContain(
      "Talos can't tell whether this session is working right now. If it is, stop it before you approve.",
    )
  })

  test('a session that became busy after the card was shown: refused at restore, nothing restored', async () => {
    const { hh, r, id } = await setup()
    const card = await propose(hh, id)
    hh.bridge.ctx.mod.liveState = () => ({ session_id: 's', source: 'cli', capabilities: [], busy: true }) as never
    await pushCardResolvePastRelay(hh, card, card.payload_hash, 'primary')
    await waitFor(() => finished(hh, card.id) !== undefined, 6000, 'the card to finish')
    expect(finished(hh, card.id)).toMatchObject({ state: 'failed' })
    expect(finished(hh, card.id)?.result).toMatchObject({ text: expect.stringContaining('Stop the session first') })
    expect(read(join(r, 'a.txt'))).toBe('edited\n')
  })

  for (const state of ['busy', 'starting', 'parking', 'stopping'])
    test(`a thread worker that is ${state}: no card`, async () => {
      const { hh, r, id } = await setup({ dedicated: true })
      writeFileSync(
        join(hh.home, 'workers.json'),
        JSON.stringify({
          v: 1,
          supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
          threads: {
            trip: {
              state,
              session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
              tmux: 't-trip',
              pane_pid: 0,
              cwd: r,
              error: null,
            },
          },
        }),
      )
      const res = await hh.bridge.ctx.undoCards?.propose(id)
      expect(res?.ok === false && res.why).toContain('Stop the session first')
    })

  test("a dedicated thread's message that fell back to main: main's state decides, and main busy means no card", async () => {
    const { hh, r, id } = await setup({ dedicated: true, mainIsRepo: true })
    workers(hh, 'failed', join(r, 'elsewhere')) // the worker could not take it: main ran the turn in its own folder
    modBusy(hh)
    const res = await hh.bridge.ctx.undoCards?.propose(id)
    expect(res?.ok === false && res.why).toContain('Stop the session first')
  })

  test('a message routed to the thread worker and not picked up yet: no card (its turn is about to start)', async () => {
    const { hh, r, id } = await setup({ dedicated: true })
    workers(hh, 'live', r)
    await hh.app.sendMessage('trip', 'another one, routed and waiting')
    await waitFor(() => (hh.bridge.router?.store.unclaimed('trip').length ?? 0) > 0, 4000, 'the route')
    const res = await hh.bridge.ctx.undoCards?.propose(id)
    expect(res?.ok === false && res.why).toContain('Stop the session first')
  })

  test("a workers.json that is stale: the card says Talos can't tell, never idle", async () => {
    const { hh, r, id } = await setup({ dedicated: true })
    workers(hh, 'live', r, Date.now() - 10 * 60_000)
    const card = await propose(hh, id)
    expect(card.body).toContain("Talos can't tell whether this session is working right now.")
  })

  // the lanes: the card's answer holds MAIN_LANE (main can write in that folder), so main's next message waits behind
  // it; the guard on hand-overs (RestoringRoots) is covered by the scheduled-run test below
  test("an undo of main's folder holds main's next messages on their lane, whichever thread the card is in", async () => {
    const { hh, r, id } = await setup({ dedicated: true, mainIsRepo: true })
    workers(hh, 'failed', join(r, 'elsewhere'))
    modIdle(hh)
    scheduleRunning(hh, 'headless', 'not_due')
    const card = await propose(hh, id)
    const undo = hh.bridge.ctx.undo
    if (!undo) throw new Error('no undo seam')
    let open = () => {}
    const gate = new Promise<void>((res) => {
      open = res
    })
    const real = undo.exclusive.bind(undo)
    let entered = false
    undo.exclusive = async (threads, fn) =>
      real(threads, async () => {
        entered = true
        await gate
        return fn()
      })
    const before = hh.notes.length
    await pushCardResolvePastRelay(hh, card, card.payload_hash, 'primary')
    await waitFor(() => entered, 4000, 'the restore to start')
    await hh.app.sendMessage('general', 'sent while the undo runs')
    await sleep(400)
    expect(hh.notes.slice(before).some((n) => n.content.includes('sent while the undo runs'))).toBe(false)
    open()
    await waitFor(() => hh.notes.some((n) => n.content.includes('sent while the undo runs')), 6000, 'the message')
  }, 30_000)

  test('a scheduled run that fires during a restore of its folder starts only after the restore ends', async () => {
    const { hh, r } = await setup({ mainIsRepo: true })
    const undo = hh.bridge.ctx.undo
    if (!undo) throw new Error('no undo seam')
    let open = () => {}
    const gate = new Promise<void>((res) => {
      open = res
    })
    const restoring = undo.restoring.hold(r, () => gate)
    const before = hh.notes.length
    const fired = hh.bridge.ctx.emit({
      content: 'the nightly tidy',
      meta: { kind: 'schedule_run', thread_id: 'general', trust: 'owner', schedule_id: 'tidy' },
    })
    await sleep(300)
    expect(hh.notes.length).toBe(before)
    open()
    await restoring
    await fired
    expect(hh.notes.slice(before).map((n) => n.content)).toContain('the nightly tidy')
  })

  test("main's folder given through a link: a fallback to main is still checked against main", async () => {
    const r = repo()
    const link = join(realpathSync(mkdtempSync(join(tmpdir(), 'talos-undo-link-'))), 'agent')
    symlinkSync(r, link)
    h = await startHarness({
      relay: { relayFeatures: ['schedules/1', UNDO_FEATURE] },
      bridge: { undo: { agentDir: link } },
      config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
        ...c,
        threads: [...c.threads, thread('trip', 'Trip', { session: 'dedicated' })],
        dedicated: { enabled: true },
      })) as never,
    })
    const hh = h
    const sent = await hh.app.sendMessage('trip', 'answered by main')
    const id = sent.client_msg_id as string
    await waitFor(() => hh.bridge.ctx.store.getMessage(id) !== undefined, 4000, 'the message row')
    new UndoPoints(hh.bridge.ctx.store.db).record(
      {
        message_id: id,
        thread_id: 'trip',
        turn: id,
        snapshot: await snapshotFolder({ folder: link, thread: 'trip', turn: id, undoDir: join(hh.home, 'undo') }),
        at: 1,
      },
      { replace: true },
    )
    writeFileSync(join(r, 'a.txt'), 'edited\n')
    workers(hh, 'failed', join(r, 'elsewhere'))
    modBusy(hh)
    const res = await hh.bridge.ctx.undoCards?.propose(id)
    expect(res?.ok === false && res.why).toContain('Stop the session first')
  })

  test('a message handed to main a moment ago: busy until the mod reports a newer turn done', async () => {
    const { hh, id } = await setup({ mainIsRepo: true })
    scheduleRunning(hh, 'headless', 'not_due')
    modIdle(hh, 0) // idle, but no turn has started since the hand-over: it may not have shown yet
    const first = await hh.bridge.ctx.undoCards?.propose(id)
    expect(first?.ok === false && first.why).toContain('Stop the session first')
    modIdle(hh, 1) // a turn started since the hand-over, and the session is idle again
    const second = await hh.bridge.ctx.undoCards?.propose(id)
    expect(second?.ok).toBe(true)
  })

  test('a background job running in the folder: no card, and it says to wait for it', async () => {
    const { hh, id } = await setup({ mainIsRepo: true })
    modIdle(hh)
    scheduleRunning(hh, 'headless')
    const res = await hh.bridge.ctx.undoCards?.propose(id)
    expect(res?.ok === false && res.why).toContain('A scheduled job is running in this folder; wait for it to finish')
  })

  test('a background job that started after the card was shown: refused at restore', async () => {
    const { hh, r, id } = await setup({ mainIsRepo: true })
    modIdle(hh)
    scheduleRunning(hh, 'headless', 'not_due')
    const card = await propose(hh, id)
    scheduleRunning(hh, 'headless')
    await pushCardResolvePastRelay(hh, card, card.payload_hash, 'primary')
    await waitFor(() => finished(hh, card.id) !== undefined, 6000, 'the card to finish')
    expect(finished(hh, card.id)?.result).toMatchObject({ text: expect.stringContaining('A scheduled job is running') })
    expect(read(join(r, 'a.txt'))).toBe('edited\n')
  })

  test("a scheduler that is there but not read yet: the card says Talos can't tell", async () => {
    const { hh, id } = await setup({ mainIsRepo: true })
    modIdle(hh)
    scheduleRunning(hh, 'headless', 'not_due')
    const svc = hh.bridge.ctx.schedules
    if (svc) {
      svc.lastGood = null
      svc.safeSnapshot = async () => ({}) as never
    }
    const card = await propose(hh, id)
    expect(card.body).toContain("Talos can't tell whether this session is working right now.")
  })

  test('no scheduler on this Mac and the mod idle: no "can\'t tell" line', async () => {
    const { hh, id } = await setup({ mainIsRepo: true })
    modIdle(hh)
    const svc = hh.bridge.ctx.schedules
    if (svc) {
      svc.disc = { state: 'not_installed' } as never
      svc.lastGood = null
    }
    const card = await propose(hh, id)
    expect(card.body).not.toContain("Talos can't tell")
  })

  test('a job that started after the last read of the schedules: the fresh read at propose refuses', async () => {
    const { hh, id } = await setup({ mainIsRepo: true })
    modIdle(hh)
    scheduleRunning(hh, 'headless', 'not_due')
    const svc = hh.bridge.ctx.schedules
    if (!svc) throw new Error('no schedules')
    svc.safeSnapshot = async () => {
      svc.lastGood = { schedules: [{ id: 'nightly', name: 'Nightly', runner: 'headless', today: 'running' }] } as never
      return svc.lastGood as never
    }
    const res = await hh.bridge.ctx.undoCards?.propose(id)
    expect(res?.ok === false && res.why).toContain('A scheduled job is running')
  })

  test('a device that does not keep birth times: no Delete box, and the card says why', async () => {
    const { hh, id } = await setup()
    const cards = hh.bridge.ctx.undoCards
    if (cards) cards.seams = { probe: async () => false, fsTypeOf: async () => 'apfs', trustCache: new Map() }
    const card = await propose(hh, id)
    expect(card.fields.find((f) => f.key === 'delete')).toBeUndefined()
    expect(card.body).toContain("Talos can't prove which files here are new, so none will be deleted")
    expect(card.body).toContain('made.txt')
  })

  test('a folder on a file system not proven to keep birth times: no Delete box, and the card names it', async () => {
    const { hh, id } = await setup()
    const cards = hh.bridge.ctx.undoCards
    if (cards) cards.seams = { probe: async () => true, fsTypeOf: async () => 'exfat', trustCache: new Map() }
    const card = await propose(hh, id)
    expect(card.fields.find((f) => f.key === 'delete')).toBeUndefined()
    expect(card.body).toContain(
      "This folder is on a file system (exfat) Talos can't prove new files on, so none will be deleted",
    )
    expect(card.body).toContain('made.txt')
  })

  test("a folder whose file system can't be told: no Delete box, and the card says so", async () => {
    const { hh, id } = await setup()
    const cards = hh.bridge.ctx.undoCards
    if (cards) cards.seams = { probe: async () => true, fsTypeOf: async () => undefined, trustCache: new Map() }
    const card = await propose(hh, id)
    expect(card.fields.find((f) => f.key === 'delete')).toBeUndefined()
    expect(card.body).toContain(
      "Talos can't tell which file system this folder is on, so none of the new files will be deleted",
    )
  })

  test('a point not saved because its copy lost a name: refused, and it says why', async () => {
    const { hh, id } = await setup()
    hh.bridge.ctx.store.db
      .query("UPDATE undo_points SET state = 'not_saved', why = 'names_differ' WHERE message_id = ?")
      .run(id)
    const r = await hh.bridge.ctx.undoCards?.propose(id)
    expect(r?.ok).toBe(false)
    expect(r?.ok === false && r.why).toContain('names that differ only in case')
  })

  test('new files nobody can prove new are listed read-only: first 20, then how many more, and no Delete box', async () => {
    const { hh, r, id } = await setup()
    // a point with no record of what git ignored then: nothing can be proved new
    hh.bridge.ctx.store.db.query('UPDATE undo_points SET ignored_json = NULL WHERE message_id = ?').run(id)
    for (let i = 0; i < 23; i++) writeFileSync(join(r, `new-${String(i).padStart(2, '0')}.txt`), 'x\n')
    const card = await propose(hh, id)
    expect(card.body).toContain('Left in place: new since this turn (25):')
    expect(card.body).toContain('new-00.txt')
    expect(card.body).toContain('and 5 more')
    expect(card.body).not.toContain('new-22.txt') // past the first 20
    expect(card.fields.find((f) => f.key === 'delete')).toBeUndefined()
    expect(card.allow_edit).toBe(false)
  })

  test('a long name is cut in the list, and the explanation comes before every list', async () => {
    const { hh, r, id } = await setup()
    hh.bridge.ctx.store.db.query('UPDATE undo_points SET ignored_json = NULL WHERE message_id = ?').run(id)
    writeFileSync(join(r, `${'n'.repeat(200)}.txt`), 'x\n')
    const card = await propose(hh, id)
    const body = card.body ?? ''
    expect(body).toContain(`${'n'.repeat(150)}…`)
    expect(body).not.toContain('n'.repeat(151))
    const why = body.indexOf('Talos has no full record of what was here before this message')
    expect(why).toBeGreaterThan(-1)
    expect(why).toBeLessThan(body.indexOf('Comes back as it was'))
  })

  test('files git ignored then and un-ignored since are listed as there before', async () => {
    const { hh, r, id } = await setup()
    writeFileSync(join(r, '.gitignore'), '.env\n*.log\n')
    writeFileSync(join(r, 'old.log'), 'there before\n')
    const s = await snapshotFolder({ folder: r, thread: 'general', turn: id, undoDir: join(hh.home, 'undo') })
    new UndoPoints(hh.bridge.ctx.store.db).record(
      { message_id: id, thread_id: 'general', turn: id, snapshot: s, at: Date.now() },
      { replace: true },
    )
    writeFileSync(join(r, '.gitignore'), '.env\n') // the turn un-ignores the logs
    writeFileSync(join(r, 'a.txt'), 'edited again\n')
    const card = await propose(hh, id)
    expect(card.body).toContain('Left in place (they were there before)')
    expect(card.body).toContain('old.log')
    expect(card.body).not.toContain('new since this turn')
  })

  test('a point whose ignored record is incomplete: the card says why nothing is deleted', async () => {
    const { hh, id } = await setup()
    hh.bridge.ctx.store.db
      .query('UPDATE undo_points SET ignored_json = ? WHERE message_id = ?')
      .run(JSON.stringify({ paths: [], dirs: {}, incomplete: true }), id)
    const card = await propose(hh, id)
    expect(card.body).toContain('This folder had too many ignored files for Talos to track, so nothing will be deleted')
    expect(card.fields.find((f) => f.key === 'delete')).toBeUndefined()
  })

  test('a relay without undo/1 gets no card', async () => {
    const { hh, id } = await setup({ features: ['schedules/1'] })
    const r = await hh.bridge.ctx.undoCards?.propose(id)
    expect(r?.ok).toBe(false)
    expect(undoCards(hh)).toHaveLength(0)
  })

  test('a message with no ready point gets no card', async () => {
    const { hh } = await setup()
    const r = await hh.bridge.ctx.undoCards?.propose('m_01JBF3V7Q8K2M4N6P8R0S9T9T7')
    expect(r?.ok).toBe(false)
  })
})
