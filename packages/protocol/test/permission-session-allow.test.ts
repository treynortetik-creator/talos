// (`touch probe-N` here is only a synthetic hook input. Which commands Claude Code offers a rule for is its own choice and differs by version:
// on 2.1.332 `touch` and `rm -rf` got no rule, and `python3 -c "open('probe-N','w').close()"` did.)
// "Allow for this session" (Wave 1, item 1.10): a third choice on a permission card the hook raised, only when Claude Code offered
// a rule that names what it allows. The owner's signed tap carries `session: true`; the hook prints its own copy of Claude
// Code's rule with the destination forced to the session. Every new field is optional: an older app, bridge or hook behaves as before.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  Card,
  CardResolveFrame,
  cleanSessionRules,
  composePermissionCard,
  HubHubLine,
  HubPerm,
  OpenPermissionIds,
  permissionCardAllowsPrimary,
  SESSION_RULE_CONTENT_MAX,
  SESSION_RULES_MAX,
  sessionAllowWords,
  sessionRulesHash,
  validSessionOffer,
} from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const fixtures = loadFixtures()

const request = {
  request_id: 'abcde',
  tool_name: 'Bash',
  description: 'make a probe file',
  input_preview: '{"command":"touch probe-1"}',
}
const good = [{ tool: 'Bash', content: 'touch probe-*' }]
const compose = (extra: { session_allow?: { rules: unknown } } = {}) =>
  composePermissionCard({
    request,
    card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4B0',
    thread_id: 'general',
    now: 1_700_000_000_000,
    client_version: '2.1.312',
    ...(extra as object),
  })

describe('cleanSessionRules', () => {
  it('keeps a rule that has content', () => {
    expect(cleanSessionRules(good)).toEqual(good)
  })
  it('keeps up to the limit, and refuses more', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ tool: 'Bash', content: `touch p${i}-*` }))
    expect(cleanSessionRules(many(SESSION_RULES_MAX))).toHaveLength(SESSION_RULES_MAX)
    expect(cleanSessionRules(many(SESSION_RULES_MAX + 1))).toBeUndefined()
  })
  it('a rule with no content (a whole-tool allow) is refused', () => {
    expect(cleanSessionRules([{ tool: 'Bash' }])).toBeUndefined()
    expect(cleanSessionRules([{ tool: 'Bash', content: '' }])).toBeUndefined()
    expect(cleanSessionRules([{ tool: 'Bash', content: '   ' }])).toBeUndefined()
    expect(cleanSessionRules([...good, { tool: 'Bash' }])).toBeUndefined() // one bad rule refuses the whole offer
  })
  it('refuses, never cuts, a rule that is too long', () => {
    expect(cleanSessionRules([{ tool: 'Bash', content: 'a'.repeat(SESSION_RULE_CONTENT_MAX) }])).toHaveLength(1)
    expect(cleanSessionRules([{ tool: 'Bash', content: 'a'.repeat(SESSION_RULE_CONTENT_MAX + 1) }])).toBeUndefined()
    expect(cleanSessionRules([{ tool: 'B'.repeat(65), content: 'x' }])).toBeUndefined()
  })
  it('refuses line breaks, control, bidi, zero-width and lone-surrogate characters, and gap-padding blanks', () => {
    for (const bad of ['a\nb', 'a\tb', 'a\u0000b', 'a‮b', 'a​b', 'a\ud800b', 'a b', 'a　b'])
      expect(cleanSessionRules([{ tool: 'Bash', content: bad }])).toBeUndefined()
    expect(cleanSessionRules([{ tool: 'Ba\nsh', content: 'x' }])).toBeUndefined()
  })
  it('refuses anything that is not a list of {tool, content} text, and extra keys', () => {
    for (const bad of [
      undefined,
      null,
      'x',
      7,
      {},
      [],
      [null],
      [{ tool: 7, content: 'x' }],
      [{ tool: 'Bash', content: 7 }],
    ])
      expect(cleanSessionRules(bad)).toBeUndefined()
    expect(cleanSessionRules([{ tool: 'Bash', content: 'x', destination: 'userSettings' }])).toBeUndefined()
  })
})

describe('sessionAllowWords', () => {
  it('names what it allows, in plain words', () => {
    expect(sessionAllowWords(good)).toBe('Allow `touch probe-*` for the rest of this session')
  })
  it('names the tool when it is not a one-rule Bash offer, and lists several rules', () => {
    expect(sessionAllowWords([{ tool: 'WebFetch', content: 'domain:example.com' }])).toBe(
      'Allow WebFetch `domain:example.com` for the rest of this session',
    )
    expect(
      sessionAllowWords([
        { tool: 'Bash', content: 'ls *' },
        { tool: 'Bash', content: 'cat *' },
      ]),
    ).toBe('Allow `ls *` and `cat *` for the rest of this session')
  })
})

describe('the session_allow card field', () => {
  it('a card made without it is exactly the card as before', () => {
    const c = compose()
    expect('session_allow' in c).toBe(false)
    expect(Card.safeParse(c).success).toBe(true)
  })
  it('a card with it keeps its hash and payload, still allows Allow', () => {
    const plain = compose()
    const c = compose({ session_allow: { rules: good } })
    expect(c.session_allow).toEqual({ rules: good })
    expect(c.payload_hash).toBe(plain.payload_hash)
    expect(c.payload).toEqual(plain.payload)
    expect(Card.safeParse(c).success).toBe(true)
    expect(permissionCardAllowsPrimary(c)).toBe(true)
  })
  it('an offer the composer refuses leaves the card without the field', () => {
    for (const bad of [[{ tool: 'Bash' }], [{ tool: 'Bash', content: 'a\nb' }], []])
      expect('session_allow' in compose({ session_allow: { rules: bad } })).toBe(false)
  })
  it("a rule for another tool than the call's own is refused", () => {
    expect('session_allow' in compose({ session_allow: { rules: [{ tool: 'Write', content: '*' }] } })).toBe(false)
  })
  it('a value a reader does not know reads as unset', () => {
    for (const junk of ['yes', { rules: 'x' }, { rules: [] }, 7]) {
      const r = Card.safeParse({ ...compose(), session_allow: junk })
      expect(r.success).toBe(true)
      if (r.success) expect(r.data.session_allow).toBeUndefined()
    }
  })
})

describe('card.resolve and the hub lines', () => {
  const base = fixtures['card.resolve'] as Record<string, unknown>
  it('an old tap with no session still parses', () => {
    expect(CardResolveFrame.safeParse({ ...base, action: 'primary' }).success).toBe(true)
  })
  it('session: true parses and is kept; anything else does not parse', () => {
    const ok = CardResolveFrame.safeParse({ ...base, action: 'primary', session: true })
    expect(ok.success).toBe(true)
    if (ok.success) expect((ok.data as { session?: true }).session).toBe(true)
    expect(CardResolveFrame.safeParse({ ...base, action: 'primary', session: false }).success).toBe(false)
    expect(CardResolveFrame.safeParse({ ...base, action: 'primary', session: 'yes' }).success).toBe(false)
  })
  it('perm: an older hook sends no suggest; a junk suggest reads as none', () => {
    const line = { t: 'perm', id: 'h_1', tool_name: 'Bash' }
    expect(HubPerm.safeParse(line).success).toBe(true)
    const ok = HubPerm.safeParse({ ...line, suggest: { rules: good } })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.suggest).toEqual({ rules: good })
    const junk = HubPerm.safeParse({ ...line, suggest: 'yes' })
    expect(junk.success).toBe(true)
    if (junk.success) expect(junk.data.suggest).toBeUndefined()
  })
  it('perm_result: the old shape parses; session is true or nothing', () => {
    const line = { t: 'perm_result', id: 'h_1', decision: 'allow', reason: 'owner' }
    expect(HubHubLine.safeParse(line).success).toBe(true)
    const ok = HubHubLine.safeParse({ ...line, session: true })
    expect(ok.success).toBe(true)
    if (ok.success) expect((ok.data as { session?: true }).session).toBe(true)
    const junk = HubHubLine.safeParse({ ...line, session: 'yes' })
    expect(junk.success).toBe(true)
    if (junk.success) expect((junk.data as { session?: unknown }).session).toBeUndefined()
  })
})

describe('content that is only wildcards is a whole-tool allow, and is refused', () => {
  const one = (content: string) => cleanSessionRules([{ tool: 'Bash', content }])
  it.each([
    '*',
    '**',
    ':*',
    '* *',
    '*:*',
    '?',
    '*?',
    ' * ',
    '/',
    '//**',
    '/**',
    '**/*',
    ':',
    'domain:*',
    'domain:',
    'DOMAIN:*',
    'domain: *',
    'domain:*.example.com',
  ])('refuses %j', (content) => {
    expect(one(content)).toBeUndefined()
  })
  it.each([
    'touch probe-*',
    'ls *',
    'npm:*',
    'git status',
    'domain:example.com',
    '/home/alex/proj/**',
    '//home/**',
    'a*',
    'rm probe-1',
  ])('keeps %j (a literal character comes before the first wildcard)', (content) => {
    expect(one(content)).toHaveLength(1)
  })
  it('one wildcard-only rule refuses the whole offer', () => {
    expect(cleanSessionRules([...good, { tool: 'Bash', content: '*' }])).toBeUndefined()
  })
  it('the composer leaves such an offer off the card', () => {
    for (const content of ['*', ':*', '* *', '//**'])
      expect('session_allow' in compose({ session_allow: { rules: [{ tool: 'Bash', content }] } })).toBe(false)
  })
})

describe('sessionRulesHash: what the owner signs is the rules the button shows', () => {
  const hex = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
  it('is the sha256 of the canonical list of {content, tool}', () => {
    expect(sessionRulesHash(good)).toBe(hex('[{"content":"touch probe-*","tool":"Bash"}]'))
  })
  it('does not depend on the order the keys were written in', () => {
    const swapped = [{ content: 'touch probe-*', tool: 'Bash' }]
    expect(sessionRulesHash(swapped)).toBe(sessionRulesHash(good))
  })
  it('changes with any word of any rule, the tool, the order, or an extra rule', () => {
    const a = { tool: 'Bash', content: 'ls *' }
    const b = { tool: 'Bash', content: 'cat *' }
    const h = sessionRulesHash([a, b])
    expect(sessionRulesHash([a])).not.toBe(h)
    expect(sessionRulesHash([b, a])).not.toBe(h)
    expect(sessionRulesHash([a, { tool: 'Bash', content: 'cat **' }])).not.toBe(h)
    expect(sessionRulesHash([{ tool: 'Read', content: 'ls *' }, b])).not.toBe(h)
  })
  it('is a sha256 reference for quotes, backslashes and non-Latin text (the hook has a Python twin that must agree)', () => {
    const rules = [{ tool: 'Bash', content: 'echo "a\b" é 日本 \u{1F600}*' }]
    expect(sessionRulesHash(rules)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('the signed session_hash', () => {
  const base = fixtures['card.resolve'] as Record<string, unknown>
  const h = sessionRulesHash(good)
  it('card.resolve takes a session_hash beside session: true, and keeps it', () => {
    const ok = CardResolveFrame.safeParse({ ...base, action: 'primary', session: true, session_hash: h })
    expect(ok.success).toBe(true)
    if (ok.success) expect((ok.data as { session_hash?: string }).session_hash).toBe(h)
  })
  it('a session_hash that is not a sha256 reference does not parse', () => {
    for (const bad of ['x', 'sha256:abc', 7, ''])
      expect(CardResolveFrame.safeParse({ ...base, action: 'primary', session: true, session_hash: bad }).success).toBe(
        false,
      )
  })
  it('an old tap with session and no hash still parses (the bridge then grants no session rule)', () => {
    expect(CardResolveFrame.safeParse({ ...base, action: 'primary', session: true }).success).toBe(true)
  })
  it('perm_result carries session_hash beside session; anything else reads as none', () => {
    const line = { t: 'perm_result', id: 'h_1', decision: 'allow', reason: 'owner', session: true }
    const ok = HubHubLine.safeParse({ ...line, session_hash: h })
    expect(ok.success).toBe(true)
    if (ok.success) expect((ok.data as { session_hash?: string }).session_hash).toBe(h)
    const junk = HubHubLine.safeParse({ ...line, session_hash: 7 })
    expect(junk.success).toBe(true)
    if (junk.success) expect((junk.data as { session_hash?: unknown }).session_hash).toBeUndefined()
  })
})

describe('validSessionOffer: the one check the composer and the relay both use', () => {
  it('keeps a clean offer for the call’s own tool', () => {
    expect(validSessionOffer('Bash', good)).toEqual(good)
  })
  it.each([
    ['a whole-tool rule', [{ tool: 'Bash' }]],
    ['wildcards only', [{ tool: 'Bash', content: '*' }]],
    ['another tool', [{ tool: 'Write', content: 'x*' }]],
    ['a hidden character', [{ tool: 'Bash', content: 'ls ‮*' }]],
    ['too many rules', [1, 2, 3, 4].map((i) => ({ tool: 'Bash', content: `ls ${i}*` }))],
    ['not a list', 'x'],
    ['nothing', undefined],
  ])('refuses %s', (_why, rules) => {
    expect(validSessionOffer('Bash', rules)).toBeUndefined()
  })
  it('agrees with the composer: a card has session_allow exactly when the offer is valid', () => {
    for (const rules of [good, [{ tool: 'Bash', content: '*' }], [{ tool: 'Write', content: 'x*' }], 'x']) {
      const offered = validSessionOffer('Bash', rules) !== undefined
      expect('session_allow' in compose({ session_allow: { rules } })).toBe(offered)
    }
  })
})

describe('OpenPermissionIds.reopen: raising the card again for the SAME prompt is not a repeat', () => {
  it('a closed id opens again without being marked repeated, and a real repeat afterwards still is', () => {
    const ids = new OpenPermissionIds()
    expect(ids.add('abcde')).toEqual({ repeated: false })
    ids.close('abcde')
    ids.reopen('abcde')
    expect(ids.isOpen('abcde')).toBe(true)
    expect(ids.size).toBe(1)
    expect(ids.add('abcde')).toEqual({ repeated: true }) // a second prompt with this id is still poisoned
    expect(ids.isOpen('abcde')).toBe(false)
  })
  it('an id never seen is opened and seen', () => {
    const ids = new OpenPermissionIds()
    ids.reopen('fghij')
    expect(ids.isOpen('fghij')).toBe(true)
    expect(ids.hasSeen('fghij')).toBe(true)
  })
})
