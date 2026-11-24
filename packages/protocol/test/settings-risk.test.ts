// m5/app-control: every settings row has a risk, the agent rule is on for the rows the owner listed, and thread operations
// (create, rename, topic, icon, alerts, own session, archive) are paths of config_propose with an old and a new value.
import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import {
  AGENT_ALWAYS_CARD_PHRASE,
  AGENT_SETTING_PATHS,
  AgentConfig,
  type AgentConfigT,
  agentConfigPatch,
  ConfigCardPayload,
  describeChange,
  eventInfo,
  resolveConfigChanges,
  riskOfChange,
  riskOfPath,
  SETTING_EVENT_KEYS,
  SETTINGS_TABLE,
  type SettingRow,
  THREAD_FIELD_RULES,
  undoText,
  verifyConfigPayload,
} from '../src/index.ts'
import * as tableModule from '../src/settings-table.ts'

const thread = (id: string, kind: 'fixed' | 'agent' | 'system', extra: Record<string, unknown> = {}) => ({
  id,
  name: id[0]?.toUpperCase() + id.slice(1),
  kind,
  order: 5,
  notify: 'all',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...extra,
})
const config = (extra: Record<string, unknown> = {}): AgentConfigT =>
  AgentConfig.parse({
    ...defaultConfig,
    threads: [
      ...defaultConfig.threads,
      thread('trip', 'agent', { name: 'Trip', topic: 'Flights and hotels' }),
      thread('garden', 'agent'),
    ],
    ...extra,
  })

const rows = Object.entries(SETTINGS_TABLE) as Array<[string, SettingRow]>
const RISKS = ['low', 'high', 'mac']

describe('every settings row has a risk', () => {
  it('low, high or mac, on every row and on every other table of rows this file exports', () => {
    for (const [path, r] of rows) expect(RISKS, path).toContain(r.risk)
    // a table of rows another file adds later (an export named *_ROWS) is held to the same rule
    for (const [name, value] of Object.entries(tableModule)) {
      if (!name.endsWith('_ROWS') || typeof value !== 'object' || value === null) continue
      for (const [k, r] of Object.entries(value as Record<string, { risk?: string }>))
        expect(RISKS, `${name}.${k}`).toContain(r.risk)
    }
  })

  it('the per-thread Mac-only option (ops_read) is mac, is listed in the registry view, and no agent can propose it', () => {
    expect(tableModule.THREAD_SESSION_OPT_ROWS.ops_read.risk).toBe('mac')
    expect(tableModule.HIGH_RISK_SETTING_PATHS).toContain('threads.session_opts.ops_read')
    for (const path of tableModule.HIGH_RISK_SETTING_PATHS) {
      expect(riskOfPath(path), path).toBeUndefined()
      const r = resolveConfigChanges([{ path, value: true }], config())
      expect(r.ok, path).toBe(false)
      expect(r.ok ? '' : r.error, path).toMatch(/can't be changed by you/)
    }
    for (const path of [
      'threads.trip.session_opts',
      'threads.trip.session_opts.ops_read',
      'threads.0.session_opts.ops_read',
    ])
      expect(resolveConfigChanges([{ path, value: true }], config()).ok, path).toBe(false)
  })

  it('a row without a risk does not typecheck', () => {
    // @ts-expect-error risk is required on every row
    const bare: SettingRow<'timezone'> = { phone: 'leaf', agent: false, default: undefined }
    // @ts-expect-error a row the agent may propose is low or high, never mac
    const macAgent: SettingRow<'timezone'> = { ...SETTINGS_TABLE.timezone, risk: 'mac' }
    expect([bare, macAgent]).toHaveLength(2)
  })

  it('mac rows are the ones the agent must never set; none of them is an agent row', () => {
    const mac = rows.filter(([, r]) => r.risk === 'mac').map(([p]) => p)
    expect(mac).toEqual(['permission_relay', 'trust_mode', 'bug_webhook_url', 'bug_webhook_host', 'peers'])
    for (const [path, r] of rows) if (r.risk === 'mac') expect(r.agent, path).toBe(false)
  })

  it('work systems are high at most; the agent may set only their words (the label and the note), never what is connected', () => {
    for (const [path, r] of rows.filter(([p]) => p.startsWith('work.'))) {
      expect(r.risk, path).not.toBe('mac')
      expect(r.agent, path).toBe(path === 'work.label' || path === 'work.ask_note')
    }
    expect(SETTINGS_TABLE['work.enabled'].risk).toBe('high')
    expect(SETTINGS_TABLE['work.retention'].risk).toBe('high')
  })

  it('the agent rows are the ones the owner listed (2026-11-14: all but who he is and what is connected), and these are high', () => {
    expect([...AGENT_SETTING_PATHS]).toEqual([
      'agent.name',
      'owner.display_name',
      'threads',
      'default_thread',
      'timezone',
      'quiet_window',
      'notifications.master',
      'notifications.show_thread_names',
      'voice_notes.reply_with_voice',
      'voice_notes.driving_until',
      'work.label',
      'work.ask_note',
      'session_models',
      'memory_browser',
      'media_keep_days',
      'always_allow',
      'dev.thread_fence',
      'dev.note_lookup',
      'os_sandbox',
      'settings_lock',
      'dedicated',
      'theme',
    ])
    const high = rows.filter(([, r]) => r.agent && r.risk === 'high').map(([p]) => p)
    expect(high).toEqual([
      'default_thread',
      'timezone',
      'notifications.master',
      'notifications.show_thread_names',
      'always_allow',
      'dev.thread_fence',
      'os_sandbox',
      'dedicated',
      'theme',
    ])
  })

  it('the thread fields carry a risk too: archive, the own-session switch and the parent are high, the rest low', () => {
    const risks = Object.fromEntries(Object.entries(THREAD_FIELD_RULES).map(([k, v]) => [k, v.risk]))
    expect(risks).toEqual({
      name: 'low',
      topic: 'low',
      icon: 'low',
      notify: 'low',
      session: 'high',
      archived: 'high',
      parent: 'high',
      idle_park_min: 'low',
      color: 'low',
      effort: 'low',
      model: 'high',
      mcp_allow: 'high',
      'session_opts.cwd': 'high',
    })
  })

  it('riskOfPath reads the table: theme high, a rename low, an archive high, permission_relay and an unknown path none', () => {
    expect(riskOfPath('theme')).toBe('high')
    expect(riskOfPath('timezone')).toBe('high')
    expect(riskOfPath('owner.display_name')).toBe('low')
    expect(riskOfPath('threads.trip.name')).toBe('low')
    expect(riskOfPath('threads.trip.archived')).toBe('high')
    expect(riskOfPath('threads.trip')).toBe('low') // a new thread
    expect(riskOfPath('permission_relay')).toBeUndefined()
    expect(riskOfPath('trust_mode')).toBeUndefined()
    expect(riskOfPath('threads')).toBeUndefined()
    expect(riskOfPath('nope')).toBeUndefined()
  })
})

describe('thread operations as proposals', () => {
  const cfg = config()
  const ok = (raw: unknown, c = cfg, opts?: { thread?: string }) => {
    const r = resolveConfigChanges(raw, c, opts)
    if (!r.ok) throw new Error(r.error)
    return r.changes
  }
  const refused = (raw: unknown, c = cfg, opts?: { thread?: string }) => {
    const r = resolveConfigChanges(raw, c, opts)
    expect(r.ok, JSON.stringify(raw)).toBe(false)
    return r.ok ? '' : r.error
  }

  it('rename and retopic carry the old and the new value, and read the old one from the config', () => {
    expect(ok([{ path: 'threads.trip.name', value: 'Travel' }])).toEqual([
      { path: 'threads.trip.name', old: 'Trip', new: 'Travel' },
    ])
    expect(ok([{ path: 'threads.trip.topic', value: 'Trips and visas' }])[0]?.old).toBe('Flights and hotels')
    expect(ok([{ path: 'threads.garden.topic', value: 'Seeds' }])[0]?.old).toBe('') // none yet
    expect(ok([{ path: 'threads.trip.topic', value: '' }])[0]?.new).toBe('') // empty clears it
    expect(ok([{ path: 'threads.trip.notify', value: 'needs_you' }])[0]?.old).toBe('all')
    expect(ok([{ path: 'threads.trip.session', value: 'dedicated' }])[0]?.old).toBe('shared')
  })

  it('a value that is already set, a bad value and an unknown field are refused', () => {
    expect(refused([{ path: 'threads.trip.name', value: 'Trip' }])).toMatch(/already that value/)
    expect(refused([{ path: 'threads.trip.name', value: '' }])).toBeTruthy()
    expect(refused([{ path: 'threads.trip.name', value: 'x'.repeat(41) }])).toBeTruthy()
    expect(refused([{ path: 'threads.trip.notify', value: 'loud' }])).toBeTruthy()
    for (const field of [
      'kind',
      'order',
      'session_opts',
      'created_at',
      'id',
      'voice_context',
      'session_opts.model',
      'session_opts.cwd.x',
    ])
      expect(refused([{ path: `threads.trip.${field}`, value: 'x' }]), field).toMatch(/not a setting you may propose/)
    expect(refused([{ path: 'threads', value: [] }])).toMatch(/not a setting you may propose/)
  })

  it('an unknown, system or main-front-door thread is refused where it cannot be changed', () => {
    expect(refused([{ path: 'threads.nope.name', value: 'X' }])).toMatch(/Unknown thread/)
    expect(refused([{ path: 'threads.inbox.name', value: 'X' }])).toMatch(/system thread/)
    expect(refused([{ path: 'threads.general.session', value: 'dedicated' }])).toBeTruthy() // main's front door
  })

  it('archive: agent threads only, never the default thread; the old value is "not archived"', () => {
    expect(ok([{ path: 'threads.trip.archived', value: true }])[0]).toEqual({
      path: 'threads.trip.archived',
      old: false,
      new: true,
    })
    expect(refused([{ path: 'threads.general.archived', value: true }])).toMatch(/agent thread|default/)
    const asDefault = config({ default_thread: 'trip' })
    expect(refused([{ path: 'threads.trip.archived', value: true }], asDefault)).toMatch(/default thread/)
  })

  it('create: a new id, a name, an optional topic and icon; old is null', () => {
    const [c] = ok([{ path: 'threads.errands', value: { name: 'Errands', topic: 'Bills and parcels', icon: 'bag' } }])
    expect(c).toEqual({
      path: 'threads.errands',
      old: null,
      new: { name: 'Errands', topic: 'Bills and parcels', icon: 'bag' },
    })
    expect(refused([{ path: 'threads.trip', value: { name: 'Again' } }])).toMatch(/already/)
    expect(refused([{ path: 'threads.talos__setup', value: { name: 'Setup' } }])).toMatch(/reserved/)
    expect(refused([{ path: 'threads.constructor', value: { name: 'Setup' } }])).toBeTruthy()
    expect(refused([{ path: 'threads.all', value: { name: 'Everything' } }])).toBeTruthy()
    expect(refused([{ path: 'threads.Bad_Id', value: { name: 'X' } }])).toBeTruthy()
    expect(refused([{ path: 'threads.errands', value: { name: '' } }])).toBeTruthy()
    expect(refused([{ path: 'threads.errands', value: { name: 'X', kind: 'fixed' } }])).toBeTruthy() // strict: no kind, no folder
  })

  it('past 20 agent threads without trust mode: a warning, not a refusal (Pantheon 2026-11-15); 40 in all still refuses', () => {
    const many = (n: number) =>
      config({
        threads: [
          ...defaultConfig.threads,
          ...Array.from({ length: n }, (_, i) => thread(`t${i}`, 'agent', { name: `T${i}` })),
        ],
      })
    const r = resolveConfigChanges([{ path: 'threads.more', value: { name: 'More' } }], many(20))
    expect(r.ok && r.changes).toHaveLength(1)
    expect(r.ok && r.warnings).toEqual([
      'this makes 21 active agent threads, more than 20; check with the owner that he wants them all, or archive one',
    ])
    const nineteen = resolveConfigChanges([{ path: 'threads.more', value: { name: 'More' } }], many(19))
    expect(nineteen.ok && nineteen.warnings).toBeUndefined()
    const trust = resolveConfigChanges([{ path: 'threads.more', value: { name: 'More' } }], {
      ...many(20),
      trust_mode: true,
    })
    expect(trust.ok && trust.warnings).toBeUndefined()
    expect(refused([{ path: 'threads.more', value: { name: 'More' } }], { ...many(38), trust_mode: true })).toMatch(
      /40/,
    )
  })

  it('a thread session may touch its own thread only', () => {
    expect(ok([{ path: 'threads.trip.name', value: 'Travel' }], cfg, { thread: 'trip' })).toHaveLength(1)
    // never its own archiving, session, folder, model or MCP list (the thread-setup tests cover the rest)
    expect(refused([{ path: 'threads.trip.archived', value: true }], cfg, { thread: 'trip' })).toMatch(
      /thread's archived/,
    )
    expect(refused([{ path: 'threads.garden.name', value: 'Plants' }], cfg, { thread: 'trip' })).toMatch(/own thread/)
    expect(
      refused(
        [
          { path: 'threads.trip.name', value: 'Travel' },
          { path: 'threads.garden.name', value: 'Plants' },
        ],
        cfg,
        { thread: 'trip' },
      ),
    ).toMatch(/own thread/)
    expect(refused([{ path: 'timezone', value: 'Europe/Paris' }], cfg, { thread: 'trip' })).toMatch(/own thread/)
    expect(refused([{ path: 'threads.errands', value: { name: 'Errands' } }], cfg, { thread: 'trip' })).toMatch(
      /under it/,
    )
  })

  it('the other newly listed settings carry their value rules', () => {
    expect(ok([{ path: 'default_thread', value: 'trip' }])[0]?.old).toBe('general')
    expect(refused([{ path: 'default_thread', value: 'nope' }])).toMatch(/Unknown thread|not a thread/)
    expect(refused([{ path: 'default_thread', value: 'inbox' }])).toBeTruthy() // the system thread
    expect(ok([{ path: 'notifications.master', value: false }])[0]?.old).toBe(true)
    expect(ok([{ path: 'notifications.show_thread_names', value: 'all' }])[0]?.old).toBe('fixed_only')
    expect(refused([{ path: 'notifications.show_thread_names', value: 'some' }])).toBeTruthy()
    expect(ok([{ path: 'session_models', value: ['default', 'opus'] }])[0]?.old).toEqual([
      'default',
      'opus',
      'sonnet',
      'haiku',
    ])
    expect(refused([{ path: 'session_models', value: [] }])).toBeTruthy()
    expect(refused([{ path: 'session_models', value: ['opus; rm -rf'] }])).toBeTruthy()
    // shown on until written off (threadSessionsAllowed): the agent turning it off is the change
    expect(ok([{ path: 'dedicated', value: false }])[0]).toEqual({ path: 'dedicated', old: true, new: false })
    expect(ok([{ path: 'voice_notes.driving_until', value: '2026-11-09T18:00:00.000Z' }])[0]?.old).toBeNull()
    for (const p of ['permission_relay', 'trust_mode', 'work.enabled', 'work.retention', 'bug_webhook_url'])
      expect(refused([{ path: p, value: true }]), p).toMatch(/can't be changed by you/)
  })

  it('the patch for thread changes carries the whole threads list, so no other thread is lost', () => {
    const changes = ok([
      { path: 'threads.trip.name', value: 'Travel' },
      { path: 'threads.trip.topic', value: '' },
      { path: 'threads.garden.archived', value: true },
    ])
    const patch = agentConfigPatch(changes, cfg, '2026-11-09T10:00:00.000Z') as {
      threads: Array<Record<string, unknown>>
    }
    expect(patch.threads.map((t) => t.id)).toEqual(['general', 'inbox', 'trip', 'garden'])
    const trip = patch.threads.find((t) => t.id === 'trip')
    expect(trip?.name).toBe('Travel')
    expect(trip?.topic).toBeNull() // null clears the key in a threads patch
    expect(patch.threads.find((t) => t.id === 'garden')?.archived).toBe(true)
    expect(patch.threads.find((t) => t.id === 'general')?.name).toBe('General')
  })

  it('a created thread is an agent thread at the end of the list, dated by the clock the caller gives', () => {
    const changes = ok([{ path: 'threads.errands', value: { name: 'Errands', topic: 'Bills' } }])
    const patch = agentConfigPatch(changes, cfg, '2026-11-09T10:00:00.000Z') as {
      threads: Array<Record<string, unknown>>
    }
    const made = patch.threads.at(-1)
    expect(made).toMatchObject({
      id: 'errands',
      name: 'Errands',
      topic: 'Bills',
      kind: 'agent',
      notify: 'all',
      archived: false,
      created_at: '2026-11-09T10:00:00.000Z',
    })
    expect(made?.order).toBeGreaterThan(Math.max(...cfg.threads.map((t) => t.order)))
  })

  it('dedicated writes only the master switch, so the limits stay', () => {
    const changes = ok([{ path: 'dedicated', value: true }], config({ dedicated: { enabled: false, max_live: 2 } }))
    expect(agentConfigPatch(changes, cfg, '2026-11-09T10:00:00.000Z')).toEqual({ dedicated: { enabled: true } })
  })

  it('the bound payload is checked again at apply: thread paths verify, stale values and forged paths do not', () => {
    const changes = ok([{ path: 'threads.trip.name', value: 'Travel' }])
    const payload = { v: 1, base_rev: 0, reason: 'x', changes }
    expect(ConfigCardPayload.safeParse(payload).success).toBe(true)
    const v = verifyConfigPayload(payload, cfg)
    expect(v.ok).toBe(true)
    // renamed elsewhere since the card was drawn
    const moved = config({ threads: cfg.threads.map((t) => (t.id === 'trip' ? { ...t, name: 'Holiday' } : t)) })
    const stale = verifyConfigPayload(payload, moved)
    expect(stale.ok).toBe(false)
    expect(stale.ok ? '' : stale.error).toMatch(/changed since this card was drawn/)
    for (const path of [
      'threads',
      'threads.trip.kind',
      'threads.trip.session_opts',
      'permission_relay',
      'trust_mode',
    ]) {
      const forged = { ...payload, changes: [{ path, old: 'x', new: 'y' }] }
      expect(ConfigCardPayload.safeParse(forged).success && verifyConfigPayload(forged, cfg).ok, path).toBe(false)
    }
  })

  it('a card line names the thread, the old and the new value', () => {
    const [c] = ok([{ path: 'threads.trip.name', value: 'Travel' }])
    expect(describeChange(c as never)).toBe('Thread trip name: Trip → Travel')
    const [n] = ok([{ path: 'threads.errands', value: { name: 'Errands' } }])
    expect(describeChange(n as never)).toContain('Errands')
    expect(describeChange(n as never)).toContain('errands')
  })
})

describe('every applied change names how to revert', () => {
  const cfg = config()
  it('lists the old value of each change, and archiving for a created thread', () => {
    const r = resolveConfigChanges(
      [
        { path: 'threads.trip.name', value: 'Travel' },
        { path: 'timezone', value: 'Europe/Paris' },
        { path: 'quiet_window', value: { start: '21:00', end: '07:00' } },
        { path: 'threads.errands', value: { name: 'Errands' } },
      ],
      cfg,
    )
    if (!r.ok) throw new Error(r.error)
    const u = undoText(r.changes)
    expect(u).toMatch(/^To undo: /)
    expect(u).toContain('Thread trip name back to Trip')
    expect(u).toContain('Timezone back to UTC')
    expect(u).toContain('Quiet hours back to off')
    expect(u).toMatch(/archive thread errands/)
  })
})

describe('follow-ups from the review of ffd0e721', () => {
  const cfg = config()
  const ok = (raw: unknown, c = cfg) => {
    const r = resolveConfigChanges(raw, c)
    if (!r.ok) throw new Error(r.error)
    return r.changes
  }
  const refused = (raw: unknown, c = cfg) => {
    const r = resolveConfigChanges(raw, c)
    expect(r.ok, JSON.stringify(raw)).toBe(false)
    return r.ok ? '' : r.error
  }
  const agents = (n: number, extra: Record<string, unknown> = {}) =>
    config({
      threads: [
        ...defaultConfig.threads,
        ...Array.from({ length: n }, (_, i) => thread(`t${i}`, 'agent', { name: `T${i}` })),
      ],
      ...extra,
    })

  it('1. alerts off, or any alerts change on the default thread, is high; the rest stays low', () => {
    const risk = (path: string, value: unknown, c = cfg) => riskOfChange({ path, new: value }, c)
    expect(risk('threads.trip.notify', 'off')).toBe('high')
    expect(risk('threads.general.notify', 'needs_you')).toBe('high') // the default thread
    expect(risk('threads.trip.notify', 'needs_you')).toBe('low')
    expect(risk('threads.trip.notify', 'all')).toBe('low')
    expect(risk('threads.trip.notify', 'needs_you', config({ default_thread: 'trip' }))).toBe('high')
    expect(risk('threads.trip.name', 'Travel')).toBe('low')
    expect(risk('threads.trip.archived', true)).toBe('high')
    expect(risk('permission_relay', true)).toBeUndefined()
    // the static risk of the path is the base one; the words the agent is told name the high cases
    expect(riskOfPath('threads.trip.notify')).toBe('low')
    expect(AGENT_ALWAYS_CARD_PHRASE).toMatch(/alerts off/)
  })

  it('1b. setting or moving quiet hours is high, and so is the timezone; turning quiet hours off stays low', () => {
    const risk = (path: string, value: unknown, c = cfg) => riskOfChange({ path, new: value }, c)
    const quiet = config({ quiet_window: { start: '22:00', end: '07:00' } })
    expect(risk('quiet_window', { start: '00:00', end: '23:59' })).toBe('high')
    expect(risk('quiet_window', { start: '23:00', end: '06:00' }, quiet)).toBe('high')
    expect(risk('quiet_window', null, quiet)).toBe('low')
    // a zone moved first would make a later quiet-hours card land at other hours: the timezone is always a card
    expect(risk('timezone', 'Asia/Tokyo')).toBe('high')
    expect(risk('timezone', 'Asia/Tokyo', quiet)).toBe('high')
    expect(riskOfPath('quiet_window')).toBe('low')
    expect(AGENT_ALWAYS_CARD_PHRASE).toMatch(/setting quiet hours/)
    expect(AGENT_ALWAYS_CARD_PHRASE).toMatch(/timezone/)
  })

  it('2a. a new thread shows its icon, and its topic', () => {
    const [n] = ok([{ path: 'threads.errands', value: { name: 'Errands', topic: 'Bills', icon: 'bag' } }])
    const line = describeChange(n as never)
    expect(line).toContain('Errands')
    expect(line).toContain('Bills')
    expect(line).toContain('bag')
  })

  it('2b. archiving a dedicated thread names the session it switches off, on the card and in the undo', () => {
    const c = config({
      dedicated: { enabled: true },
      threads: [...defaultConfig.threads, thread('trip', 'agent', { session: 'dedicated' })],
    })
    const changes = ok([{ path: 'threads.trip.archived', value: true }], c)
    expect(changes).toEqual([
      { path: 'threads.trip.archived', old: false, new: true },
      { path: 'threads.trip.session', old: 'dedicated', new: 'shared' },
    ])
    expect(undoText(changes)).toContain('Thread trip own session back to dedicated')
    // a shared thread gets no extra line, and the extra line counts toward the six
    expect(ok([{ path: 'threads.garden.archived', value: true }])).toHaveLength(1)
    const agentsDedicated = config({
      dedicated: { enabled: true },
      threads: [
        ...defaultConfig.threads,
        ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => thread(id, 'agent', { session: 'dedicated' })),
      ],
    })
    expect(
      refused(
        ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ path: `threads.${id}.archived`, value: true })),
        agentsDedicated,
      ),
    ).toMatch(/At most 6/)
    // it applies: the patch writes both, and the apply-time check accepts the card as drawn
    const payload = { v: 1, base_rev: 0, reason: 'x', changes }
    const v = verifyConfigPayload(payload, c)
    expect(v.ok).toBe(true)
    const patch = v.ok ? (v.patch as { threads: Array<Record<string, unknown>> }) : { threads: [] }
    expect(patch.threads.find((t) => t.id === 'trip')).toMatchObject({ archived: true, session: 'shared' })
  })

  it('3. the 20-thread warning counts the batch itself, and an unarchive', () => {
    const warned = (raw: unknown, c: AgentConfigT) => {
      const r = resolveConfigChanges(raw, c)
      if (!r.ok) throw new Error(r.error)
      return r.warnings?.join(' ') ?? ''
    }
    expect(
      warned(
        [
          { path: 'threads.n1', value: { name: 'N1' } },
          { path: 'threads.n2', value: { name: 'N2' } },
        ],
        agents(19),
      ),
    ).toMatch(/21 active agent threads/)
    expect(warned([{ path: 'threads.n1', value: { name: 'N1' } }], agents(19))).toBe('')
    // an archived agent thread brought back is one more active agent thread
    const full = config({
      threads: [
        ...defaultConfig.threads,
        ...Array.from({ length: 20 }, (_, i) => thread(`t${i}`, 'agent', { name: `T${i}` })),
        thread('old', 'agent', { name: 'Old', archived: true }),
      ],
    })
    expect(warned([{ path: 'threads.old.archived', value: false }], full)).toMatch(/21 active agent threads/)
    const almost = config({
      threads: [
        ...defaultConfig.threads,
        ...Array.from({ length: 19 }, (_, i) => thread(`t${i}`, 'agent', { name: `T${i}` })),
        thread('old', 'agent', { name: 'Old', archived: true }),
      ],
    })
    expect(warned([{ path: 'threads.old.archived', value: false }], almost)).toBe('')
    // trust mode lifts the 20, and the 40 in all still holds for a batch
    const trustFull = { ...agents(37), trust_mode: true } as AgentConfigT // 2 + 37 = 39
    expect(
      refused(
        [
          { path: 'threads.n1', value: { name: 'N1' } },
          { path: 'threads.n2', value: { name: 'N2' } },
        ],
        trustFull,
      ),
    ).toMatch(/40/)
  })

  it('3b. at apply time the 20 no longer refuses (a warning only went to the agent); the 40 in all still does', () => {
    const payload = {
      v: 1,
      base_rev: 0,
      reason: 'x',
      changes: [
        { path: 'threads.n1', old: null, new: { name: 'N1' } },
        { path: 'threads.n2', old: null, new: { name: 'N2' } },
      ],
    }
    expect(verifyConfigPayload(payload, agents(19)).ok).toBe(true)
    expect(verifyConfigPayload(payload, agents(18)).ok).toBe(true)
    expect(verifyConfigPayload(payload, agents(37)).ok).toBe(false) // 2 fixed + 37 + 2 new is past 40
  })

  it('6. unarchive is a named event, and the setting events name only keys that are emitted', () => {
    expect(eventInfo('thread.unarchived')).toBeDefined()
    expect(SETTING_EVENT_KEYS).not.toContain('threads.name')
    expect(SETTING_EVENT_KEYS).not.toContain('threads.archived')
    for (const k of ['threads.topic', 'threads.icon', 'threads.notify', 'threads.session'])
      expect(SETTING_EVENT_KEYS).toContain(k)
  })
})
