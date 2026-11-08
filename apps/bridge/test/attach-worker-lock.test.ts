// A lead's `attach` may send its own files, never one from the Talos home: media/ holds every thread's attachments in one
// flat folder, so another thread's file would leave through this thread.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paths } from '../src/config.ts'
import { MediaStore } from '../src/media.ts'
import { attach } from '../src/tools/send.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
function setup() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'aw-'))
  made.push(base)
  const home = join(base, 'home')
  const p = paths(home)
  mkdirSync(p.media, { recursive: true })
  const puts: string[] = []
  const media = new MediaStore(p, { putMedia: async (id: string) => void puts.push(id) } as never)
  const other = join(p.media, 'md_other_thread.png')
  writeFileSync(other, 'another thread file')
  const own = join(base, 'lead', 'report.txt')
  mkdirSync(join(base, 'lead'))
  writeFileSync(own, 'mine')
  return { base, p, media, puts, other, own }
}
const call = (s: ReturnType<typeof setup>, path: string, worker: boolean) =>
  attach.handler(
    {
      media: s.media,
      ...(worker ? { worker: { thread: 'trip' } } : {}),
      mode: 'live',
      config: { thread: () => ({ id: 'trip' }), threadIds: () => ['trip'] },
      seen: { take: () => [] },
    } as never,
    { path, thread_id: 'trip' },
  )

describe('attach from a lead', () => {
  test("another thread's media file is refused and never uploaded", async () => {
    const s = setup()
    const r = await call(s, s.other, true)
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r)).toMatch(/Talos|protected|not allowed/i)
    expect(s.puts).toEqual([])
  })
  test('the same file through a symlink is refused too', async () => {
    const s = setup()
    const { symlinkSync } = await import('node:fs')
    const link = join(s.base, 'lead', 'innocent.png')
    symlinkSync(s.other, link)
    expect((await call(s, link, true)).isError).toBe(true)
    expect(s.puts).toEqual([])
  })
  test("main's own attach of a media file is unchanged", () => {
    const s = setup()
    expect(() => s.media.checkUploadable(s.other)).not.toThrow()
    expect(() => s.media.checkUploadable(s.other, { worker: true })).toThrow(/Talos|protected/i)
    expect(() => s.media.checkUploadable(s.own, { worker: true })).not.toThrow()
  })
})

// A lead's marker (.talos-lead in its session folder) lists the protected roots; attach refuses anything inside them.
describe('attach from a lead: the protected roots in its marker', () => {
  function lead(protectOf: (base: string) => unknown = (b) => [join(b, 'agent')]) {
    const s = setup()
    const agent = join(s.base, 'agent')
    mkdirSync(join(agent, 'memory'), { recursive: true })
    writeFileSync(join(agent, 'memory', 'STATE.md'), 'private state')
    const folder = join(s.base, 'lead')
    const marker = (v: unknown) =>
      writeFileSync(join(folder, '.talos-lead'), typeof v === 'string' ? v : JSON.stringify(v))
    marker({ thread: 'trip', protect: protectOf(s.base) })
    const callIn = (path: string, cwd: string | undefined = folder) =>
      attach.handler(
        {
          media: s.media,
          worker: { thread: 'trip' },
          mode: 'live',
          config: {
            thread: () => ({ id: 'trip', ...(cwd ? { session_opts: { cwd } } : {}) }),
            threadIds: () => ['trip'],
          },
          seen: { take: () => [] },
        } as never,
        { path, thread_id: 'trip' },
      )
    return { ...s, agent, folder, marker, callIn, secret: join(agent, 'memory', 'STATE.md') }
  }
  test('a file under a protected root is refused and never uploaded', async () => {
    const l = lead()
    const r = await l.callIn(l.secret)
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r)).toMatch(/protected|lead/i)
    expect(l.puts).toEqual([])
  })
  test('the same file through a symlink in the lead folder is refused', async () => {
    const l = lead()
    const link = join(l.folder, 'notes.md')
    symlinkSync(l.secret, link)
    expect((await l.callIn(link)).isError).toBe(true)
    expect(l.puts).toEqual([])
  })
  test('letter case and the /private spelling of a root make no difference', async () => {
    const l = lead((b) => [join(b, 'AGENT').replace(/^\/private/, '')])
    expect((await l.callIn(l.secret)).isError).toBe(true)
    expect(l.puts).toEqual([])
  })
  test("a file in the lead's own folder is allowed", () => {
    const l = lead()
    const mine = join(l.folder, 'report.txt')
    writeFileSync(mine, 'mine')
    expect(() => l.media.checkUploadable(mine, { worker: true, leadCwd: l.folder })).not.toThrow()
    expect(() => l.media.checkUploadable(l.secret, { worker: true, leadCwd: l.folder })).toThrow(/protected|lead/i)
  })
  test('a marker that exists but cannot be parsed refuses everything (fail closed)', async () => {
    for (const bad of [
      '{ not json',
      JSON.stringify({ thread: 'trip' }),
      JSON.stringify({ protect: 'x' }),
      JSON.stringify({ protect: [] }),
    ]) {
      const l = lead()
      l.marker(bad)
      const mine = join(l.folder, 'report.txt')
      writeFileSync(mine, 'mine')
      expect(() => l.media.checkUploadable(mine, { worker: true, leadCwd: l.folder }), bad).toThrow(/marker|lead/i)
      expect((await l.callIn(mine)).isError, bad).toBe(true)
      expect(l.puts).toEqual([])
    }
  })
  test('no marker at the thread folder, or no folder at all: behaves as before', () => {
    const l = lead()
    const mine = join(l.folder, 'report.txt')
    writeFileSync(mine, 'mine')
    const elsewhere = join(l.base, 'plain')
    mkdirSync(elsewhere)
    expect(() => l.media.checkUploadable(l.secret, { worker: true, leadCwd: elsewhere })).not.toThrow()
    expect(() => l.media.checkUploadable(l.secret, { worker: true })).not.toThrow()
    expect(() => l.media.checkUploadable(l.secret, { worker: true, leadCwd: join(l.base, 'missing') })).not.toThrow()
    expect(() => l.media.checkUploadable(mine, { worker: true, leadCwd: elsewhere })).not.toThrow()
  })
  test("main's own attach is untouched by any marker", () => {
    const l = lead()
    expect(() => l.media.checkUploadable(l.secret)).not.toThrow()
  })
})

// A thread's inbox (~/.talos-inbox/<thread>/, outside the Talos home) holds the files the owner sent that thread. Its own
// session may send them back; it may not send another thread's.
describe('attach from a lead: the thread inbox', () => {
  function inboxes() {
    const base = mkdtempSync(join(realpathSync(tmpdir()), 'aw-inbox-'))
    made.push(base)
    const home = join(base, 'home')
    const root = join(base, '.talos-inbox')
    const p = paths(home, root)
    mkdirSync(p.media, { recursive: true })
    for (const t of ['trip', 'garden']) {
      mkdirSync(join(root, t), { recursive: true, mode: 0o700 })
      writeFileSync(join(root, t, 'md_a.png'), `${t} file`)
    }
    const puts: string[] = []
    const media = new MediaStore(p, { putMedia: async (id: string) => void puts.push(id) } as never)
    const callIn = (path: string, thread = 'trip') =>
      attach.handler(
        {
          media,
          worker: { thread },
          mode: 'live',
          config: { thread: () => ({ id: thread }), threadIds: () => [thread] },
          seen: { take: () => [] },
        } as never,
        { path, thread_id: thread },
      )
    return {
      base,
      home,
      root,
      media,
      puts,
      callIn,
      own: join(root, 'trip', 'md_a.png'),
      other: join(root, 'garden', 'md_a.png'),
    }
  }
  test("a session may attach a file from its own thread's inbox", () => {
    const s = inboxes()
    expect(() => s.media.checkUploadable(s.own, { worker: true, thread: 'trip' })).not.toThrow()
  })
  test("it may not attach another thread's inbox file, and nothing is uploaded", async () => {
    const s = inboxes()
    expect(() => s.media.checkUploadable(s.other, { worker: true, thread: 'trip' })).toThrow(/another thread|inbox/i)
    const r = await s.callIn(s.other)
    expect(r.isError).toBe(true)
    expect(s.puts).toEqual([])
  })
  test('a link in its own inbox that points at another thread is refused (the real path decides)', () => {
    const s = inboxes()
    symlinkSync(s.other, join(s.root, 'trip', 'innocent.png'))
    expect(() =>
      s.media.checkUploadable(join(s.root, 'trip', 'innocent.png'), { worker: true, thread: 'trip' }),
    ).toThrow()
  })
  test("a thread folder that is itself a link to another thread's folder gives the other thread's files no way out", () => {
    const s = inboxes()
    rmSync(join(s.root, 'trip'), { recursive: true })
    symlinkSync(join(s.root, 'garden'), join(s.root, 'trip'))
    expect(() => s.media.checkUploadable(join(s.root, 'trip', 'md_a.png'), { worker: true, thread: 'trip' })).toThrow()
  })
  test('the lead marker does not stop its own inbox, and still stops the protected roots', () => {
    const s = inboxes()
    const folder = join(s.base, 'lead')
    mkdirSync(folder)
    writeFileSync(join(folder, '.talos-lead'), JSON.stringify({ thread: 'trip', protect: [s.home, s.root] }))
    expect(() => s.media.checkUploadable(s.own, { worker: true, thread: 'trip', leadCwd: folder })).not.toThrow()
    expect(() => s.media.checkUploadable(s.other, { worker: true, thread: 'trip', leadCwd: folder })).toThrow()
  })
  test("a worker still cannot send from the Talos home, and main's own attach is untouched", () => {
    const s = inboxes()
    const secret = join(s.home, 'config.json')
    writeFileSync(secret, '{}')
    expect(() => s.media.checkUploadable(secret, { worker: true, thread: 'trip' })).toThrow()
    expect(() => s.media.checkUploadable(s.other)).not.toThrow()
  })
})
