// Subagent panel protocol (docs/SUBAGENTS.md, WP-A0): strict outbound rows and snapshots, the 64 KB frame cap and the
// bridge's trim order, the lenient engine parser, the agent_stop control, and the session.agents frame's place in the
// frame tables (not durable, not consumable, bridge -> relay -> app only).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AGENT_LIMITS,
  AgentRow,
  type AgentRowT,
  AgentsSnapshot,
  type AgentsSnapshotT,
  agentActivityForTool,
  agentCounts,
  agentRowsFromEngine,
  agentsForSession,
  agentsSnapshotBytes,
  agentsSnapshotFromEngine,
  CappedAgentsSnapshot,
  CONSUMABLE_FRAME_TYPES,
  canStopAgent,
  checkSessionControl,
  DIRECTION_TYPES,
  DURABLE_FRAME_TYPES,
  ErrorCode,
  emptyAgentsSnapshot,
  ModControl,
  ModSyncRequest,
  markAgentsUnknown,
  OWNER_FRAME_TYPES,
  oneLine,
  parseFrame,
  ReadyFrame,
  SESSION_BRIDGE_FRAME_TYPES,
  SESSION_CAPABILITIES_V1,
  SESSION_CONSUMABLE_FRAME_TYPES,
  SESSION_DURABLE_FRAME_TYPES,
  SessionState,
  type SessionStateT,
  sameAgentsSnapshot,
  trimAgentsSnapshot,
  wireSessionState,
} from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const fixtures = loadFixtures()
const AT = '2026-10-30T12:00:00.000Z'
const NOW = Date.parse(AT)
const iso = (ms: number) => new Date(ms).toISOString()
const env = (type: string) => ({ v: 1, type, id: '01JBF3V7Q8K2M4N6P8R0S2T4C0', ts: AT })
const owner = { device_id: 'd_aaaaaaaaaaaaaaaaaaaa', osig: 'A'.repeat(86) }
const LS = String.fromCharCode(0x2028)
const RLO = String.fromCharCode(0x202e)

const row = (over: Partial<AgentRowT> = {}): AgentRowT => ({
  id: 'a1',
  kind: 'subagent',
  type: 'Explore',
  title: 'research mods API',
  status: 'running',
  background: true,
  stoppable: true,
  recent: [],
  ...over,
})
const snap = (rows: AgentRowT[], over: Partial<AgentsSnapshotT> = {}): AgentsSnapshotT => ({
  session_id: 'sess_1',
  source: 'mod',
  can_stop: true,
  rows,
  at: AT,
  ...over,
})
const fullRecent = (n: number = AGENT_LIMITS.recent, ch = 'y') =>
  Array.from({ length: n }, (_, i) => ({ at: iso(NOW - 60_000 + i), text: ch.repeat(AGENT_LIMITS.text) }))
/** The schema's worst case for plain ASCII: 50 rows, each with 8 recent lines of 160 characters. */
const worstCase = () =>
  snap(
    Array.from({ length: AGENT_LIMITS.rows }, (_, i) =>
      row({
        id: `a${i}`,
        title: 'x'.repeat(AGENT_LIMITS.text),
        activity: 'z'.repeat(AGENT_LIMITS.text),
        status: i % 2 ? 'completed' : 'running',
        started_at: iso(NOW - (100 - i) * 1000),
        ...(i % 2 ? { ended_at: iso(NOW - (50 - i) * 1000), stoppable: false } : {}),
        recent: fullRecent(),
      }),
    ),
  )

describe('models (outbound: strict)', () => {
  it('the fixture parses: a running Explore with the tee summary, an idle teammate, a shell, a completed row', () => {
    const f = fixtures['session.agents'] as Record<string, unknown>
    const r = parseFrame(f, { direction: 'bridge_to_relay' })
    expect(r.ok).toBe(true)
    const a = f.agents as AgentsSnapshotT
    expect(a.source).toBe('mod+tee')
    expect(a.rows.map((x) => `${x.kind}:${x.status}`)).toEqual([
      'subagent:running',
      'teammate:idle',
      'shell:running',
      'subagent:completed',
    ])
    expect(a.rows[0]).toMatchObject({ activity_source: 'summary', type: 'Explore' })
    expect(AgentsSnapshot.parse(a)).toEqual(a) // round trip: nothing added, nothing lost
    const ready = ReadyFrame.safeParse(fixtures.ready)
    expect(ready.success && ready.data.session_agents?.rows).toHaveLength(4)
  })

  it('defaults fill: background false, stoppable false, recent []', () => {
    const r = AgentRow.parse({ id: 'a', kind: 'shell', type: 'shell', title: 't', status: 'running' })
    expect(r).toMatchObject({ background: false, stoppable: false, recent: [] })
  })

  it('rejects unknown fields, kinds and statuses', () => {
    expect(AgentRow.safeParse({ ...row(), extra: 1 }).success).toBe(false)
    expect(AgentRow.safeParse({ ...row(), kind: 'daemon' }).success).toBe(false)
    expect(AgentRow.safeParse({ ...row(), status: 'zombie' }).success).toBe(false)
    expect(AgentsSnapshot.safeParse({ ...snap([]), extra: 1 }).success).toBe(false)
    expect(AgentsSnapshot.safeParse({ ...snap([]), source: 'hooks' }).success).toBe(false)
  })

  it('rejects over-long strings: title/activity/recent 160, type/name 64, id/parent 80, model 80, session 64', () => {
    const long = (n: number) => 'x'.repeat(n)
    expect(AgentRow.safeParse(row({ title: long(160) })).success).toBe(true)
    expect(AgentRow.safeParse(row({ title: long(161) })).success).toBe(false)
    expect(AgentRow.safeParse(row({ activity: long(161) })).success).toBe(false)
    expect(AgentRow.safeParse(row({ type: long(65) })).success).toBe(false)
    expect(AgentRow.safeParse(row({ name: long(65) })).success).toBe(false)
    expect(AgentRow.safeParse(row({ id: long(81) })).success).toBe(false)
    expect(AgentRow.safeParse(row({ id: '' })).success).toBe(false)
    expect(AgentRow.safeParse(row({ parent_id: long(81) })).success).toBe(false)
    expect(AgentRow.safeParse(row({ model: long(81) })).success).toBe(false)
    expect(AgentRow.safeParse(row({ recent: [{ at: AT, text: long(161) }] })).success).toBe(false)
    expect(AgentsSnapshot.safeParse(snap([], { session_id: long(65) })).success).toBe(false)
  })

  it('rejects control characters, line separators and bidi overrides in one-line text', () => {
    for (const bad of ['a\nb', 'a\tb', `a${LS}b`, `a${RLO}b`, 'a\u0007b'])
      expect(AgentRow.safeParse(row({ title: bad })).success, JSON.stringify(bad)).toBe(false)
    expect(AgentRow.safeParse(row({ recent: [{ at: AT, text: 'a\nb' }] })).success).toBe(false)
  })

  it('rejects more than 50 rows, more than 8 recent lines, negative or fractional tokens', () => {
    const rows = Array.from({ length: AGENT_LIMITS.rows + 1 }, (_, i) => row({ id: `a${i}` }))
    expect(AgentsSnapshot.safeParse(snap(rows.slice(0, 50))).success).toBe(true)
    expect(AgentsSnapshot.safeParse(snap(rows)).success).toBe(false)
    expect(AgentRow.safeParse(row({ recent: fullRecent(8) })).success).toBe(true)
    expect(AgentRow.safeParse(row({ recent: fullRecent(9) })).success).toBe(false)
    expect(AgentRow.safeParse(row({ tokens: -1 })).success).toBe(false)
    expect(AgentRow.safeParse(row({ tokens: 1.5 })).success).toBe(false)
  })
})

describe('the 64 KB frame cap', () => {
  it('the schema caps allow a snapshot over the frame cap, so the trim is a real path', () => {
    const w = worstCase()
    expect(AgentsSnapshot.safeParse(w).success).toBe(true)
    expect(agentsSnapshotBytes(w)).toBeGreaterThan(AGENT_LIMITS.frameBytes)
  })

  it('session.agents and ready.session_agents refuse an untrimmed snapshot; ModSyncRequest takes it (the bridge trims)', () => {
    const w = worstCase()
    expect(CappedAgentsSnapshot.safeParse(w).success).toBe(false)
    const f = parseFrame({ ...env('session.agents'), agents: w })
    expect(f.ok).toBe(false)
    expect(ReadyFrame.shape.session_agents.safeParse(w).success).toBe(false)
    expect(ModSyncRequest.safeParse({ mod_key: 'k'.repeat(43), agents: w }).success).toBe(true)
    const t = trimAgentsSnapshot(w)
    expect(parseFrame({ ...env('session.agents'), agents: t.snapshot }).ok).toBe(true)
  })

  it('a snapshot under the cap is returned as is', () => {
    const s = snap([row({ recent: fullRecent(2) })])
    const t = trimAgentsSnapshot(s)
    expect(t.trimmed).toBe(false)
    expect(t.snapshot).toBe(s)
    expect(t.bytes).toBe(agentsSnapshotBytes(s))
  })

  it('the worst case fits after the trim with every row kept; ended rows lose recent before any live row does', () => {
    const w = worstCase()
    const before = structuredClone(w)
    const t = trimAgentsSnapshot(w)
    expect(t.trimmed).toBe(true)
    expect(t.bytes).toBeLessThanOrEqual(AGENT_LIMITS.frameBytes)
    expect(agentsSnapshotBytes(t.snapshot)).toBe(t.bytes)
    expect(w).toEqual(before) // input untouched
    expect(t.snapshot.rows).toHaveLength(AGENT_LIMITS.rows) // nothing dropped
    const ended = t.snapshot.rows.filter((r) => r.status === 'completed')
    const live = t.snapshot.rows.filter((r) => r.status === 'running')
    expect(ended.every((r) => r.recent.length === 0)).toBe(true)
    const emptied = live.map((r) => r.recent.length === 0)
    expect(emptied.some(Boolean)).toBe(true) // this case needs step 2 too
    expect(emptied.slice(emptied.indexOf(false)).some(Boolean)).toBe(false) // and takes the oldest live rows first
  })

  it('trim order 1: recent on ended rows, oldest ended first, stopping as soon as it fits', () => {
    const rows = [
      row({ id: 'live', started_at: iso(NOW - 99_000), recent: fullRecent(3) }),
      row({ id: 'd-new', status: 'completed', ended_at: iso(NOW - 1000), recent: fullRecent(3) }),
      row({ id: 'd-old', status: 'killed', ended_at: iso(NOW - 9000), recent: fullRecent(3) }),
      row({ id: 'd-mid', status: 'failed', ended_at: iso(NOW - 5000), recent: fullRecent(3) }),
    ]
    const s = snap(rows)
    const target = snap(rows.map((r) => (r.id === 'd-old' || r.id === 'd-mid' ? { ...r, recent: [] } : r)))
    const t = trimAgentsSnapshot(s, agentsSnapshotBytes(target))
    expect(t.snapshot).toEqual(target)
  })

  it('trim order 2: then recent on running rows, oldest started first', () => {
    // only live rows, so step 1 has nothing to do
    const s = snap(
      Array.from({ length: AGENT_LIMITS.rows }, (_, i) =>
        row({
          id: `a${i}`,
          title: 'x'.repeat(160),
          started_at: iso(NOW - (100 - i) * 1000),
          recent: fullRecent(),
        }),
      ),
    )
    const t = trimAgentsSnapshot(s)
    expect(t.bytes).toBeLessThanOrEqual(AGENT_LIMITS.frameBytes)
    expect(t.snapshot.rows).toHaveLength(AGENT_LIMITS.rows)
    const emptied = t.snapshot.rows.map((r) => r.recent.length === 0)
    const firstKept = emptied.indexOf(false)
    expect(firstKept).toBeGreaterThan(0)
    expect(emptied.slice(0, firstKept).every(Boolean)).toBe(true) // a prefix: the oldest
    expect(emptied.slice(firstKept).some(Boolean)).toBe(false)
  })

  it('trim order 3: then ended rows are dropped, oldest first; live rows stay', () => {
    // with a tiny cap, emptying every recent is not enough
    const rows = [
      row({ id: 'old-done', status: 'completed', ended_at: iso(NOW - 9000), recent: fullRecent(2) }),
      row({ id: 'new-done', status: 'failed', ended_at: iso(NOW - 1000), recent: fullRecent(2) }),
      row({ id: 'live', status: 'running', started_at: iso(NOW - 5000), recent: fullRecent(2) }),
    ]
    const s = snap(rows)
    const noRecent = snap(rows.map((r) => ({ ...r, recent: [] })))
    const withoutOld = snap(noRecent.rows.filter((r) => r.id !== 'old-done'))
    const cap = agentsSnapshotBytes(withoutOld)
    const t = trimAgentsSnapshot(s, cap)
    expect(t.snapshot.rows.map((r) => r.id)).toEqual(['new-done', 'live'])
    expect(t.snapshot.rows.every((r) => r.recent.length === 0)).toBe(true)
    expect(t.bytes).toBeLessThanOrEqual(cap)
  })

  it('last resort: long multi-byte text in every field still ends under the cap, oldest rows dropped', () => {
    const cjk = (n: number) => '\u754c'.repeat(n) // 3 UTF-8 bytes each
    const s = snap(
      Array.from({ length: AGENT_LIMITS.rows }, (_, i) =>
        row({
          id: cjk(80),
          type: cjk(64),
          name: cjk(64),
          title: cjk(160),
          activity: cjk(160),
          model: cjk(80),
          parent_id: cjk(80),
          started_at: iso(NOW - (100 - i) * 1000),
        }),
      ).map((r, i) => ({ ...r, id: `${i}${r.id}`.slice(0, 80) })),
    )
    expect(AgentsSnapshot.safeParse(s).success).toBe(true)
    const t = trimAgentsSnapshot(s)
    expect(t.bytes).toBeLessThanOrEqual(AGENT_LIMITS.frameBytes)
    expect(CappedAgentsSnapshot.safeParse(t.snapshot).success).toBe(true)
    expect(t.snapshot.rows.length).toBeLessThan(AGENT_LIMITS.rows)
    expect(t.snapshot.rows.at(-1)?.id).toBe(s.rows.at(-1)?.id) // the newest survive
  })
})

describe('oneLine', () => {
  it('strips control characters, collapses whitespace and trims', () => {
    expect(oneLine('  Run\tthe\n\nsuite  ')).toBe('Run the suite')
    expect(oneLine(`a${LS}b${RLO}c\u0000d`)).toBe('a b c d')
    expect(oneLine('   ')).toBe('')
    expect(oneLine(42)).toBeUndefined()
    expect(oneLine(undefined)).toBeUndefined()
  })
  it('clips with … to exactly max characters, never splitting a surrogate pair', () => {
    const out = oneLine('x'.repeat(500)) as string
    expect(out).toHaveLength(AGENT_LIMITS.text)
    expect(out.endsWith('…')).toBe(true)
    const emoji = `${'x'.repeat(158)}\u{1F600}tail` // the pair sits across the cut
    const clipped = oneLine(emoji) as string
    expect(clipped.length).toBeLessThanOrEqual(AGENT_LIMITS.text)
    expect(/[\uD800-\uDBFF]…$/.test(clipped)).toBe(false)
    expect(oneLine('abcdef', 4)).toBe('abc…')
    expect(AgentRow.safeParse(row({ title: out })).success).toBe(true)
  })
})

describe('agentRowsFromEngine (lenient)', () => {
  it('tolerates missing fields: an id alone is a row', () => {
    const { rows, dropped } = agentRowsFromEngine([{ id: 'a1' }], { canStop: true })
    expect(dropped).toBe(0)
    expect(rows[0]).toEqual({
      id: 'a1',
      kind: 'subagent',
      type: 'agent',
      title: '',
      status: 'unknown',
      background: false,
      stoppable: false,
      recent: [],
    })
  })

  it('reads $.agent.list() AgentInfo plus tracker and tee fields (camelCase), cleaning every string', () => {
    const start = NOW - 134_000
    const { rows } = agentRowsFromEngine(
      [
        {
          id: 'a00f4f30ac1399f7f',
          description: 'research\nmods API',
          type: 'Explore',
          status: 'running',
          parentId: 'p1',
          name: 'scout',
          label: 'Running memory and search vitest suites',
          activitySource: 'summary',
          tokenCount: 12_300,
          startTime: start,
          model: 'claude-sonnet-5-5',
          background: true,
          stoppable: false, // never read
          recent: [{ at: start + 1000, text: 'Read  register.ts' }],
          somethingNew: { ignored: true },
        },
        { id: 'tm1', teammateId: 'tm1', description: 'Review', type: 'general-purpose', status: 'idle' },
        { taskId: 'b7c2', type: 'shell', description: 'Run the dev server', status: 'running' },
      ],
      { canStop: true },
    )
    expect(rows[0]).toMatchObject({
      id: 'a00f4f30ac1399f7f',
      kind: 'subagent',
      title: 'research mods API',
      activity: 'Running memory and search vitest suites',
      activity_source: 'summary',
      parent_id: 'p1',
      name: 'scout',
      tokens: 12_300,
      started_at: iso(start),
      stoppable: true, // computed: capability AND live
      recent: [{ at: iso(start + 1000), text: 'Read register.ts' }],
    })
    expect(rows[1]).toMatchObject({ kind: 'teammate', status: 'idle' })
    expect(rows[2]).toMatchObject({ id: 'b7c2', kind: 'shell', type: 'shell', background: true })
  })

  it('stoppable is computed, never taken: no capability or an ended row means false', () => {
    const raw = [
      { id: 'a', status: 'running', stoppable: true },
      { id: 'b', status: 'completed', stoppable: true },
      { id: 'c', status: 'weird', stoppable: true },
    ]
    expect(agentRowsFromEngine(raw, { canStop: false }).rows.map((r) => r.stoppable)).toEqual([false, false, false])
    expect(agentRowsFromEngine(raw, { canStop: true }).rows.map((r) => r.stoppable)).toEqual([true, false, false])
  })

  it('drops rows without a usable id and duplicate ids (counted); bad field types are dropped, not fatal', () => {
    const { rows, dropped } = agentRowsFromEngine(
      [
        null,
        'x',
        { description: 'no id' },
        { id: 'x'.repeat(81) },
        { id: 'a\nb' },
        { id: 'ok', tokens: -5, startTime: 'yesterday', model: 7, recent: 'nope' },
        { id: 'ok' },
      ],
      { canStop: false },
    )
    expect(rows.map((r) => r.id)).toEqual(['ok'])
    expect(dropped).toBe(6)
    expect(rows[0]?.tokens).toBeUndefined()
    expect(rows[0]?.started_at).toBeUndefined()
    expect(rows[0]?.model).toBeUndefined()
    expect(agentRowsFromEngine('not a list', { canStop: true })).toEqual({ rows: [], dropped: 0 })
  })

  it('keeps the newest 8 recent lines and drops malformed ones; clips long text', () => {
    const recent = [
      { at: 'bad', text: 'x' },
      { at: NOW, text: '' },
      ...Array.from({ length: 12 }, (_, i) => ({ at: NOW + i * 1000, text: `line ${i} ${'y'.repeat(300)}` })),
    ]
    const r = agentRowsFromEngine([{ id: 'a', recent }], { canStop: false }).rows[0] as AgentRowT
    expect(r.recent).toHaveLength(AGENT_LIMITS.recent)
    expect(r.recent[0]?.text.startsWith('line 4 ')).toBe(true)
    expect(r.recent.every((l) => l.text.length <= AGENT_LIMITS.text)).toBe(true)
  })

  it('over 50 rows keeps live rows first', () => {
    const raw = [
      ...Array.from({ length: 30 }, (_, i) => ({ id: `done${i}`, status: 'completed' })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `live${i}`, status: 'running' })),
    ]
    const { rows, dropped } = agentRowsFromEngine(raw, { canStop: false })
    expect(rows).toHaveLength(AGENT_LIMITS.rows)
    expect(rows.filter((r) => r.status === 'running')).toHaveLength(30)
    expect(dropped).toBe(10)
  })

  it('agentsSnapshotFromEngine: only a missing session id fails', () => {
    expect(agentsSnapshotFromEngine([], { session_id: undefined, source: 'mod', canStop: true, at: AT }).ok).toBe(false)
    const r = agentsSnapshotFromEngine([{ id: 'a' }], {
      session_id: 'sess_1',
      source: 'mod+tee',
      canStop: true,
      at: AT,
    })
    expect(r.ok && r.snapshot).toMatchObject({ session_id: 'sess_1', source: 'mod+tee', rows: [{ id: 'a' }], at: AT })
  })
})

describe('shared helpers', () => {
  it('sameAgentsSnapshot ignores `at` only', () => {
    const a = snap([row()])
    expect(sameAgentsSnapshot(a, { ...a, at: iso(NOW + 5000) })).toBe(true)
    expect(sameAgentsSnapshot(a, snap([row({ status: 'idle' })]))).toBe(false)
    expect(sameAgentsSnapshot(a, snap([row()], { session_id: 'sess_2' }))).toBe(false)
    expect(sameAgentsSnapshot(undefined, undefined)).toBe(true)
    expect(sameAgentsSnapshot(a, undefined)).toBe(false)
  })
  it('markAgentsUnknown (mod lapsed): live rows unknown without Stop; ended rows unchanged', () => {
    const done = row({ id: 'd', status: 'completed', stoppable: false })
    const m = markAgentsUnknown(snap([row(), row({ id: 'w', status: 'waiting' }), done]), iso(NOW + 1))
    expect(m.rows.map((r) => r.status)).toEqual(['unknown', 'unknown', 'completed'])
    expect(m.rows.some((r) => r.stoppable)).toBe(false)
    expect(m.rows[2]).toBe(done)
    expect(m.at).toBe(iso(NOW + 1))
  })
  it('emptyAgentsSnapshot is a valid, empty snapshot', () => {
    expect(CappedAgentsSnapshot.parse(emptyAgentsSnapshot('sess_1', AT))).toEqual(snap([], { can_stop: false }))
  })
  it('agentCounts: running + waiting + idle, busy while one runs, live shells and monitors', () => {
    const c = agentCounts(
      snap([
        row({ id: '1' }),
        row({ id: '2', status: 'waiting' }),
        row({ id: '3', status: 'idle' }),
        row({ id: '4', status: 'pending' }),
        row({ id: '5', status: 'completed' }),
        row({ id: '6', kind: 'shell', type: 'shell', status: 'running' }),
        row({ id: '7', kind: 'monitor', type: 'monitor', status: 'killed' }),
      ]),
    )
    expect(c).toEqual({ active: 4, busy: true, shells: 1, monitors: 0 })
    expect(agentCounts(undefined)).toEqual({ active: 0, busy: false, shells: 0, monitors: 0 })
  })
  const st = (
    caps: SessionStateT['capabilities'],
    source: SessionStateT['source'] = 'mod',
    session_id = 'sess_1',
  ): SessionStateT => ({ session_id, source, capabilities: caps, rate_limits: [], surfaces: [], at: AT })
  it('canStopAgent: can_stop snapshot of THIS session, row stoppable and live, a live mod state', () => {
    const s = snap([row(), row({ id: 'off', stoppable: false }), row({ id: 'done', status: 'completed' })])
    expect(canStopAgent(s, 'a1', st(['stop']))).toBe(true)
    expect(canStopAgent({ ...s, can_stop: false }, 'a1', st(['stop']))).toBe(false)
    expect(canStopAgent(s, 'a1', st(['stop'], 'hooks'))).toBe(false)
    expect(canStopAgent(s, 'a1', st([]))).toBe(false) // the bridge's "mod offline" state
    expect(canStopAgent(s, 'a1', st(['stop'], 'mod', 'sess_other'))).toBe(false) // a leftover from another session
    expect(canStopAgent(s, 'off', st(['stop']))).toBe(false)
    expect(canStopAgent(s, 'done', st(['stop']))).toBe(false)
    expect(canStopAgent(s, 'missing', st(['stop']))).toBe(false)
    expect(canStopAgent(undefined, 'a1', st(['stop']))).toBe(false)
    expect(canStopAgent(s, 'a1', undefined)).toBe(false)
  })
  it('agentsForSession: a snapshot of another session than the state is not drawn', () => {
    const s = snap([row()])
    expect(agentsForSession(s, st(['stop']))).toBe(s)
    expect(agentsForSession(s, undefined)).toBe(s)
    expect(agentsForSession(s, st(['stop'], 'mod', 'sess_other'))).toBeUndefined()
    expect(agentsForSession(undefined, st(['stop']))).toBeUndefined()
  })
  it('markAgentsUnknown and emptyAgentsSnapshot clear can_stop', () => {
    expect(markAgentsUnknown(snap([row()]), AT).can_stop).toBe(false)
    expect(emptyAgentsSnapshot('s', AT).can_stop).toBe(false)
  })
})

describe('agentActivityForTool (docs/SUBAGENTS.md "Activity text")', () => {
  const cases: Array<[string, unknown, string]> = [
    ['Bash', { command: 'pnpm test', description: 'Run vitest suites' }, 'Run vitest suites'],
    ['Bash', { command: `echo ${'x'.repeat(200)}` }, `echo ${'x'.repeat(75)}`],
    ['Read', { file_path: '/work/repo/hooks/register.ts' }, 'Read register.ts'],
    ['Edit', { file_path: 'C:\\repo\\a.ts' }, 'Edit a.ts'],
    ['Write', {}, 'Write'],
    ['Grep', { pattern: 'AgentsSnapshot' }, 'Search "AgentsSnapshot"'],
    ['Glob', { pattern: '**/*.ts' }, 'Search "**/*.ts"'],
    ['WebFetch', { url: 'https://code.claude.com/docs/en/hooks.md' }, 'code.claude.com'],
    ['WebFetch', { url: 'not a url' }, 'WebFetch'],
    ['Agent', { subagent_type: 'Explore', description: 'map the repo' }, 'Spawn Explore: map the repo'],
    ['mcp__talos-app__reply', { text: 'hi' }, 'talos-app · reply'],
    ['TodoWrite', { todos: [] }, 'TodoWrite'],
  ]
  for (const [tool, input, want] of cases)
    it(`${tool} → ${want.slice(0, 40)}`, () => expect(agentActivityForTool(tool, input)).toBe(want))
  it('one line, clipped, even from a hostile description', () => {
    const t = agentActivityForTool('Bash', { description: `a\nb${'c'.repeat(400)}` })
    expect(t.includes('\n')).toBe(false)
    expect(t.length).toBeLessThanOrEqual(AGENT_LIMITS.text)
  })
})

describe('the agent_stop control', () => {
  const ok = { ...env('session.control'), control_id: '01JBF3V7Q8K2M4N6P8R0S2T4C1', thread_id: 'general', ...owner }
  it('session.control: agent_stop needs agent_id; no other action takes one; it takes no args', () => {
    expect(parseFrame({ ...ok, action: 'agent_stop', agent_id: 'a1' }).ok).toBe(true)
    expect(parseFrame({ ...ok, action: 'agent_stop' }).ok).toBe(false)
    expect(parseFrame({ ...ok, action: 'agent_stop', agent_id: '' }).ok).toBe(false)
    expect(parseFrame({ ...ok, action: 'agent_stop', agent_id: 'x'.repeat(81) }).ok).toBe(false)
    expect(parseFrame({ ...ok, action: 'agent_stop', agent_id: 'a1', args: 'now' }).ok).toBe(false)
    expect(parseFrame({ ...ok, action: 'compact', agent_id: 'a1' }).ok).toBe(false)
    expect(parseFrame({ ...ok, action: 'stop', turn_id: 't1', agent_id: 'a1' }).ok).toBe(false)
    expect(parseFrame({ ...ok, action: 'agent_stop', agent_id: 'a1', turn_id: 't1' }).ok).toBe(false)
  })
  it('ModControl: the same rules', () => {
    const c = { control_id: '01JBF3V7Q8K2M4N6P8R0S2T4C1' }
    expect(ModControl.safeParse({ ...c, action: 'agent_stop', agent_id: 'a1' }).success).toBe(true)
    expect(ModControl.safeParse({ ...c, action: 'agent_stop' }).success).toBe(false)
    expect(ModControl.safeParse({ ...c, action: 'agent_stop', agent_id: 'a1', args: 'x' }).success).toBe(false)
    expect(ModControl.safeParse({ ...c, action: 'compact', agent_id: 'a1' }).success).toBe(false)
  })

  const state: SessionStateT = {
    session_id: 'sess_1',
    source: 'mod',
    capabilities: ['agents', 'agent_stop'],
    rate_limits: [],
    surfaces: [],
    at: AT,
  }
  const base = { now: NOW, state, inventory: undefined, allowedModels: [] as string[] }
  const agents = snap([row(), row({ id: 'done', status: 'completed', stoppable: false })])
  const tap = (agent_id?: string, extra: Record<string, unknown> = {}) => ({
    action: 'agent_stop' as const,
    ts: AT,
    ...(agent_id !== undefined ? { agent_id } : {}),
    ...extra,
  })

  it('checkSessionControl: a live, stoppable row of this session passes', () => {
    expect(checkSessionControl(tap('a1'), { ...base, agents })).toEqual({ ok: true })
  })
  it('refused without the capability, from a non-mod source, stale, or stopped at the Mac', () => {
    const noCap = { ...state, capabilities: ['agents' as const] }
    expect(checkSessionControl(tap('a1'), { ...base, state: noCap, agents })).toMatchObject({
      code: 'capability_missing',
    })
    expect(checkSessionControl(tap('a1'), { ...base, state: { ...state, source: 'hooks' }, agents })).toMatchObject({
      code: 'capability_missing',
    })
    expect(checkSessionControl(tap('a1'), { ...base, now: NOW + 121_000, agents })).toMatchObject({
      code: 'control_stale',
    })
    expect(
      checkSessionControl(tap('a1'), { ...base, state: { ...state, stopped_at_mac: true }, agents }),
    ).toMatchObject({
      code: 'stopped_at_mac',
    })
  })
  it('refused (agent_not_found) with no snapshot, an unknown id, an ended row, or another session', () => {
    expect(checkSessionControl(tap('a1'), base)).toMatchObject({ code: 'agent_not_found' })
    expect(checkSessionControl(tap('nope'), { ...base, agents })).toMatchObject({ code: 'agent_not_found' })
    expect(checkSessionControl(tap('done'), { ...base, agents })).toMatchObject({ code: 'agent_not_found' })
    expect(checkSessionControl(tap('a1'), { ...base, agents: { ...agents, session_id: 'sess_other' } })).toMatchObject({
      code: 'agent_not_found',
    })
    expect(checkSessionControl(tap('a1'), { ...base, agents: { ...agents, can_stop: false } })).toMatchObject({
      code: 'agent_not_found',
    })
    const unstoppable = snap([row({ stoppable: false })])
    expect(checkSessionControl(tap('a1'), { ...base, agents: unstoppable })).toMatchObject({ code: 'agent_not_found' })
  })
  it('args_invalid: no agent id, an agent id on another action, or args', () => {
    expect(checkSessionControl(tap(), { ...base, agents })).toMatchObject({ code: 'args_invalid' })
    expect(checkSessionControl(tap('a1', { args: 'now' }), { ...base, agents })).toMatchObject({ code: 'args_invalid' })
    const withStop = { ...state, capabilities: [...state.capabilities, 'compact' as const] }
    expect(
      checkSessionControl({ action: 'compact', ts: AT, agent_id: 'a1' }, { ...base, state: withStop, agents }),
    ).toMatchObject({ code: 'args_invalid' })
  })
  it('the error code exists', () => {
    expect(ErrorCode.options).toContain('agent_not_found')
  })
})

describe('session.agents in the frame tables', () => {
  it('bridge → relay → app only; not owner, not durable, not consumable', () => {
    expect(SESSION_BRIDGE_FRAME_TYPES as readonly string[]).toContain('session.agents')
    expect(DIRECTION_TYPES.bridge_to_relay as readonly string[]).toContain('session.agents')
    expect(DIRECTION_TYPES.relay_to_app as readonly string[]).toContain('session.agents')
    expect(DIRECTION_TYPES.app_to_relay as readonly string[]).not.toContain('session.agents')
    expect(DIRECTION_TYPES.relay_to_bridge as readonly string[]).not.toContain('session.agents')
    for (const list of [
      OWNER_FRAME_TYPES,
      DURABLE_FRAME_TYPES,
      CONSUMABLE_FRAME_TYPES,
      SESSION_DURABLE_FRAME_TYPES,
      SESSION_CONSUMABLE_FRAME_TYPES,
    ])
      expect(list as readonly string[]).not.toContain('session.agents')
  })
  it('an app may not send one', () => {
    expect(parseFrame(fixtures['session.agents'], { direction: 'app_to_relay' }).ok).toBe(false)
  })
  it('ModSyncRequest carries agents optionally and strictly', () => {
    const k = { mod_key: 'k'.repeat(43) }
    expect(ModSyncRequest.safeParse(k).success).toBe(true)
    expect(ModSyncRequest.safeParse({ ...k, agents: snap([row()]) }).success).toBe(true)
    expect(ModSyncRequest.safeParse({ ...k, agents: { ...snap([row()]), extra: 1 } }).success).toBe(false)
  })
})

describe('old peers (review #1): what a new bridge publishes still parses with the parser main shipped', () => {
  // A frozen copy of the capability rule in main before this change (7c587be, session.ts): a strict enum of nine, and a
  // strict object, so one unknown capability refuses the whole state and the whole `ready`.
  const MAIN_CAPS = [
    'stop',
    'compact',
    'command',
    'clear',
    'model',
    'effort',
    'inventory',
    'permission_close',
    'sessions',
  ] as const
  const MainSessionState = SessionState.extend({ capabilities: z.array(z.enum(MAIN_CAPS)).max(9).default([]) })
  const MainReady = ReadyFrame.omit({ session_agents: true }).extend({ session_state: MainSessionState.optional() })
  const modState: SessionStateT = {
    session_id: 'sess_1',
    source: 'mod',
    capabilities: ['stop', 'compact', 'agents', 'agent_stop'],
    rate_limits: [],
    surfaces: [],
    at: AT,
  }

  it('the frozen copy really is main: it refuses a state with agents capabilities', () => {
    expect(MainSessionState.safeParse(modState).success).toBe(false)
  })
  it("V1 is exactly main's list", () => {
    expect([...SESSION_CAPABILITIES_V1].sort()).toEqual([...MAIN_CAPS].sort())
  })
  it('wireSessionState (what the bridge publishes) parses under main, so an old cached app still goes online', () => {
    const wire = wireSessionState(modState)
    expect(wire.capabilities).toEqual(['stop', 'compact'])
    expect(MainSessionState.safeParse(wire).success).toBe(true)
    const ready = {
      ...env('ready'),
      session_id: 'sess_ready',
      policy: { max_frame_bytes: 262144, ping_ms: 25000 },
      server_seq: 0,
      presence: { bridge_online: true, last_seen: AT, queue_depth: 0 },
      session_state: wire,
      session_agents: fixtures['session.agents']?.agents, // a new relay adds it; main's `ready` is not strict
    }
    const old = MainReady.safeParse(ready)
    expect(old.success).toBe(true)
    expect(old.success && 'session_agents' in old.data).toBe(false) // stripped, not fatal
    expect(parseFrame(ready, { direction: 'relay_to_app' }).ok).toBe(true)
  })
  it('a new build reads unknown capabilities leniently: dropped, never fatal (the next capability is safe)', () => {
    const r = SessionState.safeParse({ ...modState, capabilities: ['stop', 'future_cap', 'stop', 'agents'] })
    expect(r.success && r.data.capabilities).toEqual(['stop', 'agents'])
  })
})
