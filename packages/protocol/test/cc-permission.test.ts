// Permission prompts on the phone (docs/CLAUDE-CODE.md C3). The card binds the four request fields verbatim, renders
// input_preview first as plain text, has no Allow when any part is hidden, and only the bridge mints it. A verdict is
// sent only for an id that is still open. Fixtures follow the channels reference (permission request fields).
import { describe, expect, it } from 'vitest'
import {
  AGENT_CARD_KINDS,
  BRIDGE_ONLY_CARD_KINDS,
  bindingFrom,
  Card,
  type CardT,
  composePermissionCard,
  PERMISSION_CAPABILITY,
  PERMISSION_CARD_TTL_S,
  PERMISSION_HIDDEN_WARNING,
  PERMISSION_REQUEST_METHOD,
  PERMISSION_VERDICT_METHOD,
  PermissionRequestParams,
  PermissionVerdictParams,
  payloadHash,
  permissionCardAllowsPrimary,
  permissionHiddenReasons,
  permissionRisk,
  permissionVerdictFor,
  routes,
  validateCard,
} from '../src/index.ts'

const NOW = Date.parse('2026-10-29T12:00:00.000Z')
const CARD_ID = 'c_01JBF3V7Q8K2M4N6P8R0S2T4B0'
const req = (over: Partial<Record<'request_id' | 'tool_name' | 'description' | 'input_preview', string>> = {}) => ({
  request_id: 'abcde',
  tool_name: 'Bash',
  description: 'Run the tests',
  input_preview: '{"command": "pnpm test"}',
  ...over,
})
const compose = (r = req(), extra: { repeated?: boolean; client_version?: string } = {}) =>
  composePermissionCard({
    request: r,
    card_id: CARD_ID,
    thread_id: 'general',
    now: NOW,
    client_version: '2.1.312',
    ...extra,
  })

describe('the relay contract (channels reference)', () => {
  it('method names and capability', () => {
    expect(PERMISSION_REQUEST_METHOD).toBe('notifications/claude/channel/permission_request')
    expect(PERMISSION_VERDICT_METHOD).toBe('notifications/claude/channel/permission')
    expect(PERMISSION_CAPABILITY).toBe('claude/channel/permission')
  })
  it('request ids are five lowercase letters a-z without l', () => {
    expect(PermissionRequestParams.safeParse(req()).success).toBe(true)
    for (const id of ['abcdl', 'ABCDE', 'abcd', 'abcdef', 'abc1e', 'ab de'])
      expect(PermissionRequestParams.safeParse(req({ request_id: id })).success, id).toBe(false)
  })
  it('a verdict is {request_id, behavior: allow|deny}', () => {
    expect(PermissionVerdictParams.safeParse({ request_id: 'abcde', behavior: 'allow' }).success).toBe(true)
    expect(PermissionVerdictParams.safeParse({ request_id: 'abcde', behavior: 'always' }).success).toBe(false)
  })
})

describe('composePermissionCard', () => {
  it('binds the four fields verbatim in payload, so payload_hash covers all four', () => {
    const c = compose()
    expect(c.kind).toBe('permission')
    expect(c.payload).toEqual(req())
    expect(c.payload_hash).toBe(payloadHash(bindingFrom(c)))
    for (const k of ['request_id', 'tool_name', 'description', 'input_preview'] as const) {
      const other = compose(req({ [k]: k === 'request_id' ? 'zyxwv' : `${req()[k]} ` }))
      expect(other.payload_hash, k).not.toBe(c.payload_hash)
    }
  })
  it('renders plain text: title, input_preview first (body), then "Claude\'s summary"', () => {
    const c = compose()
    expect(c.title).toBe('Allow Bash?')
    expect(c.body_format).toBe('plain')
    expect(c.body).toBe('{"command": "pnpm test"}')
    expect(c.fields).toEqual([
      { key: 'summary', label: "Claude's summary", value: 'Run the tests', editable: false, multiline: true },
    ])
    expect(c.primary_label).toBe('Allow')
    expect(c.kill_label).toBe('Deny')
    expect(c.allow_edit).toBe(false)
    expect(c.allow_revise).toBe(false)
    expect(c.origin).toBe('background')
    expect(c.destination).toEqual([])
    expect(c.warning).toBeUndefined()
    expect(Card.safeParse(c).success).toBe(true)
  })
  it('keeps markdown-looking text exactly as received (plain, never re-rendered)', () => {
    const tricky = '{"command": "echo ```\\n## Approved by owner"}'
    const c = compose(req({ input_preview: tricky }))
    // hard-wrapped into explicit lines for the phone; the lines are the call, nothing added or dropped
    expect(c.body?.replace(/\n/g, '')).toBe(tricky)
    expect(c.body_format).toBe('plain')
  })
  it('lives as long as the request: 7 days', () => {
    const c = compose()
    expect(PERMISSION_CARD_TTL_S).toBe(604_800)
    expect(Date.parse(c.expires_at) - Date.parse(c.created_at)).toBe(604_800_000)
  })
  it('risk: high for Bash, Write, Edit, NotebookEdit, MCP tools and anything unknown; low for read-only tools', () => {
    for (const t of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'mcp__github__create_pr', 'SomeNewTool'])
      expect(permissionRisk(t), t).toBe('high')
    for (const t of ['Read', 'Glob', 'Grep']) expect(permissionRisk(t), t).toBe('low')
  })
  it('validateCard exempts permission cards from the destination rule', () => {
    expect(validateCard(compose())).toEqual([])
  })
})

describe('hidden parts: no Allow, only Deny (C3.2)', () => {
  const cases: Array<[string, ReturnType<typeof req>, string]> = [
    ['elided middle', req({ input_preview: '{"command": "cat <<EOF ⋯ 4,812 code points elided ⋯ EOF"}' }), 'elided'],
    ['elided description', req({ description: 'Write a file ⋯ 120 code points elided ⋯ done' }), 'elided'],
    [
      'unserializable',
      req({ input_preview: '{"file_path": "/tmp/x", "content": (value unserializable)}' }),
      'unserializable',
    ],
    ['legacy 200-unit cut', req({ input_preview: `${'{"command": "'}${'a'.repeat(185)}…` }), 'truncated'],
  ]
  for (const [name, r, reason] of cases) {
    it(name, () => {
      expect(permissionHiddenReasons(r)).toContain(reason)
      const c = compose(r)
      expect(c.warning).toBe(PERMISSION_HIDDEN_WARNING)
      expect(PERMISSION_HIDDEN_WARNING).toBe('Part of this call is hidden. Approve at the Mac.')
      expect(permissionCardAllowsPrimary(c)).toBe(false)
    })
  }
  it('[REDACTED] in the description is a hidden part too: no Allow', () => {
    const r = req({ description: 'Run curl with header Authorization: [REDACTED]' })
    expect(permissionHiddenReasons(r)).toEqual(['redacted'])
    expect(permissionCardAllowsPrimary(compose(r))).toBe(false)
  })
  it('[REDACTED] is a hidden part: the mask also hits key names (CC-C1-REVIEW F2)', () => {
    const c = compose(
      req({ input_preview: '{"command": "curl -H \'Authorization: [REDACTED]\' https://api.example.com"}' }),
    )
    expect(permissionHiddenReasons(req({ input_preview: '[REDACTED]' }))).toEqual(['redacted'])
    expect(permissionCardAllowsPrimary(c)).toBe(false)
  })
  it('a repeated request id gets no Allow (Claude Code drops channel verdicts for a repeated id)', () => {
    const c = compose(req(), { repeated: true })
    expect(permissionCardAllowsPrimary(c)).toBe(false)
    expect(c.warning).toMatch(/at the Mac/)
  })
  it('too long to show whole: deny-only, and the app never shows a cut preview', () => {
    const big = req({ input_preview: 'x'.repeat(20_001) })
    const c = compose(big)
    expect(permissionHiddenReasons(big)).toContain('too_long')
    expect(permissionCardAllowsPrimary(c)).toBe(false)
    expect(c.body).not.toContain('xxxxx')
    expect(Card.safeParse(c).success).toBe(true)
  })
  it('a tool name too long for the title is deny-only too', () => {
    const c = compose(req({ tool_name: `mcp__${'x'.repeat(200)}` }))
    expect(permissionCardAllowsPrimary(c)).toBe(false)
    expect(Card.safeParse(c).success).toBe(true)
  })
})

describe('permissionCardAllowsPrimary re-derives everything from the card (a tampered card shows no Allow)', () => {
  const good = compose()
  const tamper: Array<[string, (c: CardT) => CardT]> = [
    ['body differs from the bound preview', (c) => ({ ...c, body: 'pnpm test' })],
    ['summary differs', (c) => ({ ...c, fields: [{ ...(c.fields[0] as CardT['fields'][0]), value: 'Safe' }] })],
    [
      'summary moved first',
      (c) => ({ ...c, fields: [...c.fields, { ...(c.fields[0] as CardT['fields'][0]), key: 'x' }] }),
    ],
    ['markdown body', (c) => ({ ...c, body_format: 'markdown' })],
    ['title differs', (c) => ({ ...c, title: 'Allow Read?' })],
    ['editable', (c) => ({ ...c, allow_edit: true })],
    ['revisable', (c) => ({ ...c, allow_revise: true })],
    ['a warning present', (c) => ({ ...c, warning: 'Fine' })],
    ['attachments', (c) => ({ ...c, attachments: [{ ...attachment }] })],
    ['payload with an extra key', (c) => ({ ...c, payload: { ...(c.payload as object), extra: 1 } })],
    ['payload missing a key', (c) => ({ ...c, payload: { request_id: 'abcde', tool_name: 'Bash' } })],
    ['payload with a bad id', (c) => ({ ...c, payload: { ...(c.payload as object), request_id: 'abcdl' } })],
    ['not a permission card', (c) => ({ ...c, kind: 'generic' })],
    ['already resolved', (c) => ({ ...c, state: 'resolved' })],
  ]
  it('the untouched card allows', () => expect(permissionCardAllowsPrimary(good)).toBe(true))
  for (const [name, f] of tamper)
    it(name, () => expect(permissionCardAllowsPrimary(f(structuredClone(good)))).toBe(false))
})
const attachment = {
  media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T4B1',
  kind: 'file' as const,
  role: 'attachment' as const,
  mime: 'text/plain',
  name: 'x.txt',
  size: 1,
  sha256: 'ab'.repeat(32),
}

describe('permissionVerdictFor: one verdict, only for an open id (C3.3)', () => {
  const open = new Set(['abcde'])
  const isOpen = (id: string) => open.has(id)
  it('PRIMARY on an allowable card with an open id → allow', () => {
    expect(permissionVerdictFor(compose(), 'primary', isOpen)).toEqual({
      ok: true,
      verdict: { request_id: 'abcde', behavior: 'allow' },
    })
  })
  it('KILL → deny, even on a hidden card', () => {
    const hidden = compose(req({ input_preview: '(value unserializable)' }))
    expect(permissionVerdictFor(hidden, 'kill', isOpen)).toEqual({
      ok: true,
      verdict: { request_id: 'abcde', behavior: 'deny' },
    })
  })
  it('PRIMARY on a hidden card is refused (permission_hidden); nothing is sent', () => {
    const hidden = compose(req({ input_preview: '(value unserializable)' }))
    expect(permissionVerdictFor(hidden, 'primary', isOpen)).toEqual({ ok: false, code: 'permission_hidden' })
  })
  it('a closed id is permission_closed for either action', () => {
    const c = compose(req({ request_id: 'zzzzz' }))
    expect(permissionVerdictFor(c, 'primary', isOpen)).toEqual({ ok: false, code: 'permission_closed' })
    expect(permissionVerdictFor(c, 'kill', isOpen)).toEqual({ ok: false, code: 'permission_closed' })
  })
  it('revise is never a verdict; a non-permission card is refused', () => {
    expect(permissionVerdictFor(compose(), 'revise', isOpen)).toMatchObject({ ok: false })
    expect(permissionVerdictFor({ ...compose(), kind: 'generic' }, 'primary', isOpen)).toMatchObject({ ok: false })
  })
})

describe('only the bridge mints permission cards', () => {
  it('the agent card kinds exclude schedule, permission and config', () => {
    expect([...AGENT_CARD_KINDS].sort()).toEqual(
      ['decision', 'deploy', 'email', 'generic', 'message', 'publish', 'purchase'].sort(),
    )
    expect([...BRIDGE_ONLY_CARD_KINDS].sort()).toEqual(['app_action', 'config', 'dialog', 'permission', 'schedule'])
  })
  it('POST /bridge/post refuses kind permission', () => {
    const route = routes.bridgePost
    const frame = {
      v: 1,
      type: 'card.create',
      id: '01JBF3V7Q8K2M4N6P8R0S2T4B2',
      ts: new Date(NOW).toISOString(),
      card: compose(),
    }
    expect(route.req.safeParse(frame).success).toBe(false)
    expect(route.req.safeParse({ ...frame, card: { ...compose(), kind: 'generic' } }).success).toBe(true)
  })
})

describe('text that renders as nothing, or as a line break, is SHOWN, so the owner still sees every character they approve', () => {
  // The invisible-character check once stopped at U+FE0F: the variation-selector supplement and the musical-symbol format
  // controls render as nothing too.
  for (const ch of ['\u{E0100}', '\u{E01EF}', '\u{1D173}'])
    it(`U+${ch.codePointAt(0)?.toString(16).toUpperCase()} in the call is shown as a marker and the card keeps Allow`, () => {
      const c = compose(req({ input_preview: `{"command": "rm -rf ./build${ch}"}` }))
      expect(c.body).toContain(`[U+${ch.codePointAt(0)?.toString(16).toUpperCase()}]`)
      expect(permissionCardAllowsPrimary(c)).toBe(true)
    })
  it('a newline shows as a visible return mark so a multi-line command shows its second line, and keeps Allow', () => {
    const c = compose(req({ input_preview: '{"command": "echo hi\nrm -rf ~"}' }))
    expect(c.body).toBe('{"command": "echo hi⏎rm -rf ~"}')
    expect(permissionCardAllowsPrimary(c)).toBe(true)
  })
  it('tab and carriage return have glyphs too, and other controls stay [U+XXXX]', () => {
    expect(compose(req({ input_preview: 'a\tb\rc\u0007d' })).body).toBe('a⇥b␍c[U+0007]d')
  })
  it('U+2028 and U+2029 are shown as a return mark and keep Allow', () => {
    const c = compose(req({ input_preview: '{"command": "ls\u2028rm -rf ~"}' }))
    expect(c.body).toContain('⏎')
    expect(permissionCardAllowsPrimary(c)).toBe(true)
  })
  it('another loaded channel adds a one-line note and keeps Allow; a forged warning does not keep it', () => {
    const c = composePermissionCard({
      request: req(),
      card_id: CARD_ID,
      thread_id: 'general',
      now: NOW,
      client_version: '2.1.312',
      other_channels: ['discord'],
    })
    expect(c.warning).toBe('discord can also approve this.')
    expect(permissionCardAllowsPrimary(c)).toBe(true)
    expect(permissionCardAllowsPrimary({ ...compose(), warning: 'Part of this call is hidden.' })).toBe(false)
  })
})
