// An app from before the undo card (the parser at the commit before 135f9a7f, via git archive) meets one: a live
// `card.create` of kind 'undo' is refused as a newer card kind, never as a broken frame, and a `ready` or catch-up page
// that holds one keeps everything else: the other open cards, the unread counts, the other stored frames. The undo
// card never makes an inbox item (undo/card.ts), so the inbox is not touched. The web layer is checked by proxy: that
// app's unknownFrames.ts notes a card as "update the app" exactly when classifyUnparsed is not 'broken' and the same
// card with a kind it knows parses, which is what is asserted here. This build reads the same undo card in full.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseFrame } from '../src/index.ts'

const BEFORE_UNDO_CARD = 'cbd41d125220658cf8b3a8adfa4073b148fbf410'
const here = join(import.meta.dirname, '..')
const fx = (n: string) => JSON.parse(readFileSync(join(here, 'fixtures', 'frames', `${n}.json`), 'utf8'))

/** The temp folder the old parser is extracted into: removed after the file, so CI runs do not pile them up. */
let tmp: string | undefined
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

function oldProtocolDir(): string | undefined {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'undo-old-app-'))
    tmp = dir
    const tar = execFileSync(
      'git',
      ['-C', join(here, '..', '..'), 'archive', BEFORE_UNDO_CARD, 'packages/protocol', 'tsconfig.base.json'],
      { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
    )
    execFileSync('tar', ['-x', '-C', dir], { input: tar })
    symlinkSync(join(here, 'node_modules'), join(dir, 'packages', 'protocol', 'node_modules'))
    return join(dir, 'packages', 'protocol')
  } catch {
    return undefined
  }
}
const oldDir = oldProtocolDir()

/** The shape of the undo card the bridge makes (apps/bridge/src/undo/card.ts), not byte-equal to it: kind 'undo'. */
const known = fx('card.create').card as Record<string, unknown>
const undoCard = {
  ...known,
  id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4XN',
  kind: 'undo',
  title: 'Undo files to "tidy the readme please"',
  summary: '1 files come back, 1 new files deleted',
  destination: [{ label: 'Folder', value: '/Users/alex/project' }],
  body: 'Comes back as it was:\n- a.txt',
  body_format: 'plain',
  fields: [{ key: 'delete', label: 'Delete these new files', value: 'made.txt', editable: true, multiline: true }],
  warning: "Rewrites files on your Mac; ignored files (like .env) aren't restored.",
  primary_label: 'Undo files',
  kill_label: 'Keep files',
  allow_edit: true,
  allow_revise: false,
  risk: 'high',
  origin: 'chat',
  payload: {
    v: 1,
    message_id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2V3',
    kind: 'git',
    root: '/Users/alex/project',
    commit_id: 'a'.repeat(40),
    created_at: 1,
  },
}
const live = { ...fx('card.create'), id: '01JBF3V7Q8K2M4N6P8R0S2T4XM', card: undoCard }

describe('the undo card, and an app from before it', () => {
  it('this build reads it in full', () => {
    const r = parseFrame(live, { direction: 'relay_to_app' })
    expect(r.ok).toBe(true)
    if (r.ok && r.frame.type === 'card.create') expect(r.frame.card.kind).toBe('undo')
  })

  it.skipIf(!oldDir)(
    'live: refused as a newer card kind, not as a broken frame (one "update" note, no crash)',
    async () => {
      const old = await import(join(oldDir as string, 'src', 'index.ts'))
      expect(old.CARD_KINDS).not.toContain('undo')
      expect(old.parseFrame(live, { direction: 'relay_to_app' }).ok).toBe(false)
      // what that app's unknownFrames.ts asks: the same card with a kind it knows parses, so the kind alone is new
      expect(
        old.parseFrame({ ...live, card: { ...undoCard, kind: 'generic' } }, { direction: 'relay_to_app' }).ok,
      ).toBe(true)
      expect(old.classifyUnparsed(live, 'relay_to_app').kind).not.toBe('broken')
    },
  )

  it.skipIf(!oldDir)(
    "the bridge's later card.update for that card id parses (the app finds no card and moves on)",
    async () => {
      const old = await import(join(oldDir as string, 'src', 'index.ts'))
      const update = { ...fx('card.update'), card_id: undoCard.id }
      expect(old.parseFrame(update, { direction: 'relay_to_app' }).ok).toBe(true)
    },
  )

  it.skipIf(!oldDir)('in ready: only the undo card is dropped; the other open cards and the counts stay', async () => {
    const old = await import(join(oldDir as string, 'src', 'index.ts'))
    const ready = { ...fx('ready'), open_cards: [undoCard, known] }
    const r = old.parseFrame(ready, { direction: 'relay_to_app' })
    expect(r.ok).toBe(true)
    expect(r.frame.open_cards.map((c: { id: string }) => c.id)).toEqual([known.id])
    expect(r.frame.unread).toEqual(fx('ready').unread)
    expect(r.frame.threads.length).toBe(fx('ready').threads.length)
  })

  it.skipIf(!oldDir)('in a catch-up page: the page parses, and every other stored frame in it still does', async () => {
    const old = await import(join(oldDir as string, 'src', 'index.ts'))
    const others = [fx('reply'), fx('card.create'), fx('receipt')]
    const page = { ...fx('catchup.batch'), frames: [live, ...others] }
    const r = old.parseFrame(page, { direction: 'relay_to_app' })
    expect(r.ok).toBe(true)
    const each = r.frame.frames.map((f: unknown) => old.parseFrame(f, { direction: 'relay_to_app' }).ok)
    expect(each).toEqual([false, true, true, true])
  })
})

// On CI the history is whole (fetch-depth 0): the old parser must be there, or the tests above pass by skipping.
it.runIf(Boolean(process.env.CI))('the parser from before the undo card was found', () => {
  expect(oldDir).toBeDefined()
})
