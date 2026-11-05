// Option C protocol (docs/OPTION-C.md 9.1, WP-OC0): the per-thread switch is opt-in and off by default, old configs and
// frames are unchanged, and the shared files (workers.json, the wake file, hub lines) parse the same on every side.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AgentConfig,
  applyMergePatch,
  BRIDGE_TOOLS,
  CAP_HOLD_MS,
  CHANNEL_KINDS,
  ChannelMeta,
  CLAIM_DEADLINE_COLD_MS,
  CLAIM_DEADLINE_MS,
  canBeDedicated,
  checkConfigPatch,
  checkWorkerCwd,
  clearArchivedSessions,
  DedicatedConfig,
  DedicatedConfigStrict,
  dedicatedPatchIssue,
  dedicatedSettings,
  ErrorCode,
  FRAME_TYPES,
  HubHubLine,
  HubWorkerLine,
  isFrameFor,
  jcs,
  NEVER_DEDICATED_THREADS,
  OWNER_FRAME_TYPES,
  parseFrame,
  parseWorkersFile,
  SCHEDULE_BRIDGE_TOOLS,
  SessionKind,
  SessionState,
  SUPERVISOR_STALE_MS,
  sessionFieldsIssue,
  supervisorFresh,
  Thread,
  threadSessionMode,
  validateAgentConfig,
  WakeFile,
  WORKER_BRIDGE_TOOLS,
  WORKER_FORBIDDEN_ARGS,
  WORKER_POINTER_TEXT,
  WORKER_THREAD_LOCKED_TOOLS,
  WorkersFile,
  workerSessionName,
  workerTmuxName,
} from '../src/index.ts'
import { loadExample, loadFixtures } from './helpers.ts'

const OC = join(import.meta.dirname, '..', 'fixtures', 'option-c')
const fx = (name: string) => readFileSync(join(OC, name), 'utf8')
const frames = loadFixtures()

const base = {
  id: 'trip',
  name: 'Trip planning',
  kind: 'fixed',
  order: 2,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
} as const

function configWith(threads: unknown[], dedicated?: unknown) {
  const cfg = AgentConfig.parse(loadExample('default'))
  return AgentConfig.parse({ ...cfg, threads: [...cfg.threads, ...threads], ...(dedicated ? { dedicated } : {}) })
}

describe('old configs are unchanged', () => {
  it('the shipped examples parse and validate, and no thread grows a session field', () => {
    for (const name of ['default', 'five-threads'] as const) {
      const raw = loadExample(name)
      const c = AgentConfig.parse(raw)
      expect(validateAgentConfig(c)).toEqual([])
      expect(c.dedicated).toBeUndefined()
      for (const t of c.threads) {
        expect(t).not.toHaveProperty('session')
        expect(t).not.toHaveProperty('session_opts')
      }
    }
  })

  it('a thread without the new fields round-trips byte-equal', () => {
    const parsed = Thread.parse(JSON.parse(JSON.stringify(base)))
    expect(jcs(parsed)).toBe(jcs(base))
  })

  it('every thread is shared when the master switch is absent or off', () => {
    const c = configWith([{ ...base, session: 'dedicated' }])
    expect(threadSessionMode(c, 'trip')).toBe('shared')
    const off = configWith([{ ...base, session: 'dedicated' }], { enabled: false })
    expect(threadSessionMode(off, 'trip')).toBe('shared')
  })
})

describe('the switch', () => {
  it('dedicatedSettings fills the defaults: off, 3 live, governor 80/85/95 on', () => {
    expect(dedicatedSettings({})).toEqual({
      enabled: false,
      max_live: 3,
      governor: { five_hour: 80, weekly: 85, park_all: 95, off: false },
    })
    expect(dedicatedSettings({ dedicated: { enabled: true } }).max_live).toBe(3)
    expect(dedicatedSettings({ dedicated: { enabled: 'yes' } }).enabled).toBe(false) // junk is off, never on
  })

  it('session_opts fills defaults: model inherit, 30 min idle park; an old worktree key is dropped', () => {
    const t = Thread.parse({ ...base, session: 'dedicated', session_opts: {} })
    expect(t.session_opts).toEqual({ model: 'inherit', idle_park_min: 30 })
    const old = Thread.parse({ ...base, session: 'dedicated', session_opts: { worktree: false } })
    expect(old.session_opts).toEqual({ model: 'inherit', idle_park_min: 30 })
    expect(Thread.parse(JSON.parse(jcs(t)))).toEqual(t)
  })

  it('reads junk as shared or off, but refuses to write it', () => {
    for (const session_opts of [
      { cwd: 'relative/path' },
      { cwd: '/ok\npath' },
      { cwd: `/${'a'.repeat(600)}` },
      { model: '--channels' },
      { model: 'opus; rm -rf' },
      { effort: 'HIGH' },
      { idle_park_min: 4 },
      { idle_park_min: 721 },
    ]) {
      const label = JSON.stringify(session_opts)
      expect(sessionFieldsIssue({ threads: [{ ...base, session_opts }] }), label).toMatch(/not valid/)
    }
    expect(Thread.parse({ ...base, session: 'own' }).session).toBeUndefined()
    expect(sessionFieldsIssue({ threads: [{ ...base, session: 'own' }] })).toMatch(/session mode/)
    expect(DedicatedConfigStrict.safeParse({ max_live: 7 }).success).toBe(false)
    expect(sessionFieldsIssue({ dedicated: { max_live: 7 } })).toMatch(/not valid/)
    expect(sessionFieldsIssue({ threads: [base], dedicated: { enabled: true } })).toBeNull()
  })

  it('an unknown session mode or broken dedicated section never breaks a config, and reads as off', () => {
    const cfg = AgentConfig.parse(loadExample('default'))
    const c = AgentConfig.parse({ ...cfg, threads: [...cfg.threads, { ...base, session: 'hybrid' }], dedicated: 3 })
    expect(c.dedicated).toBeUndefined()
    expect(threadSessionMode(c, 'trip')).toBe('shared')
  })

  it('one field this build cannot read falls back alone: the switch, the folder and the rest survive', () => {
    const d = DedicatedConfig.parse({ enabled: true, max_live: 8, governor: { five_hour: 0, weekly: 90 } })
    expect(d).toEqual({ enabled: true, max_live: 3, governor: { five_hour: 80, weekly: 90, park_all: 95, off: false } })
    expect(DedicatedConfig.parse({ enabled: true, governor: 'x' }).governor.five_hour).toBe(80)
    const t = Thread.parse({
      ...base,
      session: 'dedicated',
      session_opts: { cwd: '/Users/example/p', idle_park_min: 9999 },
    })
    expect(t.session_opts).toEqual({ cwd: '/Users/example/p', model: 'inherit', idle_park_min: 30 })
  })

  it('dedicated only when on, asked for, and allowed', () => {
    const c = configWith(
      [
        { ...base, session: 'dedicated' },
        { ...base, id: 'garden', session: 'shared' },
        { ...base, id: 'old', session: 'dedicated', archived: true },
      ],
      { enabled: true },
    )
    expect(threadSessionMode(c, 'trip')).toBe('dedicated')
    expect(threadSessionMode(c, 'garden')).toBe('shared')
    expect(threadSessionMode(c, 'old')).toBe('shared')
    expect(threadSessionMode(c, 'nope')).toBe('shared')
  })

  it('main front doors can never be dedicated: default thread, general, inbox, system threads', () => {
    const cfg = AgentConfig.parse(loadExample('five-threads'))
    const all = AgentConfig.parse({
      ...cfg,
      dedicated: { enabled: true },
      threads: cfg.threads.map((t) => ({ ...t, session: 'dedicated' })),
    })
    for (const id of [...NEVER_DEDICATED_THREADS, all.default_thread]) {
      if (!all.threads.some((t) => t.id === id)) continue
      expect(canBeDedicated(all, id), id).toBe(false)
      expect(threadSessionMode(all, id), id).toBe('shared')
    }
    for (const t of all.threads.filter((x) => x.kind === 'system')) expect(canBeDedicated(all, t.id)).toBe(false)
    expect(dedicatedPatchIssue(cfg, all)).toMatch(/can't have its own session/)
    // a config that already breaks the rule doesn't block an unrelated change, and switching off is never refused
    expect(dedicatedPatchIssue(all, { ...all, dedicated: { enabled: false } })).toBeNull()
    expect(dedicatedPatchIssue(all, all)).toBeNull()
  })

  it('archiving a dedicated thread turns it back to shared instead of being refused', () => {
    const cfg = AgentConfig.parse({ ...loadExample('default'), dedicated: { enabled: true } })
    const on = AgentConfig.parse({ ...cfg, threads: [...cfg.threads, { ...base, session: 'dedicated' }] })
    const archived = { ...on, threads: on.threads.map((t) => (t.id === 'trip' ? { ...t, archived: true } : t)) }
    const cleared = clearArchivedSessions(archived)
    expect(cleared.threads.find((t) => t.id === 'trip')).not.toHaveProperty('session')
    expect(dedicatedPatchIssue(on, cleared)).toBeNull()
    expect(clearArchivedSessions(on)).toBe(on) // nothing to clear: the same object
  })

  it('a config.patch may carry the switch and dedicated.*: allowlisted, no step-up', () => {
    const cfg = AgentConfig.parse(loadExample('default'))
    const patch = {
      threads: [...cfg.threads, { ...base, session: 'dedicated', session_opts: { model: 'sonnet' } }],
      dedicated: { enabled: true, governor: { off: true } },
    }
    expect(checkConfigPatch(patch)).toEqual({ ok: true, touchesWorkEnabled: false })
    const next = AgentConfig.parse({ ...(applyMergePatch(cfg, patch) as object), rev: cfg.rev + 1 })
    expect(validateAgentConfig(next)).toEqual([])
    expect(dedicatedPatchIssue(cfg, next)).toBeNull()
    expect(threadSessionMode(next, 'trip')).toBe('dedicated')
    expect(dedicatedSettings(next).governor).toEqual({ five_hour: 80, weekly: 85, park_all: 95, off: true })
  })
})

describe('checkWorkerCwd (lexical half; the bridge adds realpath and exists)', () => {
  it('claudeDir: where ~/.claude really is, when it is a symlink', () => {
    const r = {
      home: '/Users/example',
      talosHome: '/Users/example/.config/talos/app',
      claudeDir: '/Users/example/dot/claude',
    }
    expect(checkWorkerCwd('/Users/example/dot/claude/projects', r)).not.toBeNull()
    expect(checkWorkerCwd('/Users/example/dot/claude', r)).not.toBeNull()
    expect(checkWorkerCwd('/Users/example/dot/claude-work', r)).toBeNull()
    expect(checkWorkerCwd('/Users/example/dot/claude', { ...r, claudeDir: null })).toBeNull()
  })

  const roots = { home: '/Users/example', talosHome: '/Users/example/.talos-app' }
  it('accepts folders under home', () => {
    expect(checkWorkerCwd('/Users/example/Projects/trip', roots)).toBeNull()
    expect(checkWorkerCwd('/Users/example/talos-agent/', roots)).toBeNull()
  })
  it.each([
    ['relative', 'Projects/trip'],
    ['home itself', '/Users/example'],
    ['outside home', '/tmp/x'],
    ['dot-dot escape', '/Users/example/../other'],
    ['dot segment', '/Users/example/./p'],
    ['~/.claude', '/Users/example/.claude'],
    ['inside ~/.claude', '/Users/example/.claude/projects/x'],
    ['the talos home', '/Users/example/.talos-app'],
    ['inside the talos home', '/Users/example/.talos-app/threads'],
    ['control character', '/Users/example/a\u0007b'],
  ])('refuses %s', (_label, cwd) => {
    expect(checkWorkerCwd(cwd, roots)).not.toBeNull()
  })
  it('refuses a sibling folder that only shares the prefix', () => {
    const r = { home: '/Users/example/me', talosHome: '/Users/example/me/.talos-app' }
    expect(checkWorkerCwd('/Users/example/meme/p', r)).not.toBeNull()
    expect(checkWorkerCwd('/Users/example/me/p', r)).toBeNull()
  })
})

describe('workers.json, the wake file, hub lines', () => {
  it('the fixture parses, defaults fill, and the shapes match the names', () => {
    const f = parseWorkersFile(fx('workers.json'))
    expect(f).not.toBeNull()
    expect(Object.keys(f?.threads ?? {})).toEqual(['trip', 'garden', 'taxes'])
    expect(f?.threads.trip?.tmux).toBe(workerTmuxName('trip'))
    expect(f?.threads.taxes?.error?.code).toBe('resume_missing')
    expect(workerSessionName('trip')).toBe('talos-trip')
  })

  it('a torn, wrong-version or junk file is null, never a partial read', () => {
    const text = fx('workers.json')
    expect(parseWorkersFile(text.slice(0, text.length / 2))).toBeNull()
    expect(parseWorkersFile(text.replace('"v": 1', '"v": 2'))).toBeNull()
    expect(parseWorkersFile('')).toBeNull()
    expect(parseWorkersFile('[]')).toBeNull()
    const bad = JSON.parse(text)
    bad.threads.trip.tmux = 't-trip; rm -rf ~'
    expect(parseWorkersFile(JSON.stringify(bad))).toBeNull()
    bad.threads.trip.tmux = 't-trip'
    bad.threads['Not A Thread'] = bad.threads.trip
    expect(parseWorkersFile(JSON.stringify(bad))).toBeNull()
  })

  it('supervisorFresh: under 15 s is fresh, at 15 s or no file is stale', () => {
    const f = WorkersFile.parse(JSON.parse(fx('workers.json')))
    const at = Date.parse(f.supervisor.heartbeat_at)
    expect(supervisorFresh(f, at + 1_000)).toBe(true)
    expect(supervisorFresh(f, at + SUPERVISOR_STALE_MS)).toBe(false)
    expect(supervisorFresh(null, at)).toBe(false)
  })

  it('the wake file carries message ids only', () => {
    const w = WakeFile.parse(JSON.parse(fx('wake.json')))
    expect(w.message_ids).toHaveLength(2)
    expect(WakeFile.safeParse({ ...w, message_ids: ['hello world'] }).success).toBe(false)
    expect(WakeFile.safeParse({ ...w, message_ids: [] }).success).toBe(false) // a pointer names a message
    expect(WakeFile.parse({ ...w, message_ids: [], action: 'park', reason: 'governor' }).message_ids).toEqual([])
    expect(WakeFile.safeParse({ ...w, text: 'content' }).success).toBe(true) // stripped, never kept
    expect(WakeFile.parse({ ...w, text: 'content' })).not.toHaveProperty('text')
  })

  it('hub lines parse by direction and refuse extras', () => {
    const lines = fx('hub-lines.jsonl')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.slice(0, 2).every((l) => HubWorkerLine.safeParse(l).success)).toBe(true)
    expect(lines.slice(2).every((l) => HubHubLine.safeParse(l).success)).toBe(true)
    expect(HubWorkerLine.safeParse(lines[2]).success).toBe(false) // a hub line is not a worker line
    expect(HubWorkerLine.safeParse({ ...lines[0], extra: 1 }).success).toBe(false)
    expect(HubWorkerLine.safeParse({ ...lines[0], pid: 0 }).success).toBe(false)
    expect(HubWorkerLine.safeParse({ ...lines[0], nonce: 'short' }).success).toBe(false)
  })
})

describe('worker constants', () => {
  it('the pointer is one fixed line that is not a slash command', () => {
    expect(WORKER_POINTER_TEXT).not.toMatch(/[\r\n]/)
    expect(WORKER_POINTER_TEXT.startsWith('/')).toBe(false)
    expect(WORKER_POINTER_TEXT).toContain('read_inbound')
  })

  it('worker tools: no thread lifecycle, inbox or voice; the schedule tools are there (they ask main); the locked set is a subset', () => {
    for (const n of ['create_thread', 'archive_thread', 'inbox_triage', 'inbox_raw', 'voice_progress'])
      expect(WORKER_BRIDGE_TOOLS as readonly string[]).not.toContain(n)
    // all four ask main's Schedules service over the hub; `schedule_propose` names a thread, so it is locked to the worker's own
    for (const n of SCHEDULE_BRIDGE_TOOLS) expect(WORKER_BRIDGE_TOOLS as readonly string[]).toContain(n)
    expect(WORKER_THREAD_LOCKED_TOOLS as readonly string[]).toContain('schedule_propose')
    for (const n of WORKER_THREAD_LOCKED_TOOLS) expect(WORKER_BRIDGE_TOOLS as readonly string[]).toContain(n)
    for (const n of WORKER_BRIDGE_TOOLS.filter(
      (x) => x !== 'read_inbound' && x !== 'handoff' && !(SCHEDULE_BRIDGE_TOOLS as readonly string[]).includes(x),
    ))
      expect(BRIDGE_TOOLS as readonly string[]).toContain(n)
  })

  it('the forbidden launch words include every channel and headless flag', () => {
    for (const a of ['--channels', '--dangerously-load-development-channels', '-p', '--bg'])
      expect(WORKER_FORBIDDEN_ARGS).toContain(a)
  })

  it('deadlines: cold resume waits longer than a warm pointer; the cap hold is 2 min', () => {
    expect(CLAIM_DEADLINE_MS).toBe(90_000)
    expect(CLAIM_DEADLINE_COLD_MS).toBeGreaterThan(CLAIM_DEADLINE_MS)
    expect(CAP_HOLD_MS).toBe(120_000)
  })
})

describe('frames, errors, meta', () => {
  it('workers.status survives values this build does not know: unknown state, failure, governor, unreadable fields', () => {
    const f = frames['workers.status'] as { status: Record<string, unknown> }
    const r = parseFrame({
      ...f,
      status: {
        ...f.status,
        threads: [{ thread_id: 'trip', state: 'compacting', error: 'disk_full', cwd: 'relative', parked_at: 'soon' }],
        governor: { state: 'throttled', resets_at: 'later' },
      },
    })
    expect(r.ok).toBe(true)
    if (!r.ok || r.frame.type !== 'workers.status') throw new Error('no frame')
    expect(r.frame.status.threads[0]).toMatchObject({ state: 'unknown', error: 'unknown' })
    expect(r.frame.status.governor.state).toBe('unknown')
  })

  it('a workers_status or thread_session_states ready cannot read is dropped alone, never the ready', () => {
    const ready = frames.ready as Record<string, unknown>
    const r = parseFrame(
      { ...ready, workers_status: { nope: 1 }, thread_session_states: 'x' },
      { direction: 'relay_to_app' },
    )
    expect(r.ok).toBe(true)
    if (r.ok && r.frame.type === 'ready') {
      expect(r.frame.workers_status).toBeUndefined()
      expect(r.frame.thread_session_states).toBeUndefined()
    }
  })

  it('thread.session.control is a signed owner frame app → relay → bridge, strict', () => {
    expect(FRAME_TYPES).toContain('thread.session.control')
    expect(OWNER_FRAME_TYPES as readonly string[]).toContain('thread.session.control')
    const f = frames['thread.session.control'] as Record<string, unknown>
    expect(parseFrame(f, { direction: 'app_to_relay' }).ok).toBe(true)
    expect(parseFrame(f, { direction: 'relay_to_bridge' }).ok).toBe(true)
    expect(isFrameFor('bridge_to_relay', f as { type: string })).toBe(false)
    expect(parseFrame({ ...f, extra: 1 }).ok).toBe(false)
    expect(parseFrame({ ...f, action: 'model' }).ok).toBe(false) // never /model in a worker (OPTION-C 6.4)
    for (const action of ['park', 'resume', 'restart', 'fresh']) expect(parseFrame({ ...f, action }).ok).toBe(true)
  })

  it('workers.status goes bridge → relay → app only', () => {
    const f = frames['workers.status'] as { type: string }
    expect(parseFrame(f, { direction: 'bridge_to_relay' }).ok).toBe(true)
    expect(parseFrame(f, { direction: 'relay_to_app' }).ok).toBe(true)
    expect(isFrameFor('app_to_relay', f)).toBe(false)
    expect(isFrameFor('relay_to_bridge', f)).toBe(false)
  })

  it('new error codes', () => {
    for (const c of [
      'worker_unavailable',
      'worker_cap',
      'usage_governor',
      'worker_folder_claimed',
      'needs_mac',
      'thread_session_refused',
    ])
      expect(ErrorCode.safeParse(c).success).toBe(true)
  })

  it('a fallback notification carries routed and reason; no new channel kind', () => {
    const meta = {
      chat_id: 'trip',
      thread_id: 'trip',
      thread_name: 'Trip planning',
      message_id: 'm_01JBF3V7Q8K2M4N6P8R0S2T401',
      ts: '2026-10-28T15:32:10.120Z',
      kind: 'text',
      trust: 'owner',
      routed: 'fallback',
      reason: 'worker_unavailable',
    }
    expect(ChannelMeta.safeParse(meta).success).toBe(true)
    expect(ChannelMeta.safeParse({ ...meta, routed: 'worker' }).success).toBe(false)
    expect(CHANNEL_KINDS).toHaveLength(15)
  })

  it('session.state may say which session it describes; absent = main', () => {
    const s = { session_id: 's', source: 'mod', at: '2026-10-28T15:32:10.120Z' }
    expect(SessionState.parse(s)).not.toHaveProperty('scope')
    expect(SessionState.parse({ ...s, scope: 'main' }).scope).toBe('main')
    expect(SessionState.parse({ ...s, scope: { thread_id: 'trip' } }).scope).toEqual({ thread_id: 'trip' })
    expect(SessionState.safeParse({ ...s, scope: { thread_id: 'trip', x: 1 } }).success).toBe(false)
    expect(SessionKind.safeParse('thread').success).toBe(true)
  })
})
