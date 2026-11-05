// Claude Code integration, session side (docs/CLAUDE-CODE.md C2, C4): state and inventory models, the command policy
// keyed on (source, name), the `/` palette plan, session.control re-checks, model and effort rules, the mod link, the
// Sessions view, and the threads text. Everything here fails closed: unknown means refused or greyed.
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_CONTROL_COMMANDS,
  CLAUDE_CODE_MIN_VERSION,
  CONTROL_STALE_MS,
  checkSessionControl,
  DEFAULT_SESSION_MODELS,
  effectiveModelList,
  effortKeepsCache,
  inventoryCommandsFromEngine,
  isClaudeAiUrl,
  isModToolName,
  isStoppedAtMacReason,
  MOD_TOOLS,
  MODEL_SWITCH_TIMEOUT_MS,
  ModControl,
  ModControlResult,
  ModEvent,
  ModSyncRequest,
  ModSyncResponse,
  modelSwitchNotes,
  type PaletteContext,
  planPaletteRun,
  routeFor,
  SESSION_CAPABILITIES,
  SessionInventory,
  type SessionInventoryT,
  SessionListItem,
  SessionReportInput,
  SessionState,
  type SessionStateT,
  sessionStateFromEngine,
  threadsExplainer,
} from '../src/index.ts'

const AT = '2026-10-29T12:00:00.000Z'
const NOW = Date.parse(AT)

const inventory: SessionInventoryT = SessionInventory.parse({
  commands: [
    { name: 'context', description: 'Show context', source: 'builtin', route: 'control' },
    { name: 'model', description: 'Switch model', source: 'builtin', route: 'control' },
    { name: 'effort', description: 'Set effort', source: 'builtin', route: 'control' },
    { name: 'mcp', description: 'MCP servers', source: 'builtin', route: 'control' },
    { name: 'reload-plugins', description: 'Reload', source: 'builtin', route: 'control' },
    { name: 'fast', description: 'Fast mode', source: 'builtin', route: 'control' },
    { name: 'compact', description: 'Compact', source: 'builtin', route: 'control' },
    { name: 'clear', description: 'Clear', source: 'builtin', route: 'control' },
    { name: 'permissions', description: 'Permissions', source: 'builtin', route: 'local_only' },
    {
      name: 'code-review',
      description: 'A project skill that shadows a bundled one',
      source: 'user',
      route: 'message',
    },
    { name: 'deploy', description: 'Plugin command', source: 'plugin', plugin: 'ops', route: 'message' },
    { name: 'standup', description: 'MCP prompt', source: 'mcp', route: 'message' },
  ],
  models: [
    { value: 'default', label: 'Default' },
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' },
    { value: 'fable', label: 'Fable' },
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  mcp_servers: [],
  plugins: [],
  at: AT,
})

const state: SessionStateT = SessionState.parse({
  session_id: 's1',
  source: 'mod',
  capabilities: ['stop', 'compact', 'command', 'clear', 'model', 'effort', 'inventory'],
  version: '2.1.312',
  model: { id: 'claude-opus-5-5' },
  busy: true,
  turn_id: 't_live',
  at: AT,
})

const ctx: PaletteContext = { inventory, allowedModels: DEFAULT_SESSION_MODELS }

describe('SessionState / SessionInventory (outbound: strict)', () => {
  it('parses the spec shape and rejects unknown fields', () => {
    expect(SessionState.safeParse({ ...state, extra: 1 }).success).toBe(false)
    expect(SessionInventory.safeParse({ ...inventory, extra: 1 }).success).toBe(false)
  })
  it('lists the nine capabilities of C2.2, plus the two of the agents panel (docs/SUBAGENTS.md)', () => {
    expect([...SESSION_CAPABILITIES].sort()).toEqual(
      [
        'clear',
        'command',
        'compact',
        'effort',
        'inventory',
        'model',
        'permission_close',
        'sessions',
        'stop',
        'agents',
        'agent_stop',
      ].sort(),
    )
  })
  it('knows the four sources, including agents_json', () => {
    for (const source of ['mod', 'hooks', 'statusline', 'agents_json'])
      expect(SessionState.safeParse({ ...state, source }).success).toBe(true)
    expect(SessionState.safeParse({ ...state, source: 'transcript' }).success).toBe(false)
  })
  it('floor version is 2.1.304', () => {
    expect(CLAUDE_CODE_MIN_VERSION).toBe('2.1.304')
  })
})

describe('engine data is parsed leniently (C2.2, review #6)', () => {
  it('accepts usage with tokens and percent missing, and unknown fields', () => {
    const s = sessionStateFromEngine(
      {
        id: 's1',
        model: 'claude-opus-5-5',
        version: '2.1.312',
        usage: { context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', resetsAt: AT, brandNew: 1 }] },
        surfaces: ['cli', 'remote'],
        somethingNew: { a: 1 },
      },
      { source: 'mod', capabilities: ['stop'], at: AT },
    )
    expect(s.ok).toBe(true)
    if (s.ok) {
      expect(s.state.context).toEqual({ window: 1_000_000 })
      expect(s.state.model?.id).toBe('claude-opus-5-5')
      expect(SessionState.safeParse(s.state).success).toBe(true)
    }
  })
  it('refuses engine data with no session id (nothing to show)', () => {
    expect(sessionStateFromEngine({ model: 'x' }, { source: 'mod', capabilities: [], at: AT }).ok).toBe(false)
  })
  it('drops command rows without a name or a known source, and computes the route itself', () => {
    const r = inventoryCommandsFromEngine([
      { name: 'context', description: 'ctx', source: 'builtin', future: true },
      { name: 'code-review', source: 'user' },
      { description: 'no name', source: 'builtin' },
      { name: 'weird', source: 'remote' },
      { name: 'x'.repeat(65), source: 'plugin' },
      'not an object',
    ])
    expect(r.commands.map((c) => [c.name, c.route])).toEqual([
      ['context', 'control'],
      ['code-review', 'message'],
    ])
    expect(r.dropped).toBe(4)
  })
  it('a non-array command list is an empty inventory, not a throw', () => {
    expect(inventoryCommandsFromEngine({ nope: 1 }).commands).toEqual([])
  })
})

describe('routeFor: keyed on (source, name), never the name alone (C4.2)', () => {
  it('allowlisted built-ins take the control route', () => {
    for (const name of [
      'context',
      'usage',
      'recap',
      'mcp',
      'reload-plugins',
      'model',
      'effort',
      'fast',
      'compact',
      'clear',
    ])
      expect(routeFor({ source: 'builtin', name }), name).toBe('control')
  })
  it('the allowlist is exactly the C4.2 list', () => {
    expect(Object.keys(BUILTIN_CONTROL_COMMANDS).sort()).toEqual(
      ['clear', 'compact', 'context', 'effort', 'fast', 'mcp', 'model', 'recap', 'reload-plugins', 'usage'].sort(),
    )
  })
  it('every other built-in is local_only', () => {
    for (const name of ['permissions', 'login', 'resume', 'plugin', 'config', 'exit', 'unknown-new-thing'])
      expect(routeFor({ source: 'builtin', name }), name).toBe('local_only')
  })
  it('skills, plugin commands and MCP prompts take the message route, even with a built-in name', () => {
    expect(routeFor({ source: 'user', name: 'compact' })).toBe('message')
    expect(routeFor({ source: 'plugin', name: 'model' })).toBe('message')
    expect(routeFor({ source: 'mcp', name: 'standup' })).toBe('message')
  })
  it('an unknown source is local_only', () => {
    expect(routeFor({ source: 'remote' as never, name: 'context' })).toBe('local_only')
  })
})

describe('planPaletteRun: what the phone sends for a picked command', () => {
  it('a skill becomes an owner message /<name> <args> (C4.3)', () => {
    expect(planPaletteRun({ source: 'user', name: 'code-review', args: 'src/a.ts' }, ctx)).toEqual({
      ok: true,
      kind: 'message',
      text: '/code-review src/a.ts',
    })
    expect(planPaletteRun({ source: 'plugin', name: 'deploy', args: '' }, ctx)).toEqual({
      ok: true,
      kind: 'message',
      text: '/deploy',
    })
  })
  it('/compact and /clear map to their own actions (one compact path)', () => {
    expect(planPaletteRun({ source: 'builtin', name: 'compact', args: 'keep the plan' }, ctx)).toEqual({
      ok: true,
      kind: 'control',
      action: 'compact',
      args: 'keep the plan',
    })
    expect(planPaletteRun({ source: 'builtin', name: 'clear', args: '' }, ctx)).toEqual({
      ok: true,
      kind: 'control',
      action: 'clear',
    })
    expect(planPaletteRun({ source: 'builtin', name: 'clear', args: 'x' }, ctx)).toMatchObject({
      ok: false,
      code: 'args_invalid',
    })
  })
  it('argument grammar: mcp takes none; reload-plugins refuses --force; fast is on|off', () => {
    expect(planPaletteRun({ source: 'builtin', name: 'mcp', args: '' }, ctx)).toMatchObject({ ok: true })
    expect(planPaletteRun({ source: 'builtin', name: 'mcp', args: 'disable talos-app' }, ctx)).toMatchObject({
      ok: false,
      code: 'args_invalid',
    })
    expect(planPaletteRun({ source: 'builtin', name: 'reload-plugins', args: '--force' }, ctx)).toMatchObject({
      ok: false,
      code: 'args_invalid',
    })
    expect(planPaletteRun({ source: 'builtin', name: 'fast', args: 'on' }, ctx)).toMatchObject({ ok: true })
    expect(planPaletteRun({ source: 'builtin', name: 'fast', args: 'turbo' }, ctx)).toMatchObject({
      ok: false,
      code: 'args_invalid',
    })
    expect(planPaletteRun({ source: 'builtin', name: 'context', args: 'all' }, ctx)).toMatchObject({
      ok: false,
      code: 'args_invalid',
    })
  })
  it('model: only from the configured list (model_not_allowed otherwise)', () => {
    expect(planPaletteRun({ source: 'builtin', name: 'model', args: 'sonnet' }, ctx)).toEqual({
      ok: true,
      kind: 'control',
      action: 'command',
      command: 'model',
      args: 'sonnet',
    })
    expect(planPaletteRun({ source: 'builtin', name: 'model', args: 'fable' }, ctx)).toMatchObject({
      ok: false,
      code: 'model_not_allowed',
    })
    expect(planPaletteRun({ source: 'builtin', name: 'model', args: '' }, ctx)).toMatchObject({
      ok: false,
      code: 'args_invalid',
    })
  })
  it('effort: a level the model supports, or auto', () => {
    expect(planPaletteRun({ source: 'builtin', name: 'effort', args: 'high' }, ctx)).toMatchObject({ ok: true })
    expect(planPaletteRun({ source: 'builtin', name: 'effort', args: 'auto' }, ctx)).toMatchObject({ ok: true })
    expect(planPaletteRun({ source: 'builtin', name: 'effort', args: 'ludicrous' }, ctx)).toMatchObject({
      ok: false,
      code: 'args_invalid',
    })
  })
  it('a local_only built-in is refused', () => {
    expect(planPaletteRun({ source: 'builtin', name: 'permissions', args: '' }, ctx)).toMatchObject({
      ok: false,
      code: 'command_not_allowed',
    })
  })
  it('a command the inventory does not list under that source is command_changed', () => {
    expect(planPaletteRun({ source: 'builtin', name: 'usage', args: '' }, ctx)).toMatchObject({
      ok: false,
      code: 'command_changed',
    })
    expect(planPaletteRun({ source: 'plugin', name: 'code-review', args: '' }, ctx)).toMatchObject({
      ok: false,
      code: 'command_changed',
    })
  })
  it('arguments with control characters, newlines or over 500 chars are refused (never reach a shell)', () => {
    for (const args of ['a\nb', 'a\u0000', 'a\u001b[2J', 'x'.repeat(501)])
      expect(planPaletteRun({ source: 'user', name: 'code-review', args }, ctx)).toMatchObject({
        ok: false,
        code: 'args_invalid',
      })
  })
})

const control = (over: Record<string, unknown> = {}) => ({
  control_id: '01JBF3V7Q8K2M4N6P8R0S2T4A0',
  thread_id: 'general',
  action: 'stop' as const,
  turn_id: 't_live',
  ts: AT,
  ...over,
})

describe('checkSessionControl: the bridge re-check before queuing (C2.3 "the boundary is the bridge")', () => {
  const base = { now: NOW, state, inventory, allowedModels: DEFAULT_SESSION_MODELS }
  it('accepts a fresh stop for the running turn', () => {
    expect(checkSessionControl(control(), base)).toEqual({ ok: true })
  })
  it('a control older than 2 minutes is control_stale', () => {
    const ts = new Date(NOW - CONTROL_STALE_MS - 1).toISOString()
    expect(checkSessionControl(control({ ts }), base)).toMatchObject({ ok: false, code: 'control_stale' })
  })
  it('a control from the future beyond clock skew is stale too', () => {
    const ts = new Date(NOW + 5 * 60_000).toISOString()
    expect(checkSessionControl(control({ ts }), base)).toMatchObject({ ok: false, code: 'control_stale' })
  })
  it('a stop for another turn is turn_mismatch; a stop while idle is turn_mismatch', () => {
    expect(checkSessionControl(control({ turn_id: 't_old' }), base)).toMatchObject({ ok: false, code: 'turn_mismatch' })
    expect(
      checkSessionControl(control(), { ...base, state: { ...state, busy: false, turn_id: undefined } }),
    ).toMatchObject({ ok: false, code: 'turn_mismatch' })
  })
  it('a missing capability is capability_missing; no state at all is capability_missing', () => {
    expect(checkSessionControl(control(), { ...base, state: { ...state, capabilities: ['compact'] } })).toMatchObject({
      ok: false,
      code: 'capability_missing',
    })
    expect(checkSessionControl(control(), { ...base, state: undefined })).toMatchObject({
      ok: false,
      code: 'capability_missing',
    })
  })
  it('hooks-only state never allows a control, even if it claims a capability', () => {
    expect(checkSessionControl(control(), { ...base, state: { ...state, source: 'hooks' } })).toMatchObject({
      ok: false,
      code: 'capability_missing',
    })
  })
  it('command: re-checks route, grammar and model list against the current inventory', () => {
    expect(
      checkSessionControl(
        control({ action: 'command', source: 'builtin', command: 'model', args: 'opus', turn_id: undefined }),
        base,
      ),
    ).toEqual({ ok: true })
    expect(
      checkSessionControl(
        control({ action: 'command', source: 'builtin', command: 'model', args: 'fable', turn_id: undefined }),
        base,
      ),
    ).toMatchObject({ ok: false, code: 'model_not_allowed' })
    expect(
      checkSessionControl(
        control({ action: 'command', source: 'builtin', command: 'permissions', turn_id: undefined }),
        base,
      ),
    ).toMatchObject({ ok: false, code: 'command_not_allowed' })
    const noModel = { ...inventory, commands: inventory.commands.filter((c) => c.name !== 'model') }
    expect(
      checkSessionControl(
        control({ action: 'command', source: 'builtin', command: 'model', args: 'opus', turn_id: undefined }),
        {
          ...base,
          inventory: noModel,
        },
      ),
    ).toMatchObject({ ok: false, code: 'command_changed' })
  })
  it('command must not name compact or clear (they have their own actions)', () => {
    expect(
      checkSessionControl(
        control({ action: 'command', source: 'builtin', command: 'compact', turn_id: undefined }),
        base,
      ),
    ).toMatchObject({ ok: false, code: 'command_not_allowed' })
  })
  it('a model command needs the model capability; effort needs effort', () => {
    const noModel = { ...state, capabilities: state.capabilities.filter((c) => c !== 'model') }
    expect(
      checkSessionControl(
        control({ action: 'command', source: 'builtin', command: 'model', args: 'opus', turn_id: undefined }),
        {
          ...base,
          state: noModel,
        },
      ),
    ).toMatchObject({ ok: false, code: 'capability_missing' })
  })
  it('compact takes instructions up to 500 chars; clear takes none', () => {
    expect(checkSessionControl(control({ action: 'compact', args: 'keep it', turn_id: undefined }), base)).toEqual({
      ok: true,
    })
    expect(checkSessionControl(control({ action: 'clear', args: 'x', turn_id: undefined }), base)).toMatchObject({
      ok: false,
      code: 'args_invalid',
    })
  })
  it('a session stopped at the Mac refuses new work', () => {
    expect(
      checkSessionControl(control({ action: 'compact', turn_id: undefined }), {
        ...base,
        state: { ...state, stopped_at_mac: true },
      }),
    ).toMatchObject({ ok: false, code: 'stopped_at_mac' })
  })
})

describe('model and effort (C4.4)', () => {
  it('the default model list is default/opus/sonnet/haiku', () => {
    expect(DEFAULT_SESSION_MODELS).toEqual(['default', 'opus', 'sonnet', 'haiku'])
  })
  it('effective list = config list intersected with the /config model row options when present', () => {
    expect(effectiveModelList(['default', 'opus', 'sonnet'], undefined)).toEqual(['default', 'opus', 'sonnet'])
    expect(effectiveModelList(['default', 'opus', 'sonnet'], ['opus', 'haiku'])).toEqual(['opus'])
    expect(effectiveModelList(['opus'], [])).toEqual([])
  })
  it('a full model id the owner typed is never narrowed away by the engine row; an alias still is', () => {
    const typed = 'claude-opus-4-1-20250805'
    expect(effectiveModelList(['opus', typed, 'sonnet[1m]'], ['haiku'])).toEqual([typed])
    expect(effectiveModelList([typed], [])).toEqual([typed])
    expect(effectiveModelList(['opus', typed], ['opus', 'haiku'])).toEqual(['opus', typed])
    expect(effectiveModelList(['sonnet[1m]'], ['sonnet[1m]'])).toEqual(['sonnet[1m]'])
  })
  it('every switch warns about re-reading; fable and best also warn about credits', () => {
    expect(modelSwitchNotes('sonnet').reread).toMatch(/re-reads the whole conversation/)
    expect(modelSwitchNotes('sonnet').credits).toBeUndefined()
    expect(modelSwitchNotes('fable').credits).toMatch(/usage credits/)
    expect(modelSwitchNotes('best').credits).toMatch(/only at the Mac/)
    expect(modelSwitchNotes('opus').default_note).toMatch(/default for new sessions/)
  })
  it('effort keeps the cache only on the documented models; anything else may ask (fail closed)', () => {
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'])
      expect(effortKeepsCache(id), id).toBe(true)
    for (const id of ['claude-opus-4-7', 'opus', 'something-else', '', undefined])
      expect(effortKeepsCache(id), String(id)).toBe(false)
  })
  it('the switch timeout is 15 s', () => {
    expect(MODEL_SWITCH_TIMEOUT_MS).toBe(15_000)
  })
})

describe('mod link (C2.3)', () => {
  it('the guard matches the two mod tools under any server name, and nothing else', () => {
    expect(MOD_TOOLS).toEqual(['talos_mod_hello', 'talos_mod_sync'])
    expect(isModToolName('mcp__talos-app__talos_mod_sync')).toBe(true)
    expect(isModToolName('mcp__my_bridge__talos_mod_hello')).toBe(true)
    expect(isModToolName('mcp__talos-app__talos_mod_anything')).toBe(true)
    expect(isModToolName('mcp__talos-app__reply')).toBe(false)
    expect(isModToolName('talos_mod_sync')).toBe(false)
  })
  it('sync request and response are strict', () => {
    const req = { mod_key: 'k'.repeat(43), state, events: [{ type: 'turn_start', turn_id: 't1', at: AT }] }
    expect(ModSyncRequest.safeParse(req).success).toBe(true)
    expect(ModSyncRequest.safeParse({ ...req, mod_key: 'short' }).success).toBe(false)
    expect(ModSyncRequest.safeParse({ ...req, extra: 1 }).success).toBe(false)
    expect(ModSyncResponse.safeParse({ controls: [] }).success).toBe(true)
  })
  it('events cover turns, prompts, compaction, model switches and the stopped-at-Mac state', () => {
    const ok = [
      { type: 'turn_start', turn_id: 't1', at: AT },
      { type: 'turn_complete', turn_id: 't1', aborted: true, at: AT },
      { type: 'prompt_open', tool_name: 'Bash', input_hash: `sha256:${'a'.repeat(64)}`, at: AT },
      { type: 'prompt_closed', tool_name: 'Bash', input_hash: `sha256:${'a'.repeat(64)}`, at: AT },
      { type: 'compacting', on: true, at: AT },
      { type: 'model_switched', model: 'claude-sonnet-5-5', at: AT },
      { type: 'effort_changed', effort: 'high', at: AT },
      { type: 'stopped_at_mac', at: AT },
    ]
    for (const e of ok) expect(ModEvent.safeParse(e).success, e.type).toBe(true)
    expect(ModEvent.safeParse({ type: 'prompt_open', tool_name: 'Bash', input_hash: 'x', at: AT }).success).toBe(false)
  })
  it('a control handed to the mod carries a one-shot model ticket only for a model command', () => {
    const c = {
      control_id: '01JBF3V7Q8K2M4N6P8R0S2T4A0',
      action: 'command',
      command: 'model',
      source: 'builtin',
      args: 'sonnet',
      model_ticket: { to_model: 'sonnet', expires_at: AT },
    }
    expect(ModControl.safeParse(c).success).toBe(true)
    expect(ModControl.safeParse({ ...c, command: 'effort', args: 'high' }).success).toBe(false)
    expect(
      ModControl.safeParse({ ...c, action: 'stop', command: undefined, source: undefined, args: undefined }).success,
    ).toBe(false)
    expect(ModControl.safeParse({ ...c, source: undefined }).success).toBe(false)
  })
  it('results carry an error code', () => {
    expect(
      ModControlResult.safeParse({
        control_id: '01JBF3V7Q8K2M4N6P8R0S2T4A0',
        ok: false,
        code: 'model_switch_denied',
        text: 'Blocked by a PreModelSwitch hook: policy',
      }).success,
    ).toBe(true)
  })
  it('recognises the engine refusal text for a session stopped at the Mac', () => {
    expect(isStoppedAtMacReason('Refused: the session was stopped and nobody has sent input since.')).toBe(true)
    expect(isStoppedAtMacReason('Refused: busy')).toBe(false)
  })
})

describe('Sessions view (C4.6)', () => {
  it('session_report URLs must be https://claude.ai/…, nothing else', () => {
    for (const u of ['https://claude.ai/code/session_123', 'https://claude.ai/']) expect(isClaudeAiUrl(u), u).toBe(true)
    for (const u of [
      'http://claude.ai/x',
      'https://claude.ai.evil.example/x',
      'https://evil.example/https://claude.ai/',
      ['https://u', 'claude.ai/x'].join('@'), // userinfo
      'https://claude.ai:8443/x',
      'https://sub.claude.ai/x',
      'javascript:alert(1)',
      ' https://claude.ai/x',
      'https://claude.ai/x\n',
    ])
      expect(isClaudeAiUrl(u), u).toBe(false)
  })
  it('SessionReportInput drops a non-claude.ai url instead of failing the report', () => {
    const r = SessionReportInput.parse({
      kind: 'cloud',
      title: 'Nightly refactor',
      url: 'https://evil.example/login',
      thread_id: 'general',
    })
    expect(r.url).toBeUndefined()
    const ok = SessionReportInput.parse({
      kind: 'cloud',
      title: 'Nightly refactor',
      url: 'https://claude.ai/code/session_1',
      thread_id: 'general',
    })
    expect(ok.url).toBe('https://claude.ai/code/session_1')
  })
  it('a list item says whether output is available (background sessions only)', () => {
    const bg = SessionListItem.parse({
      id: 'bg_1',
      kind: 'background',
      title: 'tests',
      status: 'working',
      output: 'available',
      updated_at: AT,
    })
    expect(bg.output).toBe('available')
    expect(
      SessionListItem.safeParse({
        id: 'i_1',
        kind: 'interactive',
        title: 'main',
        status: 'working',
        output: 'available',
        updated_at: AT,
      }).success,
    ).toBe(false)
  })
})

describe('threads text (C7.2, C7.3, C8.1)', () => {
  it('the explainer names the agent', () => {
    expect(threadsExplainer('Talos')).toBe(
      'Threads keep topics apart. Talos replies where you ask and files its own updates by topic.',
    )
  })
})
