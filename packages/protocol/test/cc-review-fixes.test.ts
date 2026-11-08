// Fixes for the PR #32 review (R1-R4, L4, L7): failing first against 3d7793d, alongside the reviewer's review-c0.test.ts.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  type CardT,
  checkSessionControl,
  composePermissionCard,
  DEFAULT_SESSION_MODELS,
  inventoryCommandsFromEngine,
  type PaletteContext,
  PERMISSION_HIDDEN_WARNING,
  PERMISSION_MIN_CLIENT_VERSION,
  PERMISSION_OLD_CLIENT_WARNING,
  permissionCardAllowsPrimary,
  permissionClientVerified,
  permissionHiddenReasons,
  planPaletteRun,
  type SessionInventoryT,
  type SessionStateT,
  sessionStateFromEngine,
  sessionStateFromStatusline,
  toIsoTs,
  visibleText,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (n: string) => JSON.parse(readFileSync(join(here, '..', 'fixtures', 'claude-code', n), 'utf8'))
const NOW = Date.parse('2026-10-29T12:00:00.000Z')
const AT = new Date(NOW).toISOString()
const req = (over: Record<string, string> = {}) => ({
  request_id: 'abcde',
  tool_name: 'Bash',
  description: 'List files',
  input_preview: '{"command": "ls"}',
  ...over,
})
/** `null` = the bridge could not read a client version. */
const compose = (over: Record<string, string> = {}, client_version: string | null = '2.1.312') =>
  composePermissionCard({
    request: req(over),
    card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4F0',
    thread_id: 'general',
    now: NOW,
    ...(client_version === null ? {} : { client_version }),
  })

describe('R1: invisible and bidi characters are shown as visible markers; the card stays Allow-able (owner call: seen in full means approvable)', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['RLO in input_preview', { input_preview: '{"command": "echo ok ‮~ fr- mr"}' }],
    ['LRI/PDI in description', { description: 'Run the tests ⁦⁩' }],
    ['zero-width space in input_preview', { input_preview: '{"command": "git push orig​in main"}' }],
    ['BOM in input_preview', { input_preview: '﻿{"command": "ls"}' }],
    ['a tag character', { input_preview: '{"command": "ls \u{e0041}"}' }],
    ['a raw newline in description (unsanitized text)', { description: 'line one\nline two' }],
    ['zero-width joiner in tool_name (never sanitized)', { tool_name: 'Ba‍sh' }],
  ]
  for (const [name, over] of cases) {
    it(`${name}: shown as a marker, no hidden reason, Allow stays`, () => {
      expect(permissionHiddenReasons(req(over))).toEqual([])
      const c = compose(over)
      expect(permissionCardAllowsPrimary(c)).toBe(true)
      expect(c.warning).toBeUndefined()
      expect(`${c.title}${c.body}${c.fields[0]?.value}`).toMatch(/\[U\+[0-9A-F]{4,5}\]|⏎/)
    })
  }
  it('shows each such character visibly as [U+XXXX] in the body, summary and title', () => {
    const c = compose({ input_preview: 'a‮b', description: 'x​y', tool_name: 'T⁦' })
    expect(c.body).toBe('a[U+202E]b')
    expect(c.fields[0]?.value).toBe('x[U+200B]y')
    expect(c.title).toBe('Allow T[U+2066]?')
    expect(visibleText('\u{e0041}')).toBe('[U+E0041]')
    expect(visibleText('plain {"a": 1} [REDACTED] ✓')).toBe('plain {"a": 1} [REDACTED] ✓')
  })
  it('shows the right-to-left format characters that sit in front of numbers (U+0600-0604, U+070F, U+0890-0891)', () => {
    for (const cp of [0x600, 0x601, 0x602, 0x603, 0x604, 0x70f, 0x890, 0x891]) {
      const hex = cp.toString(16).toUpperCase().padStart(4, '0')
      expect(visibleText(`4417${String.fromCodePoint(cp)}1234`)).toBe(`4417[U+${hex}]1234`)
      const c = compose({ input_preview: `a${String.fromCodePoint(cp)}b`, description: 'd', tool_name: 'T' })
      expect(c.body).toBe(`a[U+${hex}]b`)
    }
  })
  it('ordinary non-ASCII text is not hidden', () => {
    expect(permissionHiddenReasons(req({ input_preview: '{"content": "Grüße, 東京 ✓"}' }))).toEqual([])
  })
})

describe('R1: the Claude Code version floor on the permission path', () => {
  it('is 2.1.234 (CC-C1-REVIEW F1: unserializable marker, channel-only prompts)', () => {
    expect(PERMISSION_MIN_CLIENT_VERSION).toBe('2.1.234')
  })
  for (const v of [undefined, '', '2.1.233', '2.1.211', '2.0.999', '1.9.400', 'claude-code', '2.1', 'v2.1.300']) {
    it(`client version ${JSON.stringify(v)}: deny-only, "Approve at the Mac"`, () => {
      expect(permissionClientVerified(v)).toBe(false)
      const c = compose({}, v ?? null)
      expect(permissionCardAllowsPrimary(c)).toBe(false)
      expect(c.warning).toBe(PERMISSION_OLD_CLIENT_WARNING)
    })
  }
  for (const v of ['2.1.234', '2.1.312', '2.2.0', '3.0.0', '2.1.312 (Claude Code)']) {
    it(`client version ${v}: Allow`, () => {
      expect(permissionClientVerified(v)).toBe(true)
      expect(permissionCardAllowsPrimary(compose({}, v))).toBe(true)
    })
  }
})

describe('L4: Allow also requires no summary line and the risk the tool implies', () => {
  const good = compose()
  it('a summary line removes Allow', () => {
    expect(permissionCardAllowsPrimary({ ...good, summary: 'Harmless' } as CardT)).toBe(false)
  })
  it('a lowered risk removes Allow', () => {
    expect(permissionCardAllowsPrimary({ ...good, risk: 'low' })).toBe(false)
  })
})

describe('R2: documented field names, real-shaped payloads', () => {
  it('$.session.usage() as the mods reference shapes it: percentUsed, resetsAt as ISO or epoch ms', () => {
    const f = fixture('session-usage.json')
    const r = sessionStateFromEngine(f.session, { source: 'mod', capabilities: [], at: AT })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.state.rate_limits).toEqual([
      { kind: 'five_hour', percent: 23.5, resets_at: '2026-10-29T15:00:00.000Z' },
      { kind: 'seven_day', percent: 41.2, resets_at: new Date(1793260800000).toISOString() },
    ])
    expect(r.state.context).toEqual({ tokens: 182000, window: 1000000, percent: 18.2 })
    expect(r.state.cost_usd).toBe(1.42)
  })
  it('an invented `percent` field is not read', () => {
    const r = sessionStateFromEngine(
      { id: 's1', usage: { rateLimits: [{ kind: 'five_hour', percent: 31 }] } },
      { source: 'mod', capabilities: [], at: AT },
    )
    expect(r.ok && r.state.rate_limits[0]?.percent).toBeUndefined()
  })
  it('the status line JSON from the statusline docs (verbatim sample)', () => {
    const f = fixture('statusline.json')
    const r = sessionStateFromStatusline(f.statusline, { at: AT })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = r.state
    expect(s.source).toBe('statusline')
    expect(s.capabilities).toEqual([])
    expect(s.model).toEqual({ id: 'claude-opus-5-5', display: 'Opus' })
    expect(s.effort).toBe('high')
    expect(s.context).toEqual({ window: 200000, percent: 8 })
    expect(s.cost_usd).toBe(0.01234)
    expect(s.rate_limits).toEqual([
      { kind: 'five_hour', percent: 23.5, resets_at: new Date(1738425600 * 1000).toISOString() },
      { kind: 'seven_day', percent: 41.2, resets_at: new Date(1738857600 * 1000).toISOString() },
      { kind: 'spend_limit', percent: 62.8, resets_at: new Date(1740787200 * 1000).toISOString() },
    ])
  })
  it('toIsoTs: ISO, epoch ms and epoch seconds; junk dropped', () => {
    expect(toIsoTs('2026-10-29T12:00:00.000Z')).toBe('2026-10-29T12:00:00.000Z')
    expect(toIsoTs(1738425600)).toBe('2025-02-01T16:00:00.000Z')
    expect(toIsoTs(1738425600000)).toBe('2025-02-01T16:00:00.000Z')
    for (const v of ['soon', -1, 0, Number.NaN, null, {}]) expect(toIsoTs(v)).toBeUndefined()
  })
})

describe('R3: controls are keyed on (source, name)', () => {
  const inventory: SessionInventoryT = {
    commands: inventoryCommandsFromEngine([
      { name: 'context', description: '/context', source: 'builtin' },
      { name: 'context', description: 'My context skill', source: 'user' },
      { name: 'usage', description: '/usage', source: 'builtin' },
    ]).commands,
    models: [],
    efforts: [],
    mcp_servers: [],
    plugins: [],
    at: AT,
  }
  const state: SessionStateT = {
    session_id: 's1',
    source: 'mod',
    capabilities: ['command'],
    busy: false,
    rate_limits: [],
    surfaces: [],
    at: AT,
  }
  const ctx: PaletteContext = { inventory, allowedModels: DEFAULT_SESSION_MODELS }
  const check = (over: Record<string, unknown>) =>
    checkSessionControl(
      { action: 'command', ts: AT, ...over },
      { now: NOW, state, inventory, allowedModels: DEFAULT_SESSION_MODELS },
    )
  it('a shadowed built-in is local_only in the inventory', () => {
    expect(inventory.commands.find((c) => c.name === 'context' && c.source === 'builtin')?.route).toBe('local_only')
    expect(inventory.commands.find((c) => c.name === 'usage')?.route).toBe('control')
  })
  it('the palette refuses the shadowed built-in and still sends the skill as a message', () => {
    expect(planPaletteRun({ source: 'builtin', name: 'context', args: '' }, ctx)).toMatchObject({
      ok: false,
      code: 'command_not_allowed',
    })
    expect(planPaletteRun({ source: 'user', name: 'context', args: '' }, ctx)).toEqual({
      ok: true,
      kind: 'message',
      text: '/context',
    })
  })
  it('the bridge refuses a shadowed built-in even with source builtin', () => {
    expect(check({ command: 'context', source: 'builtin' })).toMatchObject({ ok: false, code: 'command_not_allowed' })
  })
  it('the bridge refuses a command control with no source, or a non-builtin source', () => {
    expect(check({ command: 'usage' })).toMatchObject({ ok: false, code: 'command_not_allowed' })
    expect(check({ command: 'usage', source: 'user' })).toMatchObject({ ok: false, code: 'command_not_allowed' })
    expect(check({ command: 'usage', source: 'builtin' })).toEqual({ ok: true })
  })
})
