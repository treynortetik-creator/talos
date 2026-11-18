// Property: the undo card can be drawn, and its binding is accepted by jcs (a lone surrogate throws there), for ANY well-formed
// owner text, including an emoji that falls where the card's title is cut (120 UTF-16 units) and in words that fill the rest.
// One harness, one folder and one undo point; each run swaps the stored text of the owner message and asks for a card again.

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindingFrom, type CardT, jcs, UNDO_FEATURE } from '@talos-app/protocol'
import fc from 'fast-check'
import { UndoPoints } from '../src/undo/points.ts'
import { snapshotFolder } from '../src/undo/snapshot.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

setDefaultTimeout(60_000)

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Alex Example',
  GIT_AUTHOR_EMAIL: 'alex@example.com',
  GIT_COMMITTER_NAME: 'Alex Example',
  GIT_COMMITTER_EMAIL: 'alex@example.com',
}
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv })

let h: Harness
let id: string
let folder: string

beforeAll(async () => {
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'talos-undo-prop-')))
  folder = r
  git(r, 'init', '-q', '-b', 'main')
  writeFileSync(join(r, 'a.txt'), 'a\n')
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'one')
  h = await startHarness({
    relay: { relayFeatures: ['schedules/1', UNDO_FEATURE] },
    bridge: { undo: { agentDir: r } },
  })
  const cards = h.bridge.ctx.undoCards
  if (cards) cards.seams = { probe: async () => true, fsTypeOf: async () => 'apfs', trustCache: new Map() }
  const sent = await h.app.sendMessage('general', 'tidy the readme please')
  await h.waitNotes(1)
  id = sent.client_msg_id as string
  const pts = new UndoPoints(h.bridge.ctx.store.db)
  await waitFor(() => pts.get(id) !== undefined, 8000, "the router's point")
  const s = await snapshotFolder({ folder: r, thread: 'general', turn: id, undoDir: join(h.home, 'undo') })
  pts.record({ message_id: id, thread_id: 'general', turn: id, snapshot: s, at: 1 }, { replace: true })
  writeFileSync(join(r, 'a.txt'), 'edited\n')
  // the turn is over: the mod reports main idle
  const mod = h.bridge.ctx.mod
  const base = mod.turnStarts()
  mod.liveState = () => ({ session_id: 's', source: 'cli', capabilities: [], busy: false }) as never
  mod.turnStarts = () => base + 1
})
afterAll(async () => {
  await h?.stop()
})

const lastUndoCard = (): CardT | undefined =>
  h.relay.frames
    .filter(
      (f) => f.direction === 'from_bridge' && f.raw.type === 'card.create' && (f.raw.card as CardT).kind === 'undo',
    )
    .map((f) => f.raw.card as CardT)
    .at(-1)

const unit = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom('a', 'b', 'x', 'é', '字') },
  { weight: 3, arbitrary: fc.constantFrom('\u{1F600}', '\u{1F468}‍\u{1F469}', '\u{10FFFF}', '\u{1F1EB}\u{1F1F7}') },
)
/** Eight words (the card quotes the first eight) whose total length lands around the 120-unit cut, emoji anywhere. */
const word = fc.array(unit, { minLength: 1, maxLength: 14 }).map((u) => u.join(''))
const ownerText = fc
  .tuple(fc.array(word, { minLength: 8, maxLength: 12 }), fc.constantFrom(' ', '  ', '\n'))
  .map(([w, sep]) => w.join(sep))

test('the undo card is drawn and its binding is jcs-accepted for any well-formed owner text', async () => {
  await fc.assert(
    fc.asyncProperty(ownerText, async (text) => {
      const msg = h.bridge.ctx.store.getMessage(id) as { text: string }
      h.bridge.ctx.store.db.query('UPDATE messages SET json = ? WHERE id = ?').run(JSON.stringify({ ...msg, text }), id)
      const before = h.relay.frames.length
      const r = await h.bridge.ctx.undoCards?.propose(id)
      expect(r).toMatchObject({ ok: true })
      await waitFor(() => h.relay.frames.length > before && lastUndoCard() !== undefined, 4000, 'the undo card')
      const card = lastUndoCard() as CardT
      expect(() => jcs(bindingFrom(card))).not.toThrow()
      const shown: string[] = [card.title, card.summary ?? '', card.body ?? '', ...card.destination.map((d) => d.value)]
      for (const s of shown)
        expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)).toBe(false)
      expect(card.title.length).toBeLessThanOrEqual(120)
    }),
    { seed: 20261121, numRuns: 60 },
  )
})

test('a file the turn edited, whose name is cut at 150 units (an emoji at the cut) keeps the card well-formed', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 140, max: 150 }), fc.integer({ min: 4, max: 8 }), async (plain, emoji) => {
      // the name is `plain` letters, then emoji (2 units each): the 150th unit lands in the middle of one for an odd plain length
      const name = `${'n'.repeat(plain)}${'\u{1F600}'.repeat(emoji)}.txt`
      const file = join(folder, name)
      writeFileSync(file, 'one\n')
      // a fresh undo point with this file in it, then the turn edits it: it is listed under "Comes back as it was", by name
      const snap = await snapshotFolder({ folder, thread: 'general', turn: id, undoDir: join(h.home, 'undo') })
      new UndoPoints(h.bridge.ctx.store.db).record(
        { message_id: id, thread_id: 'general', turn: id, snapshot: snap, at: 1 },
        { replace: true },
      )
      writeFileSync(file, 'two\n')
      try {
        const before = h.relay.frames.length
        const r = await h.bridge.ctx.undoCards?.propose(id)
        expect(r).toMatchObject({ ok: true })
        await waitFor(() => h.relay.frames.length > before && lastUndoCard() !== undefined, 4000, 'the undo card')
        const card = lastUndoCard() as CardT
        if (!(card.body ?? '').includes('nnnnnnnn')) throw new Error(card.body)
        expect(() => jcs(bindingFrom(card))).not.toThrow()
        expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(card.body ?? '')).toBe(
          false,
        )
      } finally {
        rmSync(file, { force: true })
      }
    }),
    { seed: 20261122, numRuns: 20 },
  )
})
