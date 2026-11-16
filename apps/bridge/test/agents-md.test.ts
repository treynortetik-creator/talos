// The thread's AGENTS.md in its settings (src/files/agents-md.ts): read and saved inside the Files pane's fence, a save only
// over the file the editor loaded, the Mac's own records of each save, and a change made outside Settings shown, never
// refused. Every case runs in a temp folder with made-up text.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
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
import { join } from 'node:path'
import { AGENTS_MD_MAX_BYTES, AGENTS_MD_WORDING } from '@talos-app/protocol'
import { AgentsMdService } from '../src/files/agents-md.ts'
import { FilesService } from '../src/files/service.ts'
import { agentsMdFolderFor } from '../src/files/wiring.ts'
import { openSeam } from '../src/safe-open.ts'
import { ReadError } from '../src/v2-seams.ts'

/** /tmp, not TMPDIR: a CI run's TMPDIR sits under a hidden folder, which the fence refuses by design. */
const base = () => realpathSync('/tmp')
const T = 'trip'
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

let top: string
let root: string
let home: string
let own: string | null
let svc: AgentsMdService

const make = () =>
  new AgentsMdService({
    ownFolder: (id) => (id === T ? own : null),
    fenced: (id) => files.fencedName(id, 'AGENTS.md'),
    stateDir: (id) => join(home, 'threads', id),
  })
let files: FilesService
const fail = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  )
  expect(e).toBeInstanceOf(ReadError)
  return e as ReadError
}
const md = () => join(root, 'AGENTS.md')

beforeEach(() => {
  top = realpathSync(mkdtempSync(join(base(), 'talos-agentsmd-')))
  root = join(top, 'trip')
  home = join(top, 'talos-home')
  mkdirSync(root)
  mkdirSync(home)
  own = root
  files = new FilesService({
    rootFor: (id) => (id === T ? root : null),
    refused: [home],
    media: { uploadBytes: async () => ({}) as never },
  })
  svc = make()
})
afterEach(() => {
  openSeam.beforeOpen = undefined
  rmSync(top, { recursive: true, force: true })
})

describe('reading and saving', () => {
  test('no AGENTS.md yet: a save against "none" creates it, and the answer is the file as saved', async () => {
    expect(await svc.read({ thread_id: T })).toEqual({ thread_id: T, exists: false, sha: null })
    const text = '# Trip\n\nKeep the packing list in packing.md.\n'
    const saved = await svc.write({ thread_id: T, text, base_sha: null })
    expect(saved).toEqual({ thread_id: T, exists: true, sha: sha(text), text, saved: true })
    expect(readFileSync(md(), 'utf8')).toBe(text)
    expect(await svc.read({ thread_id: T })).toEqual({ thread_id: T, exists: true, sha: sha(text), text })
    // nothing of the write is left beside it
    expect(readdirSync(root)).toEqual(['AGENTS.md'])
  })

  test('a save keeps the text before it in agents-md.prev, and its own text as the last save; the mode stays', async () => {
    writeFileSync(md(), 'first\n', { mode: 0o640 })
    await svc.write({ thread_id: T, text: 'second\n', base_sha: sha('first\n') })
    const dir = join(home, 'threads', T)
    expect(readFileSync(join(dir, 'agents-md.prev'), 'utf8')).toBe('first\n')
    expect(readFileSync(join(dir, 'agents-md.saved'), 'utf8')).toBe('second\n')
    expect(statSync(md()).mode & 0o777).toBe(0o640)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  test('a save over a file that changed since it was loaded is refused, and the change made meanwhile is kept', async () => {
    writeFileSync(md(), 'loaded\n')
    const loaded = await svc.read({ thread_id: T })
    writeFileSync(md(), 'the agent added a line\n')
    const e = await fail(svc.write({ thread_id: T, text: 'mine\n', base_sha: loaded.sha }))
    expect(e.code).toBe('stale')
    expect(e.message).toBe(AGENTS_MD_WORDING.conflict)
    expect(readFileSync(md(), 'utf8')).toBe('the agent added a line\n')
    // "there was none" is a base too: a file that appeared since is not overwritten
    rmSync(md())
    const none = await svc.read({ thread_id: T })
    writeFileSync(md(), 'appeared\n')
    expect((await fail(svc.write({ thread_id: T, text: 'mine\n', base_sha: none.sha }))).code).toBe('stale')
  })

  test('two saves from the same load: one is saved, the other is told the file changed', async () => {
    writeFileSync(md(), 'v1\n')
    const b = sha('v1\n')
    const [x, y] = await Promise.allSettled([
      svc.write({ thread_id: T, text: 'from the phone\n', base_sha: b }),
      svc.write({ thread_id: T, text: 'from the laptop\n', base_sha: b }),
    ])
    expect([x.status, y.status].sort()).toEqual(['fulfilled', 'rejected'])
    expect(['from the phone\n', 'from the laptop\n']).toContain(readFileSync(md(), 'utf8'))
  })

  test('over 64 KB: shown as too large, never cut, and not saved over; a save of more than 64 KB is refused', async () => {
    writeFileSync(md(), 'x'.repeat(AGENTS_MD_MAX_BYTES + 1))
    expect(await svc.read({ thread_id: T })).toEqual({ thread_id: T, exists: true, sha: null, too_large: true })
    expect((await fail(svc.write({ thread_id: T, text: 'short\n', base_sha: null }))).code).toBe('too_large')
    rmSync(md())
    const e = await fail(svc.write({ thread_id: T, text: 'é'.repeat(AGENTS_MD_MAX_BYTES / 2 + 1), base_sha: null }))
    expect(e.message).toBe(AGENTS_MD_WORDING.tooLarge)
    expect(existsSync(md())).toBe(false)
  })
})

describe('the fence', () => {
  test('a thread with no folder of its own (shared, or dedicated in the agent folder) has no editor', async () => {
    own = null
    expect((await fail(svc.read({ thread_id: T }))).message).toBe(AGENTS_MD_WORDING.shared)
    expect((await fail(svc.write({ thread_id: T, text: 'x', base_sha: null }))).message).toBe(AGENTS_MD_WORDING.shared)
    const agentDir = join(top, 'agent')
    mkdirSync(agentDir)
    const config = (cwd?: string) => ({
      default_thread: 'general',
      dedicated: { enabled: true },
      threads: [
        { id: 'general', kind: 'fixed' },
        { id: T, kind: 'fixed', session: 'dedicated', ...(cwd ? { session_opts: { cwd } } : {}) },
        { id: 'shared', kind: 'fixed' },
      ],
    })
    expect(agentsMdFolderFor(config(root), agentDir, T)).toBe(root)
    expect(agentsMdFolderFor(config(), agentDir, T)).toBeNull() // dedicated, but in the agent folder: Main's file
    expect(agentsMdFolderFor(config(agentDir), agentDir, T)).toBeNull()
    expect(agentsMdFolderFor(config(top), agentDir, T)).toBeNull() // a folder that holds the agent folder: Main reads it too
    expect(agentsMdFolderFor(config(root), agentDir, 'shared')).toBeNull()
    expect(agentsMdFolderFor(config(root), agentDir, 'general')).toBeNull()
  })

  test('AGENTS.md as a link is not read or replaced; the file it points at is untouched', async () => {
    const elsewhere = join(top, 'elsewhere.md')
    writeFileSync(elsewhere, 'SECRET\n')
    symlinkSync(elsewhere, md())
    expect((await fail(svc.read({ thread_id: T }))).message).toBe(AGENTS_MD_WORDING.link)
    expect((await fail(svc.write({ thread_id: T, text: 'x', base_sha: null }))).message).toBe(AGENTS_MD_WORDING.link)
    expect(readFileSync(elsewhere, 'utf8')).toBe('SECRET\n')
  })

  test('AGENTS.md with a second name outside the folder (a hard link) is refused: a save must not reach that file', async () => {
    const elsewhere = join(top, 'elsewhere.md')
    writeFileSync(elsewhere, 'SECRET\n')
    linkSync(elsewhere, md())
    expect((await fail(svc.read({ thread_id: T }))).message).toBe(AGENTS_MD_WORDING.refused)
    expect((await fail(svc.write({ thread_id: T, text: 'x', base_sha: sha('SECRET\n') }))).code).toBe('bad_frame')
    expect(readFileSync(elsewhere, 'utf8')).toBe('SECRET\n')
  })

  test('a folder inside a hidden or refused place, or an AGENTS.md a lead marker protects, is refused', async () => {
    const hidden = join(top, '.config', 'trip')
    mkdirSync(hidden, { recursive: true })
    own = hidden
    files = new FilesService({
      rootFor: () => hidden,
      refused: [home],
      media: { uploadBytes: async () => ({}) as never },
    })
    svc = make()
    expect((await fail(svc.read({ thread_id: T }))).code).toBe('bad_frame')
    expect((await fail(svc.write({ thread_id: T, text: 'x', base_sha: null }))).code).toBe('bad_frame')
    expect(existsSync(join(hidden, 'AGENTS.md'))).toBe(false)

    own = root
    files = new FilesService({
      rootFor: () => root,
      refused: [home],
      media: { uploadBytes: async () => ({}) as never },
    })
    svc = make()
    writeFileSync(join(root, '.talos-lead'), JSON.stringify({ protect: [md()] }))
    expect((await fail(svc.write({ thread_id: T, text: 'x', base_sha: null }))).code).toBe('bad_frame')
    expect(existsSync(md())).toBe(false)
  })
})

describe('a change made outside Settings', () => {
  test('is never refused: Settings shows it as a diff against the last save, until the next save', async () => {
    await svc.write({ thread_id: T, text: 'one\ntwo\n', base_sha: null })
    writeFileSync(md(), 'one\ntwo\nthree, from the agent\n')
    const r = await svc.read({ thread_id: T })
    expect(r.text).toBe('one\ntwo\nthree, from the agent\n')
    expect(r.outside_diff).toContain('+three, from the agent')
    // a save over it (it was loaded, so its sha is the base) ends the diff
    const s = await svc.write({ thread_id: T, text: r.text as string, base_sha: r.sha })
    expect(s.outside_diff).toBeUndefined()
    expect((await svc.read({ thread_id: T })).outside_diff).toBeUndefined()
  })

  test('a session start says so once per change, and never for a save made in Settings or a file Settings never saved', async () => {
    writeFileSync(md(), 'written by hand\n')
    expect(await svc.changedOutside(T)).toBe(false) // Settings never saved it: nothing to compare with
    await svc.write({ thread_id: T, text: 'from settings\n', base_sha: sha('written by hand\n') })
    expect(await svc.changedOutside(T)).toBe(false)
    writeFileSync(md(), 'changed by the agent\n')
    expect(await svc.changedOutside(T)).toBe(true)
    expect(await svc.changedOutside(T)).toBe(false) // once
    writeFileSync(md(), 'changed again\n')
    expect(await svc.changedOutside(T)).toBe(true)
    rmSync(md())
    expect(await svc.changedOutside(T)).toBe(true) // deleted is a change too
    // a thread with no folder of its own, or a fence refusal, is a quiet false: it never holds a start
    own = null
    expect(await svc.changedOutside(T)).toBe(false)
    own = root
    symlinkSync(join(top, 'nowhere'), md())
    expect(await svc.changedOutside(T)).toBe(false)
  })
})

describe('the review of 2026-11-11', () => {
  test('a save whose answer was lost, sent again, is saved, not a conflict', async () => {
    writeFileSync(md(), 'before\n')
    const loaded = await svc.read({ thread_id: T })
    await svc.write({ thread_id: T, text: 'after\n', base_sha: loaded.sha })
    // the app never heard back, and saves the same text from the same load again
    expect(await svc.write({ thread_id: T, text: 'after\n', base_sha: loaded.sha })).toMatchObject({ saved: true })
    expect(readFileSync(md(), 'utf8')).toBe('after\n')
  })

  test("records made in another folder do not count: no diff against that folder's text, no line for it", async () => {
    await svc.write({ thread_id: T, text: 'in folder A\n', base_sha: null })
    const b = join(top, 'b')
    mkdirSync(b)
    writeFileSync(join(b, 'AGENTS.md'), 'in folder B\n')
    own = b
    files = new FilesService({ rootFor: () => b, refused: [home], media: { uploadBytes: async () => ({}) as never } })
    svc = make()
    expect((await svc.read({ thread_id: T })).outside_diff).toBeUndefined()
    expect(await svc.changedOutside(T)).toBe(false)
  })

  test('a file that fits 64 KB but not one frame as JSON (control characters take six bytes there) is too large', async () => {
    writeFileSync(md(), '\u0001'.repeat(40_000))
    expect(await svc.read({ thread_id: T })).toEqual({ thread_id: T, exists: true, sha: null, too_large: true })
  })

  test('a diff beside a text near the frame cap is cut to the room left, or left out; the answer always fits', async () => {
    await svc.write({ thread_id: T, text: 'x\n', base_sha: null })
    for (const n of [34_131, 34_133, 30_000, 20_000]) {
      writeFileSync(md(), '\u0001'.repeat(n)) // six JSON bytes each: 34,131 leaves 12 bytes under the 200 KB answer cap
      const r = await svc.read({ thread_id: T })
      if (r.too_large) continue
      expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(256 * 1024 - 16 * 1024)
    }
  })

  test('a file with a byte-order mark opens, its sha is of its bytes, and a save keeps the mark', async () => {
    const bytes = Buffer.from('\uFEFF# Trip\n', 'utf8')
    writeFileSync(md(), bytes)
    const r = await svc.read({ thread_id: T })
    expect(r.sha).toBe(sha(bytes))
    expect(r.text).toBe('\uFEFF# Trip\n')
    await svc.write({ thread_id: T, text: `${r.text}more\n`, base_sha: r.sha })
    expect(readFileSync(md()).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
  })

  test('a file that is not UTF-8 is refused, never decoded and written back changed', async () => {
    writeFileSync(md(), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]))
    expect((await fail(svc.read({ thread_id: T }))).message).toBe(AGENTS_MD_WORDING.notText)
    expect(readFileSync(md())).toEqual(Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]))
  })

  test('back to the saved text and changed again: the next start says so again', async () => {
    await svc.write({ thread_id: T, text: 'saved\n', base_sha: null })
    writeFileSync(md(), 'A\n')
    expect(await svc.changedOutside(T)).toBe(true)
    writeFileSync(md(), 'saved\n')
    expect(await svc.changedOutside(T)).toBe(false)
    writeFileSync(md(), 'A\n')
    expect(await svc.changedOutside(T)).toBe(true)
  })

  test('a save that fails leaves AGENTS.md, the previous text and the folder as they were', async () => {
    writeFileSync(md(), 'one\n')
    await svc.write({ thread_id: T, text: 'two\n', base_sha: sha('one\n') })
    const prev = join(home, 'threads', T, 'agents-md.prev')
    expect(readFileSync(prev, 'utf8')).toBe('one\n')
    chmodSync(root, 0o500) // the new file cannot be created
    try {
      expect((await fail(svc.write({ thread_id: T, text: 'three\n', base_sha: sha('two\n') }))).message).toBe(
        AGENTS_MD_WORDING.saveFailed,
      )
    } finally {
      chmodSync(root, 0o700)
    }
    expect(readFileSync(md(), 'utf8')).toBe('two\n')
    expect(readFileSync(prev, 'utf8')).toBe('one\n')
    expect(readdirSync(root)).toEqual(['AGENTS.md'])
  })

  test('an edit that lands between the check and the rename is not replaced: the save is refused', async () => {
    writeFileSync(md(), 'loaded\n')
    let opens = 0
    openSeam.beforeOpen = (p) => {
      // the second look at AGENTS.md is the one just before the rename: the agent writes in between
      if (p === md() && ++opens === 2) writeFileSync(md(), 'the agent, just now\n')
    }
    expect((await fail(svc.write({ thread_id: T, text: 'mine\n', base_sha: sha('loaded\n') }))).code).toBe('stale')
    expect(readFileSync(md(), 'utf8')).toBe('the agent, just now\n')
    expect(readdirSync(root)).toEqual(['AGENTS.md'])
  })
})
