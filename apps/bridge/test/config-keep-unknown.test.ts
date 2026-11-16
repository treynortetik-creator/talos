import { describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentConfig, Thread, ThreadSessionOpts } from '@talos-app/protocol'
import { loadExampleConfig } from '@talos-app/testkit'
import { ConfigFile, type ConfigSchema } from '../src/config-file.ts'
import { lossesOf, quarantineArchivedSessions, restoreLosses } from '../src/keep-unknown.ts'
import { tempHome } from './helpers.ts'

// Standing rule 1: the owner's file is never overwritten by what a build does not know. Whatever config.json holds that this
// build's schema cannot read (a key a newer build added, a value that fails its parse) must come out of a save as it went in.

// biome-ignore lint/suspicious/noExplicitAny: the file is read as loose JSON; the tests poke at keys the schema does not have
type Json = Record<string, any>
const firstThread = (c: Json) => c.threads[0]

function setup(
  edit: (c: Json) => void,
  schema?: ConfigSchema,
  log?: { warn: (m: string, f?: Record<string, unknown>) => void },
) {
  const home = tempHome()
  mkdirSync(home, { recursive: true })
  const path = join(home, 'config.json')
  const cfg = structuredClone(loadExampleConfig('default')) as Json
  edit(cfg)
  writeFileSync(path, JSON.stringify(cfg))
  const file = new ConfigFile(path, { ...(schema ? { schema } : {}), ...(log ? { log } : {}) })
  file.load()
  const disk = () => JSON.parse(readFileSync(path, 'utf8')) as Json
  return { file, disk, cfg, path }
}

/** A `config.patch` on one thread: the app lists every thread; the ones it only names keep all their other keys. */
const patchThread = (file: ConfigFile, id: string, change: Json) =>
  file.applyPatch(file.config.rev, {
    threads: file.config.threads.map((t) => (t.id === id ? { id, ...change } : { id: t.id })),
  })

const FUTURE = { nested: { deep: [1, { x: 'y' }] }, flag: true }

describe('config.json keeps what this build does not know', () => {
  test('unknown keys at the top, in a thread and in its session_opts survive a rename and a notify toggle', () => {
    const { file, disk, cfg } = setup((c) => {
      c.future_top = FUTURE
      firstThread(c).future_thread = { a: 1 }
      firstThread(c).session_opts = { model: 'inherit', ops_read: true, future_opt: FUTURE }
      c.notifications.future_note = 'keep'
    })
    const id = firstThread(cfg).id
    const r1 = patchThread(file, id, { name: 'Renamed' })
    expect(r1).toEqual({ ok: true, config: expect.anything() })
    const r2 = patchThread(file, id, { notify: 'off' })
    expect(r2).toEqual({ ok: true, config: expect.anything() })
    const out = disk()
    expect(firstThread(out).name).toBe('Renamed')
    expect(firstThread(out).notify).toBe('off')
    expect(out.future_top).toEqual(FUTURE)
    expect(firstThread(out).future_thread).toEqual({ a: 1 })
    expect(firstThread(out).session_opts.future_opt).toEqual(FUTURE)
    expect(firstThread(out).session_opts.ops_read).toBe(true)
    expect(out.notifications.future_note).toBe('keep')
  })

  test('update() (the agent tools) keeps them too', () => {
    const { file, disk } = setup((c) => {
      c.future_top = FUTURE
      firstThread(c).future_thread = 7
    })
    file.update((c) => ({ ...c, agent: { ...c.agent, name: 'Newname' } }))
    const out = disk()
    expect(out.agent.name).toBe('Newname')
    expect(out.future_top).toEqual(FUTURE)
    expect(firstThread(out).future_thread).toBe(7)
  })

  test('a thread that was removed takes its unknown keys with it; a new thread has none', () => {
    const { file, disk } = setup((c) => {
      c.threads.push({ ...structuredClone(c.threads[0]), id: 'gone_thread', name: 'Gone', future_thread: 1 })
    })
    file.update((c) => ({ ...c, threads: c.threads.filter((t) => t.id !== 'gone_thread') }))
    expect(JSON.stringify(disk())).not.toContain('future_thread')
  })

  test('an older build (a schema without ops_read) keeps ops_read on write', () => {
    const OldOpts = ThreadSessionOpts.omit({ ops_read: true })
    const OldThread = Thread.extend({ session_opts: OldOpts.optional().catch(undefined) })
    const old = AgentConfig.extend({ threads: OldThread.array().min(1).max(40) })
    const { file, disk, cfg } = setup((c) => {
      firstThread(c).session_opts = { model: 'inherit', ops_read: true }
    }, old)
    expect(file.config.threads[0]?.session_opts).not.toHaveProperty('ops_read')
    const id = firstThread(cfg).id
    expect(patchThread(file, id, { name: 'By old build' }).ok).toBe(true)
    const out = disk()
    expect(firstThread(out).name).toBe('By old build')
    expect(firstThread(out).session_opts.ops_read).toBe(true)
  })

  test('a value that fails its parse is kept as it was, not dropped', () => {
    const { file, disk, cfg } = setup((c) => {
      c.theme = { id: 'not a theme', colors: 12 }
      c.trust_mode = 'yes'
      c.dedicated = { enabled: 'maybe', max_live: 2 }
      firstThread(c).session_opts = 'junk'
      c.threads[1].session_opts = { model: 'inherit', ops_read: 'sure', idle_park_min: 'soon' }
    })
    const id = firstThread(cfg).id
    expect(patchThread(file, id, { notify: 'off' }).ok).toBe(true)
    const out = disk()
    expect(out.theme).toEqual({ id: 'not a theme', colors: 12 })
    expect(out.trust_mode).toBe('yes')
    expect(out.dedicated.enabled).toBe('maybe')
    expect(out.dedicated.max_live).toBe(2)
    expect(firstThread(out).session_opts).toBe('junk')
    expect(out.threads[1].session_opts).toEqual({ model: 'inherit', ops_read: 'sure', idle_park_min: 'soon' })
    expect(firstThread(out).notify).toBe('off')
  })

  test('a deliberate change to a field that once failed its parse is written, not undone', () => {
    const { file, disk, cfg } = setup((c) => {
      firstThread(c).session_opts = 'junk'
    })
    const id = firstThread(cfg).id
    const r = patchThread(file, id, { session_opts: { model: 'opus' } })
    expect(r.ok).toBe(true)
    expect(firstThread(disk()).session_opts.model).toBe('opus')
  })
})

describe('config.json keep-unknown edge cases', () => {
  test('repeated session quarantines preserve earlier values even with the same timestamp', () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1234)
    try {
      const original = {
        threads: [
          {
            archived: true,
            session: 'second',
            _unreadable: { session: 'legacy', session_1234_0: 'first' } as Record<string, unknown>,
          },
        ],
      }
      const once = quarantineArchivedSessions(original)
      const twice = quarantineArchivedSessions({
        threads: [{ ...once.threads[0], session: 'third' }],
      })
      expect(twice.threads[0]?._unreadable).toEqual({
        session: 'legacy',
        session_1234_0: 'first',
        session_1234_1: 'second',
        session_1234_2: 'third',
      })
      expect(twice.threads[0]).not.toHaveProperty('session')
      expect(original.threads[0]?.session).toBe('second')
    } finally {
      clock.mockRestore()
    }
  })

  for (const revIncrease of [0, 1]) {
    test(`reloading an archived thread clears its session in memory and on disk with revision increase ${revIncrease}`, () => {
      const { file, disk, cfg, path } = setup((c) => {
        c.threads.push({ ...structuredClone(firstThread(c)), id: 'side', name: 'Side', order: 9 })
      })
      const edited = structuredClone(cfg)
      const side = edited.threads.find((t: Json) => t.id === 'side')
      side.archived = true
      side.session = 'dedicated'
      edited.rev += revIncrease
      const previousMtime = statSync(path).mtimeMs
      writeFileSync(path, JSON.stringify(edited))
      // Ensure the edit is observed without depending on filesystem clock resolution.
      utimesSync(path, previousMtime / 1000 + 1, previousMtime / 1000 + 1)
      expect(file.reloadIfChanged()).toBe(true)
      expect(file.thread('side')?.archived).toBe(true)
      expect(file.thread('side')?.session).toBeUndefined()
      const saved = disk()
      expect(saved.threads.find((t: Json) => t.id === 'side')).not.toHaveProperty('session')
      expect(saved.rev).toBe(file.config.rev)
      expect(file.config.rev).toBe(cfg.rev + 1)
      const fresh = new ConfigFile(path)
      expect(fresh.load()).toEqual(file.config)
      expect(file.reloadIfChanged()).toBe(false)
    })
  }

  test('a newer integration id in work.enabled survives when this build turns another on', () => {
    const { file, disk } = setup((c) => {
      c.work.enabled = ['generic', 'future_integration']
    })
    expect(file.config.work.enabled).toEqual(['generic'])
    expect(file.applyPatch(file.config.rev, { work: { enabled: ['generic', 'zapier'] } }).ok).toBe(true)
    expect(disk().work.enabled).toEqual(['generic', 'future_integration', 'zapier'])
  })

  test('a file that is valid JSON but fails this schema is not overwritten', () => {
    const { file, disk, path, cfg } = setup(() => {})
    const bad = { ...cfg, notifications: { ...cfg.notifications, show_thread_names: 'a_newer_value' } }
    writeFileSync(path, JSON.stringify(bad))
    const before = readFileSync(path, 'utf8')
    expect(() => file.update((c) => ({ ...c, agent: { ...c.agent, name: 'X' } }))).toThrow(
      /not written|unreadable|refus/i,
    )
    const r = patchThread(file, firstThread(cfg).id, { name: 'Y' })
    expect(r.ok).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(disk().notifications.show_thread_names).toBe('a_newer_value')
  })

  test('a file that is not JSON is not overwritten, and the refusal is logged', () => {
    const warns: string[] = []
    const { file, path, cfg } = setup(() => {}, undefined, { warn: (m) => void warns.push(m) })
    writeFileSync(path, '{ "version": 1, oops')
    expect(() => file.update((c) => ({ ...c, agent: { ...c.agent, name: 'X' } }))).toThrow()
    expect(patchThread(file, firstThread(cfg).id, { name: 'Y' }).ok).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('{ "version": 1, oops')
    expect(warns.join('\n')).toMatch(/config\.json/)
  })

  test('keeping a high-risk value logs its path, not its value', () => {
    const warns: string[] = []
    const OldThread = Thread.extend({
      session_opts: ThreadSessionOpts.omit({ ops_read: true }).optional().catch(undefined),
    })
    const old = AgentConfig.extend({ threads: OldThread.array().min(1).max(40) })
    const { file, cfg } = setup(
      (c) => {
        firstThread(c).session_opts = { model: 'inherit', ops_read: true, mcp_allow: ['good', 'Bad Name!'] }
      },
      old,
      { warn: (m, f) => void warns.push(`${m} ${JSON.stringify(f ?? {})}`) },
    )
    expect(patchThread(file, firstThread(cfg).id, { notify: 'off' }).ok).toBe(true)
    const all = warns.join('\n')
    expect(all).toContain('threads.session_opts.ops_read')
    expect(all).not.toContain('Bad Name')
  })

  test('retired keys are stripped on write; future keys stay', () => {
    const { file, disk, cfg } = setup((c) => {
      c.permission_stepup = 'off'
      c.sessions_view = false
      c.mirror = { telegram: 'on', telegram_chat_id: '12345' }
      c.future_top = 1
      for (const t of c.threads) t.mirror = false
      firstThread(c).session_opts = { model: 'inherit', worktree: true, future_opt: 2 }
    })
    expect(patchThread(file, firstThread(cfg).id, { notify: 'off' }).ok).toBe(true)
    const out = disk()
    for (const k of ['permission_stepup', 'sessions_view', 'mirror']) expect(out).not.toHaveProperty(k)
    expect(JSON.stringify(out)).not.toMatch(/telegram|12345/)
    for (const t of out.threads) expect(t).not.toHaveProperty('mirror')
    expect(firstThread(out).session_opts).not.toHaveProperty('worktree')
    expect(out.future_top).toBe(1)
    expect(firstThread(out).session_opts.future_opt).toBe(2)
  })

  test('only an array of objects with unique ids is matched element by element; any other is one value', () => {
    const raw = {
      list: [
        { id: 'a', extra: 1 },
        { id: 'a', extra: 2 },
      ],
      plain: [{ x: 1, drop: true }],
    }
    const read = { list: [{ id: 'a' }, { id: 'a' }], plain: [{ x: 1 }] }
    // untouched by the write: the raw arrays come back whole
    expect(restoreLosses(structuredClone(read), lossesOf(raw, read))).toEqual(raw)
    // changed by the write: the new value stands, nothing is grafted by position
    const changed = { list: [{ id: 'a' }], plain: [{ x: 2 }] }
    expect(restoreLosses(structuredClone(changed), lossesOf(raw, read))).toEqual(changed)
  })
  test('work.enabled with only ids this build does not know keeps them when a known one is turned on', () => {
    const { file, disk } = setup((c) => {
      c.work.enabled = ['future_integration']
    })
    expect(file.config.work.enabled).toEqual([])
    expect(file.applyPatch(file.config.rev, { work: { enabled: ['zapier'] } }).ok).toBe(true)
    expect(disk().work.enabled).toEqual(['future_integration', 'zapier'])
  })

  test('clearing work.enabled (null) takes the ids this build does not know with it; an empty list keeps them', () => {
    const kept = setup((c) => {
      c.work.enabled = ['gmail', 'future_integration']
    })
    expect(kept.file.applyPatch(kept.file.config.rev, { work: { enabled: [] } }).ok).toBe(true)
    expect(kept.disk().work.enabled).toEqual(['future_integration'])
    const cleared = setup((c) => {
      c.work.enabled = ['gmail', 'future_integration']
    })
    expect(cleared.file.applyPatch(cleared.file.config.rev, { work: { enabled: null } }).ok).toBe(true)
    expect(cleared.disk().work.enabled ?? []).toEqual([])
  })

  test('a patch that names a parent that is not a thread id is refused, and the file is left as it was', () => {
    const { file, disk, cfg } = setup(() => {})
    const before = disk()
    const id = cfg.threads.at(-1).id
    const r = file.applyPatch(file.config.rev, {
      threads: file.config.threads.map((t) => (t.id === id ? { id, parent_id: 'Not An Id' } : { id: t.id })),
    })
    expect(r).toMatchObject({ ok: false, code: 'thread_session_refused' })
    expect(disk()).toEqual(before)
  })

  test('a key the patch clears is cleared even when the file holds a value this build cannot read', () => {
    const { file, disk, cfg } = setup((c) => {
      firstThread(c).session = 'a_newer_mode'
    })
    expect(firstThread(file.config).session).toBeUndefined()
    const id = firstThread(cfg).id
    const r = file.applyPatch(file.config.rev, {
      threads: file.config.threads.map((t) => (t.id === id ? { id, session: null } : { id: t.id })),
    })
    expect(r).toMatchObject({ ok: true })
    expect(firstThread(disk())).not.toHaveProperty('session')
  })

  test('a clear in the same patch as trust_mode is kept too', () => {
    const { file, disk, cfg } = setup((c) => {
      firstThread(c).session = 'a_newer_mode'
    })
    const id = firstThread(cfg).id
    const r = file.applyPatch(file.config.rev, {
      trust_mode: false,
      threads: file.config.threads.map((t) => (t.id === id ? { id, session: null } : { id: t.id })),
    })
    expect(r).toMatchObject({ ok: true })
    expect(firstThread(disk())).not.toHaveProperty('session')
  })

  test('a patch that does not name an unreadable key leaves it as it was', () => {
    const { file, disk, cfg } = setup((c) => {
      firstThread(c).session = 'a_newer_mode'
    })
    expect(patchThread(file, firstThread(cfg).id, { name: 'Renamed' }).ok).toBe(true)
    expect(firstThread(disk()).session).toBe('a_newer_mode')
  })

  test('clearing a setting that has a default clears an unreadable value too, though it reads as that default', () => {
    const { file, disk, cfg } = setup((c) => {
      firstThread(c).session_opts = { model: 'sonnet', idle_park_min: 1 }
    })
    const fallback = firstThread(file.config).session_opts.idle_park_min
    expect(fallback).not.toBe(1)
    const r = patchThread(file, firstThread(cfg).id, { session_opts: { idle_park_min: null } })
    expect(r).toMatchObject({ ok: true })
    expect(firstThread(disk()).session_opts.idle_park_min).toBe(fallback)
    expect(firstThread(disk()).session_opts.model).toBe('sonnet')
  })

  test('archiving a thread moves a session value this build cannot read aside instead of leaving it live', () => {
    const { file, disk } = setup((c) => {
      c.threads.push({
        ...structuredClone(firstThread(c)),
        id: 'side',
        name: 'Side',
        order: 9,
        session: 'a_newer_mode',
      })
    })
    const id = 'side'
    const mine = (c: Json) => c.threads.find((t: Json) => t.id === id)
    expect(patchThread(file, id, { archived: true }).ok).toBe(true)
    expect(mine(disk()).archived).toBe(true)
    expect(mine(disk())).not.toHaveProperty('session')
    const kept = mine(disk())._unreadable
    expect(Object.keys(kept)).toEqual([expect.stringMatching(/^session_\d+_0$/)])
    expect(Object.values(kept)).toEqual(['a_newer_mode'])
    // a later save leaves the side record as it is
    expect(file.applyPatch(file.config.rev, { agent: { name: 'Zed' } }).ok).toBe(true)
    expect(mine(disk())._unreadable).toEqual(kept)
    expect(mine(disk())).not.toHaveProperty('session')
  })

  test('keeping a high-risk value inside a restored parent object still logs its path', () => {
    const warns: string[] = []
    const OldThread = Thread.omit({ session_opts: true })
    const old = AgentConfig.extend({ threads: OldThread.array().min(1).max(40) })
    const { file, cfg } = setup(
      (c) => {
        firstThread(c).session_opts = { model: 'inherit', ops_read: true }
      },
      old,
      { warn: (m, f) => void warns.push(`${m} ${JSON.stringify(f ?? {})}`) },
    )
    expect(patchThread(file, firstThread(cfg).id, { notify: 'off' }).ok).toBe(true)
    expect(warns.join('\n')).toContain('threads.session_opts.ops_read')
  })

  test("a list the parse replaced with an empty fallback is one value: the owner's new list stands as it is", () => {
    const raw = { tags: ['a', 'a'] }
    const read = { tags: [] }
    const changed = { tags: ['b'] }
    expect(restoreLosses(structuredClone(changed), lossesOf(raw, read))).toEqual(changed)
  })
})
