// Bug hunt 2026-11-10 #12: removeGoneInboxes deleted, recursively, any folder under TALOS_INBOX_ROOT whose name looked
// like a thread id and was not a live thread, whoever made it. It now removes only a folder Talos made (it leaves a
// marker file in each one), deletes only the plain files in it, and never goes into a folder inside it.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  adoptLegacyInboxes,
  copyToInbox,
  INBOX_MARKER,
  inboxPath,
  pruneInbox,
  pruneInboxes,
  removeGoneInboxes,
  removeInbox,
} from '../../src/worker/inbox.ts'
import { eventually, startHarness } from '../helpers.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p: string) => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), p))
  made.push(d)
  return d
}

/** A root the owner shares with other things, a media folder, and one real Talos inbox (`trip`) made by a real copy. */
function world() {
  const base = tmp('ib-ours-')
  const media = join(base, 'home', 'media')
  const root = join(base, 'shared')
  mkdirSync(media, { recursive: true })
  mkdirSync(root)
  writeFileSync(join(media, 'md_one.png'), 'picture bytes')
  const copy = (thread: string) => copyToInbox({ root, mediaDir: media, thread, source: join(media, 'md_one.png') })
  return { root, media, copy }
}

describe('bug hunt #12: only folders Talos made are removed', () => {
  test('a folder someone else made under the root, named like a thread, is left whole', () => {
    const w = world()
    mkdirSync(join(w.root, 'photos', 'album'), { recursive: true })
    writeFileSync(join(w.root, 'photos', 'keep.jpg'), 'mine')
    writeFileSync(join(w.root, 'photos', 'album', 'deep.jpg'), 'mine too')
    w.copy('trip')
    removeGoneInboxes(w.root, ['general'])
    expect(readFileSync(join(w.root, 'photos', 'keep.jpg'), 'utf8')).toBe('mine')
    expect(readFileSync(join(w.root, 'photos', 'album', 'deep.jpg'), 'utf8')).toBe('mine too')
    expect(existsSync(inboxPath(w.root, 'trip'))).toBe(false) // the one Talos made is gone
    expect(readdirSync(w.root)).toEqual(['photos'])
    removeInbox(w.root, 'photos')
    expect(existsSync(join(w.root, 'photos', 'keep.jpg'))).toBe(true)
  })

  test('a copy leaves the marker in the folder it made, 0600, and a prune never deletes it', () => {
    const w = world()
    w.copy('trip')
    const dir = inboxPath(w.root, 'trip')
    expect(readdirSync(dir).sort()).toEqual([INBOX_MARKER, 'md_one.png'])
    expect(statSync(join(dir, INBOX_MARKER)).mode & 0o777).toBe(0o600)
    pruneInbox(w.root, 'trip', Date.now() + 365 * 86_400_000, { maxAgeMs: 1, maxBytes: 0 })
    expect(readdirSync(dir)).toEqual([INBOX_MARKER])
    removeGoneInboxes(w.root, [])
    expect(existsSync(dir)).toBe(false)
  })

  test('a folder that was there before Talos used it gets no marker, so its files outlive the thread', () => {
    const w = world()
    mkdirSync(join(w.root, 'trip'), { mode: 0o700 })
    writeFileSync(join(w.root, 'trip', 'notes.txt'), 'mine')
    w.copy('trip')
    expect(existsSync(join(w.root, 'trip', INBOX_MARKER))).toBe(false)
    removeGoneInboxes(w.root, [])
    expect(readFileSync(join(w.root, 'trip', 'notes.txt'), 'utf8')).toBe('mine')
  })

  test('inside a folder Talos made, a folder someone put there is not entered: the files go, the folder and its marker stay', () => {
    const w = world()
    w.copy('trip')
    const dir = inboxPath(w.root, 'trip')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'keep.txt'), 'keep')
    removeGoneInboxes(w.root, [])
    expect(readFileSync(join(dir, 'sub', 'keep.txt'), 'utf8')).toBe('keep')
    expect(readdirSync(dir).sort()).toEqual([INBOX_MARKER, 'sub'])
    // once the stray folder is gone the next pass finishes the job
    rmSync(join(dir, 'sub'), { recursive: true })
    removeGoneInboxes(w.root, [])
    expect(existsSync(dir)).toBe(false)
  })

  test('links are never followed: a link as the thread folder is left alone, a link inside is removed and its target kept, a link as the marker does not count', () => {
    const w = world()
    const target = tmp('ib-target-')
    writeFileSync(join(target, 'keep.txt'), 'keep')
    // a link named like a thread, pointing at a folder that even holds a marker
    writeFileSync(join(target, INBOX_MARKER), 'x')
    symlinkSync(target, join(w.root, 'garden'))
    // a real Talos inbox with a link inside it
    w.copy('trip')
    symlinkSync(join(target, 'keep.txt'), join(inboxPath(w.root, 'trip'), 'l.png'))
    // a folder whose "marker" is a link to a real marker somewhere else
    mkdirSync(join(w.root, 'fake'))
    writeFileSync(join(w.root, 'fake', 'mine.txt'), 'mine')
    symlinkSync(join(target, INBOX_MARKER), join(w.root, 'fake', INBOX_MARKER))
    removeGoneInboxes(w.root, [])
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep')
    expect(existsSync(join(target, INBOX_MARKER))).toBe(true)
    expect(existsSync(inboxPath(w.root, 'trip'))).toBe(false)
    expect(readFileSync(join(w.root, 'fake', 'mine.txt'), 'utf8')).toBe('mine')
    expect(readdirSync(w.root).sort()).toEqual(['fake', 'garden'])
  })

  test('pruning never touches a folder Talos did not make: old files, big files and links in a shared root all survive', () => {
    const w = world()
    mkdirSync(join(w.root, 'notes'))
    writeFileSync(join(w.root, 'notes', 'taxes.txt'), 'x'.repeat(4096))
    const target = tmp('ib-target-')
    writeFileSync(join(target, 'keep.txt'), 'keep')
    symlinkSync(join(target, 'keep.txt'), join(w.root, 'notes', 'link.txt'))
    mkdirSync(join(w.root, 'notes', 'sub'))
    w.copy('trip')
    const later = Date.now() + 365 * 86_400_000
    pruneInboxes(w.root, later, { maxAgeMs: 1, maxBytes: 0 })
    pruneInbox(w.root, 'notes', later, { maxAgeMs: 1, maxBytes: 0 })
    expect(readdirSync(join(w.root, 'notes')).sort()).toEqual(['link.txt', 'sub', 'taxes.txt'])
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep')
    expect(readdirSync(inboxPath(w.root, 'trip'))).toEqual([INBOX_MARKER]) // the one Talos made was pruned
  })
})

describe('bug hunt #12: folders an earlier build made, with no marker', () => {
  function legacy() {
    const base = tmp('ib-legacy-')
    const root = join(base, '.talos-inbox')
    for (const t of ['trip', 'garden']) {
      mkdirSync(join(root, t), { recursive: true, mode: 0o700 })
      writeFileSync(join(root, t, 'md_old.png'), 'x')
    }
    return { base, root }
  }

  test('under the default root they are adopted once, so they are pruned and removed with their thread; a folder that appears later is not adopted', () => {
    const { root } = legacy()
    const target = tmp('ib-target-')
    symlinkSync(target, join(root, 'linked'))
    mkdirSync(join(root, 'NotAThread'))
    adoptLegacyInboxes(root, root)
    expect(existsSync(join(root, 'trip', INBOX_MARKER))).toBe(true)
    expect(existsSync(join(root, 'garden', INBOX_MARKER))).toBe(true)
    expect(existsSync(join(target, INBOX_MARKER))).toBe(false) // never through a link
    expect(existsSync(join(root, 'NotAThread', INBOX_MARKER))).toBe(false)
    removeGoneInboxes(root, ['trip'])
    expect(existsSync(join(root, 'garden'))).toBe(false)
    expect(existsSync(join(root, 'trip', 'md_old.png'))).toBe(true)
    // once only: a folder the owner makes there afterwards is theirs
    mkdirSync(join(root, 'photos'))
    writeFileSync(join(root, 'photos', 'keep.jpg'), 'mine')
    adoptLegacyInboxes(root, root)
    expect(existsSync(join(root, 'photos', INBOX_MARKER))).toBe(false)
    removeGoneInboxes(root, [])
    expect(readFileSync(join(root, 'photos', 'keep.jpg'), 'utf8')).toBe('mine')
  })

  test('under any other root (TALOS_INBOX_ROOT, maybe shared) nothing is adopted; a missing root or a link as the root is left alone', () => {
    const { base, root } = legacy()
    adoptLegacyInboxes(root, join(base, 'somewhere-else'))
    expect(existsSync(join(root, 'trip', INBOX_MARKER))).toBe(false)
    removeGoneInboxes(root, [])
    expect(existsSync(join(root, 'trip', 'md_old.png'))).toBe(true)
    expect(() => adoptLegacyInboxes(join(base, 'none'), join(base, 'none'))).not.toThrow()
    expect(existsSync(join(base, 'none'))).toBe(false)
    const link = join(base, 'rootlink')
    symlinkSync(root, link)
    adoptLegacyInboxes(link, link)
    expect(existsSync(join(root, 'trip', INBOX_MARKER))).toBe(false)
  })
})

describe('bug hunt #12: through the real bridge (its start-up prune)', () => {
  const stops: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const f of stops.splice(0)) await f().catch(() => {})
  })
  function seeded(rootName: string) {
    const userHome = tmp('ib-bridge-')
    const root = join(userHome, rootName)
    // a folder an earlier build left for a thread that no longer exists, and one for a thread that does
    for (const t of ['old_one', 'general']) {
      mkdirSync(join(root, t), { recursive: true, mode: 0o700 })
      writeFileSync(join(root, t, 'md_old.png'), 'x')
    }
    return { userHome, root }
  }

  test('the default root: older folders are adopted at start, so the gone thread loses its folder and the live one keeps its own', async () => {
    const s = seeded('.talos-inbox')
    const h = await startHarness({ env: { HOME: s.userHome, TALOS_INBOX_ROOT: s.root } })
    stops.push(() => h.stop())
    expect(h.bridge.ctx.paths.inbox).toBe(s.root)
    await eventually(() => expect(existsSync(join(s.root, 'old_one'))).toBe(false))
    expect(readdirSync(join(s.root, 'general')).sort()).toEqual([INBOX_MARKER, 'md_old.png'])
  })

  test('a root the owner chose: nothing is adopted, pruned or removed at start', async () => {
    const s = seeded('shared')
    const h = await startHarness({ env: { HOME: s.userHome, TALOS_INBOX_ROOT: s.root } })
    stops.push(() => h.stop())
    expect(h.bridge.ctx.paths.inbox).toBe(s.root)
    // the start-up prune has run once the bridge is live; give a late one a moment as well
    await new Promise((r) => setTimeout(r, 300))
    expect(readdirSync(join(s.root, 'old_one'))).toEqual(['md_old.png'])
    expect(readdirSync(join(s.root, 'general'))).toEqual(['md_old.png'])
  })
})
