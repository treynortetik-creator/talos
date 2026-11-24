// "Always allow undos", end to end through undo.request (owner 2026-11-21): under the grant an undo that deletes nothing, on a
// session known to be idle, is applied without a card; one that would delete files, or one on a session Talos can't read, still
// gets its card. A passed undo sends the app no card at all: no card.create, no card.update, no card id in the result.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CardT, UNDO_FEATURE } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { UndoPoints } from '../src/undo/points.ts'
import { onUndoRequest } from '../src/undo/request.ts'
import { snapshotFolder } from '../src/undo/snapshot.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

setDefaultTimeout(t(60_000))

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
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'talos-undo-grant-')))
  git(r, 'init', '-q', '-b', 'main')
  writeFileSync(join(r, 'a.txt'), 'a\n')
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'one')
  return r
}

async function setup(o: { newFile?: boolean; idle?: boolean; grant?: boolean } = {}) {
  const r = repo()
  h = await startHarness({
    relay: { relayFeatures: ['schedules/1', UNDO_FEATURE] },
    bridge: { undo: { agentDir: undefined } },
    ...(o.grant === false
      ? {}
      : {
          config: ((c: object) => ({ ...c, always_allow: [{ kind: 'undo', destination: null }] })) as never,
        }),
  })
  const cards = h.bridge.ctx.undoCards
  if (cards) cards.seams = { probe: async () => true, fsTypeOf: async () => 'apfs', trustCache: new Map() }
  const sent = await h.app.sendMessage('general', 'tidy the readme please')
  await h.waitNotes(1)
  const id = sent.client_msg_id as string
  const pts = new UndoPoints(h.bridge.ctx.store.db)
  await waitFor(() => pts.get(id) !== undefined, 8000, "the router's point")
  const s = await snapshotFolder({ folder: r, thread: 'general', turn: id, undoDir: join(h.home, 'undo') })
  pts.record({ message_id: id, thread_id: 'general', turn: id, snapshot: s, at: 1 }, { replace: true })
  writeFileSync(join(r, 'a.txt'), 'edited\n')
  if (o.newFile) writeFileSync(join(r, 'made.txt'), 'made by the turn\n')
  if (o.idle !== false) {
    // the mod reports main idle, a turn started since
    const mod = h.bridge.ctx.mod
    const base = mod.turnStarts()
    mod.liveState = () => ({ session_id: 's', source: 'cli', capabilities: [], busy: false }) as never
    mod.turnStarts = () => base + 1
  }
  return { hh: h, r, id }
}

const fromBridge = (hh: Harness, type: string) =>
  hh.relay.frames.filter((f) => f.direction === 'from_bridge' && f.raw.type === type).map((f) => f.raw)
const undoCards = (hh: Harness) =>
  fromBridge(hh, 'card.create')
    .map((f) => f.card as CardT)
    .filter((c) => c.kind === 'undo')

describe('an undo under an undo grant', () => {
  test('one that deletes nothing, on an idle session: restored with no card, and the app is sent nothing about a card', async () => {
    const { hh, r, id } = await setup()
    const f = await hh.app.sendUndoRequest('general', id)
    const res = await hh.relay.expectFrame('undo.request.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    expect(res.ok).toBe(true)
    expect(res.card_id).toBeUndefined()
    await waitFor(() => readFileSync(join(r, 'a.txt'), 'utf8') === 'a\n', 8000, 'the file back')
    // the result is a line in the thread; the app never hears of a card it did not get
    await waitFor(
      () =>
        hh.bridge.ctx.store
          .page({ thread_id: 'general', limit: 50 })
          .messages.some((m) => m.author === 'system' && m.text?.startsWith('Undo done')),
      8000,
      'the result line',
    )
    expect(undoCards(hh)).toHaveLength(0)
    expect(fromBridge(hh, 'card.update')).toHaveLength(0)
  })

  test('one that would delete a new file still gets its card', async () => {
    const { hh, r, id } = await setup({ newFile: true })
    const f = await hh.app.sendUndoRequest('general', id)
    const res = await hh.relay.expectFrame('undo.request.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    expect(res.ok).toBe(true)
    const cards = undoCards(hh)
    expect(cards).toHaveLength(1)
    expect(res.card_id).toBe(cards[0]?.id)
    expect(readFileSync(join(r, 'a.txt'), 'utf8')).toBe('edited\n') // nothing restored until he taps
  })

  test("one on a session Talos can't read (state unknown) still gets its card", async () => {
    const { hh, r, id } = await setup({ idle: false })
    const f = await hh.app.sendUndoRequest('general', id)
    const res = await hh.relay.expectFrame('undo.request.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    expect(res.ok).toBe(true)
    expect(undoCards(hh)).toHaveLength(1)
    expect(readFileSync(join(r, 'a.txt'), 'utf8')).toBe('edited\n')
  })

  test('without the grant the same safe undo is a card', async () => {
    const { hh, id } = await setup({ grant: false })
    const f = await hh.app.sendUndoRequest('general', id)
    await hh.relay.expectFrame('undo.request.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    expect(undoCards(hh)).toHaveLength(1)
  })
})

describe('a passed undo and a restart or a slow restore', () => {
  const systemLines = (hh: Harness) =>
    hh.bridge.ctx.store
      .page({ thread_id: 'general', limit: 50 })
      .messages.filter((m) => m.author === 'system')
      .map((m) => m.text ?? '')

  test('the app is told BEFORE the restore runs (a long restore would outlast its wait)', async () => {
    const { hh, r, id } = await setup()
    const cards = hh.bridge.ctx.undoCards as unknown as { onResolved: (...a: unknown[]) => Promise<void> }
    const real = cards.onResolved.bind(cards)
    let open: () => void = () => {}
    const gate = new Promise<void>((res) => {
      open = res
    })
    cards.onResolved = async (...a) => {
      await gate
      return real(...a)
    }
    const f = await hh.app.sendUndoRequest('general', id)
    const res = await hh.relay.expectFrame('undo.request.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    // the result is out while the restore has not started: the file is still as the turn left it
    expect(res.ok).toBe(true)
    expect(readFileSync(join(r, 'a.txt'), 'utf8')).toBe('edited\n')
    open()
    await waitFor(() => readFileSync(join(r, 'a.txt'), 'utf8') === 'a\n', 8000, 'the file back')
  })

  test('the request replayed while the first is mid-restore (a restart) starts no second restore', async () => {
    const { hh, id } = await setup()
    const cards = hh.bridge.ctx.undoCards as unknown as { onResolved: (...a: unknown[]) => Promise<void> }
    let calls = 0
    // the first restore never finishes: the process "died" in it
    cards.onResolved = async () => {
      calls++
      await new Promise(() => {})
    }
    const f = await hh.app.sendUndoRequest('general', id)
    await hh.relay.expectFrame('undo.request.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    expect(calls).toBe(1)
    await onUndoRequest(hh.bridge.ctx, f as never, () => {})
    expect(calls).toBe(1)
    expect(undoCards(hh)).toHaveLength(0)
  })

  test('a restart in the middle of a passed undo: recovery says so in the thread and sends no card.update', async () => {
    const { hh, id } = await setup()
    const cards = hh.bridge.ctx.undoCards as unknown as {
      onResolved: (...a: unknown[]) => Promise<void>
      recover(): Promise<void>
    }
    cards.onResolved = async () => {} // the process "died" after the approval: the row stays resolved
    const f = await hh.app.sendUndoRequest('general', id)
    await hh.relay.expectFrame('undo.request.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    await waitFor(() => hh.bridge.ctx.ledger.list('resolved').length === 1, 4000, 'the resolved row')
    // a new process: nothing in memory, only the ledger
    const Fresh = (hh.bridge.ctx.undoCards as object).constructor as new (ctx: unknown) => typeof cards
    await new Fresh(hh.bridge.ctx).recover()
    expect(systemLines(hh).some((t) => t.includes('restarted during the undo'))).toBe(true)
    expect(fromBridge(hh, 'card.update')).toHaveLength(0)
    expect(hh.bridge.ctx.ledger.list('resolved')).toHaveLength(0)
  })
})
