// A dedicated thread's session reads the owner's files from `workers/<thread>/inbox/`, never from media/ (one flat folder
// for every thread). The hub copies each file there as it routes the message; `read_inbound` returns the copy's path.
// Nothing is written through a link, files are 0600 in a 0700 folder, and old or too many copies are removed.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { pgidOf } from '../src/hub/server.ts'
import { nullLogger } from '../src/log.ts'
import {
  copyToInbox,
  InboxError,
  inboxPath,
  inboxSeam,
  placeFilesInInbox,
  pruneInbox,
  pruneInboxes,
  removeGoneInboxes,
  removeInbox,
} from '../src/worker/inbox.ts'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'

const NONCE = 'test-nonce-0123456789abcdef'
const made: string[] = []
let h: Harness | undefined
let worker: Bridge | undefined
afterEach(async () => {
  await worker?.stop()
  worker = undefined
  await h?.stop()
  h = undefined
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p: string) => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), p))
  made.push(d)
  return d
}
const mode = (p: string) => statSync(p).mode & 0o777

describe('copyToInbox: the unit', () => {
  function setup() {
    const base = tmp('ib-')
    const media = join(base, 'home', 'media')
    mkdirSync(media, { recursive: true })
    writeFileSync(join(media, 'md_one.png'), 'picture bytes')
    return { media, root: join(base, '.talos-inbox'), base }
  }
  const copy = (s: { media: string; root: string }, source = join(s.media, 'md_one.png'), thread = 'trip') =>
    copyToInbox({ root: s.root, mediaDir: s.media, thread, source })
  afterEach(() => {
    inboxSeam.beforeRecheck = undefined
  })
  test('copies a media file into <root>/<thread>/ as 0600 in 0700 folders, the root too', () => {
    const s = setup()
    const out = copy(s)
    expect(out).toBe(join(inboxPath(s.root, 'trip'), 'md_one.png'))
    expect(readFileSync(out, 'utf8')).toBe('picture bytes')
    expect(mode(out)).toBe(0o600)
    expect(mode(inboxPath(s.root, 'trip'))).toBe(0o700)
    expect(mode(s.root)).toBe(0o700)
    expect(existsSync(join(s.media, 'md_one.png'))).toBe(true) // main's copy stays
    expect(readdirSync(inboxPath(s.root, 'trip'))).toEqual(['md_one.png']) // no temp file left behind
  })
  test('a root that is looser than 0700 is tightened', () => {
    const s = setup()
    mkdirSync(s.root, { mode: 0o755 })
    chmodSync(s.root, 0o755)
    copy(s)
    expect(mode(s.root)).toBe(0o700)
  })
  test('a link as the root or as the thread folder is refused and nothing is written through it', () => {
    for (const where of ['root', 'thread'] as const) {
      const s = setup()
      const target = tmp('ib-target-')
      if (where === 'root') symlinkSync(target, s.root)
      else {
        mkdirSync(s.root)
        symlinkSync(target, join(s.root, 'trip'))
      }
      expect(() => copy(s), where).toThrow(InboxError)
      expect(readdirSync(target), where).toEqual([])
    }
  })
  test('a thread id that is not a thread id is refused', () => {
    const s = setup()
    for (const thread of ['..', 'a/b', '', 'Trip', '.hidden'])
      expect(() => copy(s, undefined, thread), thread).toThrow(InboxError)
    expect(existsSync(s.root)).toBe(false)
  })
  test('a file that is not in the media folder, or reaches it through a link, is refused', () => {
    const s = setup()
    const outside = join(tmp('ib-out-'), 'secret.txt')
    writeFileSync(outside, 'secret')
    symlinkSync(outside, join(s.media, 'md_link.png'))
    for (const source of [outside, join(s.media, 'md_link.png'), join(s.media, 'nope.png'), join(s.media, '..', 'x')])
      expect(() => copy(s, source), source).toThrow(InboxError)
    expect(existsSync(inboxPath(s.root, 'trip'))).toBe(false)
  })
  test('a link already at the destination is replaced, never written through', () => {
    const s = setup()
    const dir = inboxPath(s.root, 'trip')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const victim = join(tmp('ib-victim-'), 'v.txt')
    writeFileSync(victim, 'keep me')
    symlinkSync(victim, join(dir, 'md_one.png'))
    copy(s)
    expect(readFileSync(victim, 'utf8')).toBe('keep me')
    expect(readFileSync(join(dir, 'md_one.png'), 'utf8')).toBe('picture bytes')
  })
  test('placeFilesInInbox rewrites every file_path key and leaves the rest', () => {
    const s = setup()
    writeFileSync(join(s.media, 'md_two.txt'), 'two')
    const n = placeFilesInInbox(
      {
        content: 'see attached',
        meta: {
          thread_id: 'trip',
          file_path: join(s.media, 'md_one.png'),
          file_path_2: join(s.media, 'md_two.txt'),
          file_name: 'a.png',
        },
      },
      { root: s.root, mediaDir: s.media, thread: 'trip', now: Date.now() },
    )
    const dir = inboxPath(s.root, 'trip')
    expect(n.meta).toMatchObject({
      thread_id: 'trip',
      file_name: 'a.png',
      file_path: join(dir, 'md_one.png'),
      file_path_2: join(dir, 'md_two.txt'),
    })
    expect(n.content).toBe('see attached')
    const plain = { content: 'hi', meta: { thread_id: 'trip' } }
    expect(placeFilesInInbox(plain, { root: s.root, mediaDir: s.media, thread: 'trip', now: 0 })).toBe(plain)
  })
  test('files past the tenth are not named by their media path: the line says they were left out', () => {
    const s = setup()
    const line = `(2 more files beyond file_path_10: ${join(s.media, 'md_a.png')}, ${join(s.media, 'md_b.png')})`
    const n = placeFilesInInbox(
      { content: `look\n${line}`, meta: { thread_id: 'trip', file_path: join(s.media, 'md_one.png') } },
      { root: s.root, mediaDir: s.media, thread: 'trip', now: Date.now() },
    )
    expect(n.content).not.toContain(s.media)
    expect(n.content).toMatch(/2 more files .*left out/)
    expect(n.content.startsWith('look\n')).toBe(true)
  })

  describe('a folder swapped for a link between the check and the act', () => {
    const swap = (dir: string, target: string) => {
      renameSync(dir, `${dir}.moved`)
      symlinkSync(target, dir)
    }
    for (const stage of ['write', 'rename'] as const)
      test(`before the ${stage}: refused, and nothing lands in the link's target`, () => {
        const s = setup()
        const target = tmp('ib-target-')
        let swapped = false
        inboxSeam.beforeRecheck = (st) => {
          if (st !== stage || swapped) return
          swapped = true
          swap(inboxPath(s.root, 'trip'), target)
        }
        expect(() => copy(s)).toThrow(InboxError)
        expect(swapped).toBe(true)
        expect(readdirSync(target)).toEqual([])
      })
    test('swapped for a different real folder (a new inode): refused too', () => {
      const s = setup()
      let swapped = false
      inboxSeam.beforeRecheck = (st) => {
        if (st !== 'rename' || swapped) return
        swapped = true
        const dir = inboxPath(s.root, 'trip')
        renameSync(dir, `${dir}.moved`)
        mkdirSync(dir, { mode: 0o700 })
      }
      expect(() => copy(s)).toThrow(InboxError)
      expect(readdirSync(inboxPath(s.root, 'trip'))).toEqual([])
    })
    test('the root swapped for a link: refused', () => {
      const s = setup()
      const target = tmp('ib-target-')
      let swapped = false
      inboxSeam.beforeRecheck = (st) => {
        if (st !== 'write' || swapped) return
        swapped = true
        swap(s.root, target)
      }
      expect(() => copy(s)).toThrow(InboxError)
      expect(readdirSync(target)).toEqual([])
    })
    test('a prune whose folder is swapped for a link removes nothing in the target', () => {
      const s = setup()
      const dir = inboxPath(s.root, 'trip')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, 'old.png'), 'x')
      utimesSync(join(dir, 'old.png'), new Date(0), new Date(0))
      const target = tmp('ib-target-')
      writeFileSync(join(target, 'old.png'), 'precious')
      utimesSync(join(target, 'old.png'), new Date(0), new Date(0))
      let swapped = false
      inboxSeam.beforeRecheck = (st) => {
        if (st !== 'unlink' || swapped) return
        swapped = true
        swap(dir, target)
      }
      pruneInbox(s.root, 'trip', Date.now(), { maxAgeMs: 1000, maxBytes: 1e9 })
      expect(swapped).toBe(true)
      expect(readFileSync(join(target, 'old.png'), 'utf8')).toBe('precious')
    })
  })
})

describe('pruneInbox: bounded by age and size', () => {
  function inbox(files: Array<{ name: string; size: number; ageMs: number }>, now: number) {
    const root = join(tmp('ib-prune-'), '.talos-inbox')
    const dir = inboxPath(root, 'trip')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (const f of files) {
      const p = join(dir, f.name)
      writeFileSync(p, Buffer.alloc(f.size))
      const at = new Date(now - f.ageMs)
      utimesSync(p, at, at)
    }
    return { root, dir }
  }
  test('files past the age limit go; newer ones stay', () => {
    const now = Date.now()
    const s = inbox(
      [
        { name: 'old.png', size: 10, ageMs: 9_000 },
        { name: 'new.png', size: 10, ageMs: 1_000 },
      ],
      now,
    )
    pruneInbox(s.root, 'trip', now, { maxAgeMs: 5_000, maxBytes: 1e9 })
    expect(readdirSync(s.dir)).toEqual(['new.png'])
  })
  test('over the size limit the oldest go first until it fits', () => {
    const now = Date.now()
    const s = inbox(
      [
        { name: 'a.bin', size: 40, ageMs: 3_000 },
        { name: 'b.bin', size: 40, ageMs: 2_000 },
        { name: 'c.bin', size: 40, ageMs: 1_000 },
      ],
      now,
    )
    pruneInbox(s.root, 'trip', now, { maxAgeMs: 1e9, maxBytes: 90 })
    expect(readdirSync(s.dir).sort()).toEqual(['b.bin', 'c.bin'])
  })
  test('a link in the inbox is removed itself, its target is left alone; a missing inbox is fine', () => {
    const now = Date.now()
    const s = inbox([], now)
    const victim = join(tmp('ib-victim-'), 'v.txt')
    writeFileSync(victim, 'keep')
    symlinkSync(victim, join(s.dir, 'l.png'))
    pruneInbox(s.root, 'trip', now)
    expect(readdirSync(s.dir)).toEqual([])
    expect(readFileSync(victim, 'utf8')).toBe('keep')
    expect(() => pruneInbox(join(tmp('ib-none-'), '.talos-inbox'), 'trip', now)).not.toThrow()
  })
  test('pruneInboxes walks every thread folder and skips names that are not thread ids', () => {
    const now = Date.now()
    const s = inbox([{ name: 'old.png', size: 1, ageMs: 9_000 }], now)
    mkdirSync(join(s.root, 'garden'), { mode: 0o700 })
    writeFileSync(join(s.root, 'garden', 'old.png'), 'x')
    utimesSync(join(s.root, 'garden', 'old.png'), new Date(0), new Date(0))
    mkdirSync(join(s.root, 'NotAThread'))
    writeFileSync(join(s.root, 'NotAThread', 'old.png'), 'x')
    utimesSync(join(s.root, 'NotAThread', 'old.png'), new Date(0), new Date(0))
    pruneInboxes(s.root, now, { maxAgeMs: 5_000, maxBytes: 1e9 })
    expect(readdirSync(s.dir)).toEqual([])
    expect(readdirSync(join(s.root, 'garden'))).toEqual([])
    expect(readdirSync(join(s.root, 'NotAThread'))).toEqual(['old.png'])
  })
})

describe('removing the inbox of a thread that is gone', () => {
  function inboxes(...threads: string[]) {
    const root = join(tmp('ib-gone-'), '.talos-inbox')
    for (const t of threads) {
      mkdirSync(inboxPath(root, t), { recursive: true, mode: 0o700 })
      writeFileSync(join(inboxPath(root, t), 'f.png'), 'x')
    }
    return root
  }
  test('removeInbox deletes that thread folder and its files only', () => {
    const root = inboxes('trip', 'garden')
    removeInbox(root, 'trip')
    expect(readdirSync(root)).toEqual(['garden'])
  })
  test('removeInbox never follows a link: a link is removed, the target stays', () => {
    const root = inboxes('garden')
    const target = tmp('ib-target-')
    writeFileSync(join(target, 'keep.txt'), 'keep')
    symlinkSync(target, join(root, 'trip'))
    removeInbox(root, 'trip')
    expect(existsSync(join(root, 'trip'))).toBe(false)
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep')
  })
  test('removeGoneInboxes keeps live threads and removes archived, removed and unknown ones', () => {
    const root = inboxes('trip', 'garden', 'old_one')
    removeGoneInboxes(root, ['trip'])
    expect(readdirSync(root)).toEqual(['trip'])
  })
  test('a missing root is fine', () => {
    expect(() => removeGoneInboxes(join(tmp('ib-none-'), '.talos-inbox'), [])).not.toThrow()
    expect(() => removeInbox(join(tmp('ib-none-'), '.talos-inbox'), 'trip')).not.toThrow()
  })
})

// ---- through the hub: a real bridge routing an owner message with a file to a dedicated thread -----------------------

const thread = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: 'fixed',
  order: 5,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...extra,
})
/** The test root of the inbox. Never the real ~/.talos-inbox: the harness and the worker both get this one. */
let inboxRoot = ''
async function hub(extraThreads: unknown[] = []) {
  inboxRoot = join(tmp('ib-root-'), '.talos-inbox')
  h = await startHarness({
    env: { TALOS_INBOX_ROOT: inboxRoot },
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [
        ...c.threads,
        thread('trip', 'Trip', { session: 'dedicated' }),
        thread('shared_one', 'Shared'),
        ...extraThreads,
      ],
      dedicated: { enabled: true },
    })) as never,
  })
  await waitFor(() => existsSync(join(h?.home as string, 'hub.sock')))
  const now = new Date().toISOString()
  writeFileSync(
    join(h.home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: now, workers_supported: true },
      threads: {
        trip: {
          state: 'live',
          session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
          tmux: 't-trip',
          pane_pid: pgidOf(process.pid) as number,
          cwd: h.home,
          error: null,
        },
      },
    }),
  )
  mkdirSync(join(h.home, 'workers', 'trip'), { recursive: true })
  writeFileSync(join(h.home, 'workers', 'trip', 'nonce'), NONCE)
  return h
}
async function upload(hh: Harness, text: string, name = 'notes.txt') {
  const res = await fetch(`${hh.relay.httpUrl}/api/media`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-talos-name': name },
    body: text,
  })
  return { ...((await res.json()) as Record<string, unknown>), role: 'attachment' }
}
async function startWorker(hh: Harness) {
  worker = await Bridge.create({
    env: loadEnv({
      TALOS_APP_HOME: hh.home,
      TALOS_APP_RELAY_URL: hh.relay.httpUrl,
      TALOS_APP_WORKER_THREAD: 'trip',
      TALOS_APP_WORKER_NONCE: NONCE,
    }),
    logger: nullLogger,
  })
  expect(await worker.startWorker()).toBe(true)
  return worker
}

describe('a file sent to a dedicated thread', () => {
  test('read_inbound returns the copy in <inbox root>/<thread>/, not the media path', async () => {
    const hh = await hub()
    const w = await startWorker(hh)
    await hh.app.sendMessage('trip', 'the notes', { attachments: [await upload(hh, 'quarterly numbers')] })
    await waitFor(() => existsSync(join(hh.home, 'workers', 'trip', 'wake')))
    const r = JSON.parse((await w.callTool('read_inbound', {})).content[0]?.text ?? '{}')
    expect(r.messages).toHaveLength(1)
    const path = r.messages[0].meta.file_path as string
    const dir = join(realpathSync(inboxRoot), 'trip')
    expect(realpathSync(path).startsWith(`${dir}/`)).toBe(true)
    expect(path.startsWith(join(hh.home, 'media'))).toBe(false)
    expect(path.includes(`${join(hh.home)}/`)).toBe(false) // outside the Talos home
    expect(readFileSync(path, 'utf8')).toBe('quarterly numbers')
    expect(mode(path)).toBe(0o600)
    expect(mode(dir)).toBe(0o700)
    expect(mode(inboxRoot)).toBe(0o700)
    expect(r.messages[0].meta.file_name).toBe('notes.txt')
  })
  test('the inbox root is a link: nothing is copied through it and main answers the whole message', async () => {
    const hh = await hub()
    const target = tmp('ib-target-')
    symlinkSync(target, inboxRoot)
    await hh.app.sendMessage('trip', 'the notes', { attachments: [await upload(hh, 'quarterly numbers')] })
    await hh.waitNotes(1)
    expect(hh.notes[0]?.meta).toMatchObject({ thread_id: 'trip', routed: 'fallback', reason: 'worker_unavailable' })
    expect(hh.notes[0]?.meta.file_path?.startsWith(join(hh.home, 'media'))).toBe(true)
    expect(readdirSync(target)).toEqual([])
    expect(existsSync(join(hh.home, 'workers', 'trip', 'wake'))).toBe(false)
  })
  test('a shared thread keeps the media path, and no inbox is made for it', async () => {
    const hh = await hub()
    await hh.app.sendMessage('shared_one', 'the notes', { attachments: [await upload(hh, 'mine')] })
    await hh.waitNotes(1)
    await sleep(50)
    expect(hh.notes[0]?.meta.file_path?.startsWith(join(hh.home, 'media'))).toBe(true)
    expect(existsSync(join(inboxRoot, 'shared_one'))).toBe(false)
  })
  test('the test root is not the real one', () => {
    expect(process.env.TALOS_INBOX_ROOT).toBeTruthy()
    expect(process.env.TALOS_INBOX_ROOT).not.toBe(join(process.env.HOME ?? '', '.talos-inbox'))
  })
})

describe('a thread that is archived or deleted loses its inbox', () => {
  function seed(thread: string) {
    const dir = join(inboxRoot, thread)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'f.png'), 'x')
    return dir
  }
  test("the agent's archive_thread removes it at once; another thread's stays", async () => {
    const hh = await hub([thread('scratch', 'Scratch', { kind: 'agent' })])
    const gone = seed('scratch')
    const kept = seed('trip')
    const r = await hh.bridge.callTool('archive_thread', { thread_id: 'scratch' })
    expect(r.isError).toBeFalsy()
    await waitFor(() => !existsSync(gone))
    expect(existsSync(kept)).toBe(true)
  })
  test('an owner config.patch that archives a thread removes it', async () => {
    const hh = await hub([thread('scratch', 'Scratch', { kind: 'agent' })])
    const gone = seed('scratch')
    const kept = seed('trip')
    const cfg = JSON.parse(readFileSync(join(hh.home, 'config.json'), 'utf8'))
    await hh.app.sendConfigPatch(cfg.rev, {
      threads: cfg.threads.map((t: { id: string }) => (t.id === 'scratch' ? { ...t, archived: true } : t)),
    })
    await waitFor(() => !existsSync(gone))
    expect(existsSync(kept)).toBe(true)
  })
  test('an owner config.patch that deletes a thread removes it', async () => {
    const hh = await hub([thread('scratch', 'Scratch', { kind: 'agent' })])
    const gone = seed('scratch')
    const kept = seed('trip')
    const cfg = JSON.parse(readFileSync(join(hh.home, 'config.json'), 'utf8'))
    await hh.app.sendConfigPatch(cfg.rev, { threads: cfg.threads.filter((t: { id: string }) => t.id !== 'scratch') })
    await waitFor(() => !existsSync(gone))
    expect(existsSync(kept)).toBe(true)
  })
})
