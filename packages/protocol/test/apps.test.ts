// MCP Apps protocol (AP0). Every claim in the PR maps to a test here; see the PR body.
import { describe, expect, it } from 'vitest'
import {
  APP_BRIDGE_GRACE_MS,
  APP_CARD_EXPIRY_MS,
  APP_CLIENT_CEILING_MS,
  APP_CSP_HEADER_MAX,
  AppCsp,
  AppErrorCode,
  AppPendingRequest,
  AppToRelay,
  AppView,
  appCspFor,
  appMessageProblem,
  approvalKey,
  BridgeToRelay,
  buildAppCsp,
  Card,
  CardCreateFrame,
  CONSUMABLE_FRAME_TYPES,
  cspRelayHostProblem,
  DIRECTION_TYPES,
  DURABLE_FRAME_TYPES,
  decodeAppCspHeader,
  encodeAppCspHeader,
  fromSpecCsp,
  isAgentCardKind,
  isAppMessage,
  isAppRequestFresh,
  jcsBytes,
  McpCallToolResult,
  Message,
  OWNER_FRAME_TYPES,
  parseFrame,
  RelayToApp,
  RelayToBridge,
  routes,
  toSpecCsp,
  verifyOwnerFrame,
} from '../src/index.ts'
import { loadFixtures, loadTestKey } from './helpers.ts'

const fixtures = loadFixtures()
const clone = <T>(v: T): T => structuredClone(v)
const RELAY = 'https://relay.example.com'
const H256 = `sha256-${'A'.repeat(43)}=`

type Csp = Record<
  | 'connect_domains'
  | 'resource_domains'
  | 'frame_domains'
  | 'base_uri_domains'
  | 'script_hashes'
  | 'script_urls'
  | 'style_urls',
  string[]
>
const goodCsp = (): Csp => ({
  connect_domains: ['https://api.example.com'],
  resource_domains: ['https://cdn.example.com'],
  frame_domains: [],
  base_uri_domains: [],
  script_hashes: [H256],
  script_urls: ['https://cdn.example.com/lib/app.js'],
  style_urls: ['https://cdn.example.com/app.css'],
})

describe('AppCsp', () => {
  it('accepts a good policy', () => {
    expect(AppCsp.safeParse(goodCsp()).success).toBe(true)
  })

  const bad: Array<[string, (c: ReturnType<typeof goodCsp>) => void]> = [
    ["'unsafe-eval'", (c) => c.connect_domains.push("'unsafe-eval'")],
    ['bare *', (c) => c.connect_domains.push('*')],
    ['https://*', (c) => c.connect_domains.push('https://*')],
    ['*.com', (c) => c.connect_domains.push('https://*.com')],
    ['wildcard of one label', (c) => c.connect_domains.push('https://*.co')],
    ['http://', (c) => c.connect_domains.push('http://api.example.com')],
    ['data:', (c) => c.resource_domains.push('data:')],
    ['blob:', (c) => c.resource_domains.push('blob:')],
    ["'self'", (c) => c.connect_domains.push("'self'")],
    ['a path in a domain list', (c) => c.connect_domains.push('https://api.example.com/v1')],
    ['a trailing slash', (c) => c.connect_domains.push('https://api.example.com/')],
    ['a query in a pinned url', (c) => c.script_urls.push('https://cdn.example.com/a.js?x=1')],
    ['a fragment in a pinned url', (c) => c.script_urls.push('https://cdn.example.com/a.js#x')],
    ['a dot segment in a pinned url', (c) => c.script_urls.push('https://cdn.example.com/a/../b.js')],
    ['a single-dot segment in a pinned url', (c) => c.script_urls.push('https://cdn.example.com/./b.js')],
    ['a pinned url without a path', (c) => c.script_urls.push('https://cdn.example.com')],
    ['http in a pinned url', (c) => c.style_urls.push('http://cdn.example.com/a.css')],
    ['a semicolon', (c) => c.connect_domains.push('https://a.example.com;script-src *')],
    ['a comma', (c) => c.connect_domains.push('https://a.example.com,https://b.example.com')],
    ['a space', (c) => c.connect_domains.push('https://a.example.com https://b.example.com')],
    ['a quote', (c) => c.connect_domains.push("https://a.example.com'")],
    ['a newline', (c) => c.connect_domains.push('https://a.example.com\nscript-src *')],
    ['an IPv4 literal', (c) => c.connect_domains.push('https://10.0.0.1')],
    ['an IPv4 literal with a port', (c) => c.connect_domains.push('https://192.168.1.10:8443')],
    ['an IPv6 literal', (c) => c.connect_domains.push('https://[::1]')],
    ['localhost', (c) => c.connect_domains.push('https://localhost')],
    ['upper case', (c) => c.connect_domains.push('https://API.example.com')],
    ['port 99999', (c) => c.connect_domains.push('https://api.example.com:99999')],
    ['port 0', (c) => c.connect_domains.push('https://api.example.com:0')],
    ['17 entries', (c) => (c.connect_domains = Array.from({ length: 17 }, (_, i) => `https://a${i}.example.com`))],
    ['65 hashes', (c) => (c.script_hashes = Array.from({ length: 65 }, () => H256))],
    ['a short hash', (c) => c.script_hashes.push('sha256-AAAA')],
    ['a hash with a quote', (c) => c.script_hashes.push(`sha256-${'A'.repeat(43)}'`)],
    ['a sha256 hash of the wrong length', (c) => c.script_hashes.push(`sha256-${'A'.repeat(60)}=`)],
    ['an unknown key (strict)', (c) => Object.assign(c, { worker_domains: [] })],
  ]
  for (const [name, mutate] of bad) {
    it(`rejects ${name}`, () => {
      const c = goodCsp()
      mutate(c)
      expect(AppCsp.safeParse(c).success).toBe(false)
    })
  }

  it('rejects a non-object and a missing list', () => {
    expect(AppCsp.safeParse(null).success).toBe(false)
    const { connect_domains: _c, ...rest } = goodCsp()
    expect(AppCsp.safeParse(rest).success).toBe(false)
  })

  it('accepts a wildcard with two labels after it, a port, wss and sha384/sha512 hashes', () => {
    const c = goodCsp()
    c.connect_domains.push('https://*.api.example.com', 'wss://live.example.com:8443')
    c.script_hashes.push(`sha384-${'B'.repeat(64)}`, `sha512-${'C'.repeat(86)}==`)
    expect(AppCsp.safeParse(c).success).toBe(true)
  })
})

describe('relay host refinement (scan and relay share it)', () => {
  const withEntry = (list: 'connect_domains' | 'frame_domains' | 'resource_domains', entry: string) => {
    const c = goodCsp()
    c[list].push(entry)
    return c
  }
  it('refuses the relay host in any list, with or without a port, and in a pinned url', () => {
    for (const list of ['connect_domains', 'frame_domains', 'resource_domains'] as const) {
      expect(cspRelayHostProblem(withEntry(list, 'https://relay.example.com'), RELAY)).toBe('https://relay.example.com')
      expect(cspRelayHostProblem(withEntry(list, 'wss://relay.example.com:8443'), RELAY)).toBeDefined()
    }
    const c = goodCsp()
    c.script_urls.push('https://relay.example.com/x.js')
    expect(cspRelayHostProblem(c, RELAY)).toBeDefined()
  })
  it('refuses a wildcard that covers the relay host, and one that covers it at depth', () => {
    expect(cspRelayHostProblem(withEntry('connect_domains', 'https://*.example.com'), RELAY)).toBeDefined()
    expect(
      cspRelayHostProblem(withEntry('connect_domains', 'https://*.example.com'), 'https://a.b.example.com'),
    ).toBeDefined()
  })
  it('allows a sibling and a longer lookalike', () => {
    expect(cspRelayHostProblem(withEntry('connect_domains', 'https://api.example.com'), RELAY)).toBeUndefined()
    expect(cspRelayHostProblem(withEntry('connect_domains', 'https://notrelay.example.com'), RELAY)).toBeUndefined()
    expect(cspRelayHostProblem(withEntry('connect_domains', 'https://*.other-example.com'), RELAY)).toBeUndefined()
    expect(cspRelayHostProblem(goodCsp(), RELAY)).toBeUndefined()
  })
  it('accepts the relay origin as a bare host, with a port, and in upper case', () => {
    const c = withEntry('connect_domains', 'https://relay.example.com')
    expect(cspRelayHostProblem(c, 'relay.example.com')).toBeDefined()
    expect(cspRelayHostProblem(c, 'https://relay.example.com:8443')).toBeDefined()
    expect(cspRelayHostProblem(c, 'https://RELAY.EXAMPLE.COM')).toBeDefined()
  })
  it('throws on an unreadable relay origin instead of passing everything', () => {
    expect(() => cspRelayHostProblem(goodCsp(), '')).toThrow()
    expect(() => cspRelayHostProblem(goodCsp(), 'https://')).toThrow()
  })
  it('appCspFor wires it into a schema', () => {
    const schema = appCspFor(RELAY)
    expect(schema.safeParse(goodCsp()).success).toBe(true)
    expect(schema.safeParse(withEntry('connect_domains', 'https://*.example.com')).success).toBe(false)
  })
})

describe('buildAppCsp', () => {
  it('equals the expected string byte for byte', () => {
    expect(buildAppCsp(goodCsp())).toBe(
      [
        "default-src 'none'",
        `script-src '${H256}' https://cdn.example.com/lib/app.js`,
        "style-src 'unsafe-inline' https://cdn.example.com/app.css",
        'img-src data: blob: https://cdn.example.com',
        'font-src data: https://cdn.example.com',
        'media-src data: blob: https://cdn.example.com',
        'connect-src https://api.example.com',
        "frame-src 'none'",
        "base-uri 'none'",
        "worker-src 'none'",
        "form-action 'none'",
        "object-src 'none'",
      ].join('; '),
    )
  })
  it("an empty policy falls back to 'none' and never gains unsafe-inline in script-src", () => {
    const empty = {
      connect_domains: [],
      resource_domains: [],
      frame_domains: [],
      base_uri_domains: [],
      script_hashes: [],
      script_urls: [],
      style_urls: [],
    }
    const out = buildAppCsp(empty)
    expect(out).toBe(
      "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; worker-src 'none'; form-action 'none'; object-src 'none'",
    )
    const scriptSrc = out.split('; ').find((d) => d.startsWith('script-src')) as string
    expect(scriptSrc).not.toContain('unsafe-inline')
    expect(scriptSrc).not.toContain('unsafe-eval')
    expect(scriptSrc).not.toContain("'self'")
  })
  it('never lets a domain list reach script-src', () => {
    const c = goodCsp()
    const scriptSrc = buildAppCsp(c)
      .split('; ')
      .find((d) => d.startsWith('script-src')) as string
    expect(scriptSrc).not.toContain('api.example.com')
    expect(scriptSrc).not.toContain('https://cdn.example.com ')
  })
  it('refuses to build from a hand-made object that smuggles a directive', () => {
    const c = goodCsp()
    c.connect_domains.push('https://a.example.com; script-src *')
    expect(() => buildAppCsp(c)).toThrow()
  })
  it('is deterministic under concurrent callers', async () => {
    const outs = await Promise.all(Array.from({ length: 200 }, async () => buildAppCsp(goodCsp())))
    expect(new Set(outs).size).toBe(1)
  })
})

describe('toSpecCsp / fromSpecCsp', () => {
  it('round-trips the domain lists', () => {
    const c = goodCsp()
    const r = fromSpecCsp(toSpecCsp(c))
    expect(r.problems).toEqual([])
    expect(r.csp.connect_domains).toEqual(c.connect_domains)
    expect(r.csp.resource_domains).toEqual(c.resource_domains)
    expect(r.csp.script_hashes).toEqual([])
  })
  it('lower-cases, and reports (never drops silently) every bad entry', () => {
    const r = fromSpecCsp({
      connectDomains: ['https://API.Example.com', 'http://insecure.example.com', '*', 7, 'https://x.example.com/path'],
      resourceDomains: 'https://cdn.example.com',
      bogus: [],
    })
    expect(r.csp.connect_domains).toEqual(['https://api.example.com'])
    expect(r.problems.map((p) => [p.field, p.value])).toEqual([
      ['bogus', []],
      ['connectDomains', 'http://insecure.example.com'],
      ['connectDomains', '*'],
      ['connectDomains', 7],
      ['connectDomains', 'https://x.example.com/path'],
      ['resourceDomains', 'https://cdn.example.com'],
    ])
    expect(AppCsp.safeParse(r.csp).success).toBe(true)
  })
  it('caps at 16 and reports the rest', () => {
    const r = fromSpecCsp({ connectDomains: Array.from({ length: 18 }, (_, i) => `https://a${i}.example.com`) })
    expect(r.csp.connect_domains).toHaveLength(16)
    expect(r.problems).toHaveLength(2)
  })
  it('reads nothing declared as empty and a non-object as a problem', () => {
    expect(fromSpecCsp(undefined).problems).toEqual([])
    expect(fromSpecCsp(null).problems).toEqual([])
    expect(fromSpecCsp('x').problems).toHaveLength(1)
    expect(fromSpecCsp([]).problems).toHaveLength(1)
  })
})

describe('X-Talos-App-Csp header', () => {
  it('round-trips', () => {
    const r = decodeAppCspHeader(encodeAppCspHeader(goodCsp()), RELAY)
    expect(r).toEqual({ ok: true, csp: goodCsp() })
  })
  const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not base64url', '!!!'],
    ['standard base64 padding', `${b64(goodCsp())}==`],
    ['not JSON', b64('hello')],
    ['an array', b64([])],
    ['an unknown key', b64({ ...goodCsp(), extra: [] })],
    ['a bad entry', b64({ ...goodCsp(), connect_domains: ['*'] })],
    ['the relay host', b64({ ...goodCsp(), connect_domains: ['https://relay.example.com'] })],
    ['a covering wildcard', b64({ ...goodCsp(), connect_domains: ['https://*.example.com'] })],
    ['a number', 5],
  ])('rejects %s without throwing', (_n, v) => {
    expect(decodeAppCspHeader(v, RELAY).ok).toBe(false)
  })
  it('refuses a header over the cap, both ways', () => {
    expect(decodeAppCspHeader('A'.repeat(APP_CSP_HEADER_MAX + 1), RELAY)).toEqual({ ok: false, reason: 'too large' })
    const c = goodCsp()
    c.connect_domains = Array.from({ length: 16 }, (_, i) => `https://${'a'.repeat(50)}${i}.example.com`)
    c.script_hashes = Array.from({ length: 64 }, () => `sha512-${'C'.repeat(86)}==`)
    expect(() => encodeAppCspHeader(c)).toThrow(/too large/)
  })
})

describe('McpCallToolResult', () => {
  it('strips the host-owned _meta keys and keeps the rest', () => {
    const r = McpCallToolResult.parse({
      content: [{ type: 'text', text: 'x' }],
      _meta: { 'com.anthropic/x': 1, 'claudecode/toolUseId': 't', 'vendor/keep': 2, 'com.anthropicfoo': 3 },
    })
    expect(r._meta).toEqual({ 'vendor/keep': 2, 'com.anthropicfoo': 3 })
  })
  it('ignores a field a newer bridge added (not strict) but not a bad one', () => {
    expect(McpCallToolResult.safeParse({ content: [], newThing: true }).success).toBe(true)
    expect(McpCallToolResult.safeParse({ content: 'x' }).success).toBe(false)
    expect(McpCallToolResult.safeParse({ content: Array.from({ length: 101 }, () => ({})) }).success).toBe(false)
  })
  it('jcsBytes measures plain JSON and refuses a cycle, a bigint and undefined without throwing', () => {
    expect(jcsBytes({ a: 1 })).toBe(7)
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    expect(jcsBytes(cyc)).toBeUndefined()
    expect(jcsBytes({ n: 10n })).toBeUndefined()
    expect(jcsBytes(undefined)).toBeUndefined()
  })
})

// ---- models ---------------------------------------------------------------------------------------------------------

const viewRow = () => clone((fixtures['reply.app_view'] as { message: Record<string, unknown> }).message)
const echoRow = () => clone((fixtures['reply.app_echo'] as { message: Record<string, unknown> }).message)

describe('Message (app rows)', () => {
  it('parses the committed view row and echo row', () => {
    const v = Message.parse(viewRow())
    expect(v.kind).toBe('app')
    expect(v.app?.view_id).toMatch(/^av_/)
    expect(appMessageProblem(v)).toBeUndefined()
    const e = Message.parse(echoRow())
    expect(e.app_view_id).toMatch(/^av_/)
    expect(appMessageProblem(e)).toBeUndefined()
  })

  it('an older peer message (no app fields) parses to exactly what it did before: no app keys appear', () => {
    const old = (fixtures.reply as { message: Record<string, unknown> }).message
    const parsed = Message.parse(old)
    expect(Object.hasOwn(parsed, 'app')).toBe(false)
    expect(Object.hasOwn(parsed, 'app_view_id')).toBe(false)
    expect(isAppMessage(parsed)).toBe(false)
    expect(appMessageProblem(parsed)).toBeUndefined()
  })

  it('a newer bridge adding a field to the view does not hurt (not strict)', () => {
    const row = viewRow() as { app: Record<string, unknown> }
    row.app.future_field = { a: 1 }
    const m = Message.parse(row)
    expect(m.app?.view_id).toBeDefined()
  })

  it('one broken view degrades that row, not the frame, and the mint check names the problem', () => {
    const row = viewRow() as { app: Record<string, unknown> }
    row.app.approval_key = 'nope'
    const r = parseFrame({ ...(fixtures['reply.app_view'] as object), message: row })
    expect(r.ok).toBe(true)
    if (r.ok && r.frame.type === 'reply') {
      expect(r.frame.message.app).toBeUndefined()
      expect(appMessageProblem(r.frame.message)).toMatch(/needs a valid app view/)
    }
  })

  it('refuses an unknown kind or author as a bad frame, never a throw', () => {
    for (const patch of [{ kind: 'app2' }, { author: 'robot' }]) {
      const f = { ...(fixtures['reply.app_view'] as object), message: { ...viewRow(), ...patch } }
      expect(parseFrame(f)).toMatchObject({ ok: false, code: 'bad_frame' })
    }
  })

  const view = () => (viewRow() as { app: Record<string, unknown> }).app
  it.each([
    ['both result and result_media', (a: Record<string, unknown>) => (a.tool_result_media = a.page)],
    ['neither result nor result_media', (a: Record<string, unknown>) => delete a.tool_result],
    ['a non-html page', (a: Record<string, unknown>) => (a.page = { ...(a.page as object), kind: 'image' })],
    [
      'a result over 128 KiB',
      (a: Record<string, unknown>) => (a.tool_result = { content: [{ type: 'text', text: 'x'.repeat(129 * 1024) }] }),
    ],
    ['an input over 16 KiB', (a: Record<string, unknown>) => (a.tool_input = { x: 'y'.repeat(17 * 1024) })],
    ['a non-ui resource uri', (a: Record<string, unknown>) => (a.resource_uri = 'https://x.example.com/a')],
    ['a bad csp', (a: Record<string, unknown>) => (a.csp = { ...(a.csp as object), connect_domains: ['*'] })],
  ])('AppView rejects %s', (_n, mutate) => {
    const a = view()
    mutate(a)
    expect(AppView.safeParse(a).success).toBe(false)
  })

  it('the mint check catches every inconsistent combination', () => {
    const m = Message.parse(viewRow())
    expect(appMessageProblem({ ...m, author: 'agent' })).toMatch(/author 'app'/)
    expect(appMessageProblem({ ...m, app: undefined })).toBeDefined()
    expect(appMessageProblem({ ...m, app_view_id: m.app?.view_id })).toBeDefined()
    expect(appMessageProblem({ ...m, thread_id: 'other' })).toMatch(/another thread/)
    const e = Message.parse(echoRow())
    expect(appMessageProblem({ ...e, app_view_id: undefined })).toBeDefined()
    expect(appMessageProblem({ ...e, kind: 'file' })).toBeDefined()
    expect(
      appMessageProblem({
        ...Message.parse((fixtures.reply as { message: object }).message),
        author: 'owner',
        app_view_id: m.app?.view_id,
      } as never),
    ).toMatch(/author 'app'/)
  })
})

describe('Card kind app_action', () => {
  const base = () => clone((fixtures['card.create'] as { card: Record<string, unknown> }).card)
  it('parses, and is bridge-only (the agent allowlist does not take it)', () => {
    expect(Card.safeParse({ ...base(), kind: 'app_action' }).success).toBe(true)
    expect(isAgentCardKind('app_action')).toBe(false)
    expect(Card.safeParse({ ...base(), kind: 'app_actionx' }).success).toBe(false)
  })
})

// ---- frames ---------------------------------------------------------------------------------------------------------

describe('app frames', () => {
  const req = () => clone(fixtures['app.request'] as Record<string, unknown>)
  const reqMsg = () => clone(fixtures['app.request.ui_message'] as Record<string, unknown>)

  it('every fixture parses and owner frames round-trip unchanged', () => {
    for (const n of [
      'app.request',
      'app.request.ui_message',
      'app.response',
      'app.update',
      'reply.app_view',
      'reply.app_echo',
    ]) {
      const raw = fixtures[n] as Record<string, unknown>
      const r = parseFrame(raw)
      expect(r.ok, n).toBe(true)
      if (r.ok) expect(JSON.parse(JSON.stringify(r.frame)), n).toEqual(raw)
    }
  })

  it('app.request without user_gesture fails, for both methods, and a non-boolean fails', () => {
    for (const make of [req, reqMsg]) {
      const f = make()
      delete f.user_gesture
      expect(parseFrame(f).ok).toBe(false)
      expect(parseFrame({ ...make(), user_gesture: 'true' }).ok).toBe(false)
      expect(parseFrame({ ...make(), user_gesture: 1 }).ok).toBe(false)
    }
  })

  it('app.request is strict (unknown field, defaults) and takes only the two methods', () => {
    expect(parseFrame({ ...req(), sneaky: 1 }).ok).toBe(false)
    expect(parseFrame({ ...reqMsg(), tool_name: 'x' }).ok).toBe(false)
    expect(parseFrame({ ...req(), text: 'x' }).ok).toBe(false)
    expect(parseFrame({ ...req(), method: 'ui/open-link' }).ok).toBe(false)
    expect(parseFrame({ ...req(), method: undefined }).ok).toBe(false)
  })

  it('limits: tool_name, arguments (16 KiB JCS), text (4,000), id shapes, osig', () => {
    expect(parseFrame({ ...req(), tool_name: 'x'.repeat(129) }).ok).toBe(false)
    expect(parseFrame({ ...req(), tool_name: '' }).ok).toBe(false)
    expect(parseFrame({ ...req(), arguments: { a: 'y'.repeat(17 * 1024) } }).ok).toBe(false)
    expect(parseFrame({ ...req(), arguments: { a: 'y'.repeat(8 * 1024) } }).ok).toBe(true)
    expect(parseFrame({ ...req(), arguments: [] }).ok).toBe(false)
    expect(parseFrame({ ...reqMsg(), text: 'x'.repeat(4001) }).ok).toBe(false)
    expect(parseFrame({ ...reqMsg(), text: 'x'.repeat(4000) }).ok).toBe(true)
    expect(parseFrame({ ...reqMsg(), text: '' }).ok).toBe(false)
    expect(parseFrame({ ...req(), view_id: 'av_nope' }).ok).toBe(false)
    expect(parseFrame({ ...req(), request_id: 'ar_nope' }).ok).toBe(false)
    expect(parseFrame({ ...req(), osig: `MEUCIQ${'A'.repeat(90)}` }).ok).toBe(false)
  })

  it('direction: app.request goes app->relay->bridge only; responses and updates the other way only', () => {
    expect(DIRECTION_TYPES.app_to_relay).toContain('app.request')
    expect(DIRECTION_TYPES.relay_to_bridge).toContain('app.request')
    expect(DIRECTION_TYPES.relay_to_app).not.toContain('app.request')
    expect(DIRECTION_TYPES.bridge_to_relay).not.toContain('app.request')
    for (const t of ['app.response', 'app.update']) {
      expect(DIRECTION_TYPES.bridge_to_relay).toContain(t)
      expect(DIRECTION_TYPES.relay_to_app).toContain(t)
      expect(DIRECTION_TYPES.app_to_relay).not.toContain(t)
      expect(DIRECTION_TYPES.relay_to_bridge).not.toContain(t)
    }
    expect(parseFrame(fixtures['app.response'], { direction: 'app_to_relay' }).ok).toBe(false)
    expect(parseFrame(fixtures['app.update'], { direction: 'relay_to_bridge' }).ok).toBe(false)
    expect(parseFrame(fixtures['app.request'], { direction: 'bridge_to_relay' }).ok).toBe(false)
    expect(parseFrame(fixtures['app.request'], { direction: 'app_to_relay' }).ok).toBe(true)
    expect(AppToRelay.safeParse(fixtures['app.request']).success).toBe(true)
    expect(RelayToBridge.safeParse(fixtures['app.request.ui_message']).success).toBe(true)
    expect(RelayToApp.safeParse(fixtures['app.response']).success).toBe(true)
    expect(BridgeToRelay.safeParse(fixtures['app.update']).success).toBe(true)
  })

  it('AppToRelay rejects author app: an app cannot send a reply, and an owner frame cannot carry one', () => {
    expect(AppToRelay.safeParse(fixtures['reply.app_view']).success).toBe(false)
    expect(AppToRelay.safeParse(fixtures['reply.app_echo']).success).toBe(false)
    expect(parseFrame(fixtures['reply.app_view'], { direction: 'app_to_relay' }).ok).toBe(false)
    const f = { ...(fixtures.message as object), author: 'app', kind: 'app' }
    expect(AppToRelay.safeParse(f).success).toBe(false)
    // the bridge can send them
    expect(BridgeToRelay.safeParse(fixtures['reply.app_view']).success).toBe(true)
    expect(RelayToApp.safeParse(fixtures['reply.app_echo']).success).toBe(true)
  })

  it('durability: only app.update is stored; request and response are never stored, replayed or consumed', () => {
    expect(DURABLE_FRAME_TYPES).toContain('app.update')
    for (const t of ['app.request', 'app.response'] as const) {
      expect(DURABLE_FRAME_TYPES).not.toContain(t)
      expect(CONSUMABLE_FRAME_TYPES).not.toContain(t)
    }
    expect(CONSUMABLE_FRAME_TYPES).not.toContain('app.update')
    expect(OWNER_FRAME_TYPES).toContain('app.request')
  })

  it('app.response: failed needs error, pending_card needs card_id, only failed carries error, result xor media', () => {
    const r = () => clone(fixtures['app.response'] as Record<string, unknown>)
    expect(parseFrame({ ...r(), state: 'failed' }).ok).toBe(false)
    expect(parseFrame({ ...r(), state: 'failed', error: { code: 'timeout', message: 'no' } }).ok).toBe(true)
    expect(parseFrame({ ...r(), state: 'failed', error: { code: 'not_a_code', message: 'no' } }).ok).toBe(false)
    expect(parseFrame({ ...r(), state: 'failed', error: { code: 'timeout', message: 'x'.repeat(201) } }).ok).toBe(false)
    expect(parseFrame({ ...r(), state: 'pending_card' }).ok).toBe(false)
    expect(parseFrame({ ...r(), state: 'pending_card', card_id: `c_${'0'.repeat(26)}` }).ok).toBe(true)
    expect(parseFrame({ ...r(), error: { code: 'timeout', message: 'no' } }).ok).toBe(false)
    expect(parseFrame({ ...r(), result_media: (viewRow() as { app: { page: unknown } }).app.page }).ok).toBe(false)
    expect(parseFrame({ ...r(), result: { content: [{ type: 'text', text: 'x'.repeat(129 * 1024) }] } }).ok).toBe(false)
  })

  it('app.response result _meta loses host keys on the way through', () => {
    const f = { ...(fixtures['app.response'] as object), result: { content: [], _meta: { 'claudecode/x': 1, ok: 1 } } }
    const r = parseFrame(f)
    expect(r.ok).toBe(true)
    if (r.ok && r.frame.type === 'app.response') expect(r.frame.result?._meta).toEqual({ ok: 1 })
  })

  it('app.update states', () => {
    for (const state of ['superseded', 'closed', 'revoked'])
      expect(parseFrame({ ...(fixtures['app.update'] as object), state }).ok).toBe(true)
    expect(parseFrame({ ...(fixtures['app.update'] as object), state: 'gone' }).ok).toBe(false)
  })

  it('an older peer that has no app frames answers an app frame with bad_frame, not a throw', async () => {
    // Emulate the pre-AP0 registry: the same parser logic, minus the app types.
    const { frameSchemas } = await import('../src/index.ts')
    const old = Object.fromEntries(Object.entries(frameSchemas).filter(([k]) => !k.startsWith('app.')))
    const oldParse = (input: { type: string }) => (Object.hasOwn(old, input.type) ? 'known' : 'bad_frame')
    expect(oldParse(fixtures['app.request'] as never)).toBe('bad_frame')
    expect(oldParse(fixtures['app.update'] as never)).toBe('bad_frame')
    expect(oldParse(fixtures.reply as never)).toBe('known')
  })
})

describe('signed app.request binds everything (second caller, tampering)', () => {
  it('verifies as committed, and every field flip breaks it', async () => {
    const key = loadTestKey()
    const raw = clone(fixtures['app.request'] as Record<string, unknown>)
    expect(await verifyOwnerFrame(raw, key.publicJwk)).toBe(true)
    const flips: Record<string, unknown> = {
      view_id: 'av_01JBF3V7Q8K2M4N6P8R0S2T4ZZ',
      request_id: 'ar_01JBF3V7Q8K2M4N6P8R0S2T4ZZ',
      tool_name: 'set_note',
      arguments: { id: 'n2' },
      user_gesture: false,
      thread_id: 'inbox',
      method: 'ui/message',
      ts: '2026-10-28T15:33:10.120Z',
    }
    for (const [k, v] of Object.entries(flips))
      expect(await verifyOwnerFrame({ ...raw, [k]: v }, key.publicJwk), k).toBe(false)
    // a second caller (another device id) replaying the first caller's signature
    expect(await verifyOwnerFrame({ ...raw, device_id: 'd_aaaaaaaaaaaaaaaaaaaa' }, key.publicJwk)).toBe(false)
  })
  it('the relay-added `relay` block does not break it', async () => {
    const key = loadTestKey()
    const raw = {
      ...clone(fixtures['app.request'] as Record<string, unknown>),
      relay: { seq: 1, received_at: '2026-10-28T15:32:10.311Z' },
    }
    expect(parseFrame(raw).ok).toBe(true)
    expect(await verifyOwnerFrame(raw, key.publicJwk)).toBe(true)
  })
})

describe('freshness and the 13-minute ceiling (clock jumps)', () => {
  const ts = '2026-10-28T15:32:10.120Z'
  const t0 = Date.parse(ts)
  it('accepts now, rejects older than 2 minutes, at the exact boundary too', () => {
    expect(isAppRequestFresh(ts, t0)).toBe(true)
    expect(isAppRequestFresh(ts, t0 + 120_000)).toBe(true)
    expect(isAppRequestFresh(ts, t0 + 120_001)).toBe(false)
    expect(isAppRequestFresh(ts, t0 + 3 * 60_000)).toBe(false)
  })
  it('a clock that jumped forward or back by more than the skew refuses; within it, accepts', () => {
    expect(isAppRequestFresh(ts, t0 - 59_000)).toBe(true)
    expect(isAppRequestFresh(ts, t0 - 61_000)).toBe(false)
    expect(isAppRequestFresh(ts, t0 + 24 * 3600_000)).toBe(false) // slept a day
    expect(isAppRequestFresh(ts, t0 - 24 * 3600_000)).toBe(false) // set back a day
  })
  it('garbage never passes', () => {
    expect(isAppRequestFresh('not a time', t0)).toBe(false)
    expect(isAppRequestFresh(ts, Number.NaN)).toBe(false)
    expect(isAppRequestFresh('', t0)).toBe(false)
  })
  it('the client ceiling is derived from the card expiry, the bridge grace and the skew: 13 minutes', () => {
    expect(APP_CLIENT_CEILING_MS).toBe(APP_CARD_EXPIRY_MS + APP_BRIDGE_GRACE_MS + 60_000)
    expect(APP_CLIENT_CEILING_MS).toBe(13 * 60_000)
  })
})

describe('AppPendingRequest', () => {
  const sample = () => ({
    request_id: 'ar_01JBF3V7Q8K2M4N6P8R0S2T4V6',
    view_id: 'av_01JBF3V7Q8K2M4N6P8R0S2T4V7',
    server: 'probe',
    server_source: 'user',
    tool: 'set_note',
    arguments: { id: 'n1', body: 'x' },
    state: 'awaiting_card',
    card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4V8',
    created_at: '2026-10-28T15:32:10.120Z',
    expires_at: '2026-10-28T15:42:10.120Z',
  })
  it('round-trips through JSON unchanged', () => {
    const p = AppPendingRequest.parse(sample())
    expect(JSON.parse(JSON.stringify(p))).toEqual(sample())
  })
  it('is strict and checks state, ids and times', () => {
    expect(AppPendingRequest.safeParse({ ...sample(), extra: 1 }).success).toBe(false)
    expect(AppPendingRequest.safeParse({ ...sample(), state: 'done' }).success).toBe(false)
    expect(AppPendingRequest.safeParse({ ...sample(), request_id: 'x' }).success).toBe(false)
    expect(AppPendingRequest.safeParse({ ...sample(), expires_at: 'tomorrow' }).success).toBe(false)
    expect(AppPendingRequest.safeParse({ ...sample(), state: 'expired' }).success).toBe(true)
    const { card_id: _c, ...noCard } = sample()
    expect(AppPendingRequest.safeParse(noCard).success).toBe(true)
  })
})

describe('approvalKey', () => {
  const manifest = () => ({
    server: 'probe',
    source: 'user',
    resource_uri: 'ui://probe/view.html',
    html_sha256: 'a'.repeat(64),
    csp: goodCsp(),
    permissions_requested: [],
    prefers_border: true,
    tools: [
      { name: 'set_note', visibility: ['model', 'app'], read_only: false, destructive: true, open_world: true },
      {
        name: 'read_note',
        resource_uri: 'ui://probe/view.html',
        visibility: ['model', 'app'],
        read_only: true,
        destructive: false,
        open_world: true,
      },
    ],
    direct: { type: 'http', config_fingerprint: 'b'.repeat(64), auth: 'static' },
  })
  const key = (m: unknown) => approvalKey(m)

  it('is 64 hex and stable', () => {
    expect(key(manifest())).toMatch(/^[0-9a-f]{64}$/)
    expect(key(manifest())).toBe(key(manifest()))
  })
  it('does not depend on the order tools were listed in', () => {
    const m = manifest()
    m.tools.reverse()
    expect(key(m)).toBe(key(manifest()))
  })
  it('does not change when owner choices (or any unknown field) change', () => {
    const base = key(manifest())
    expect(key({ ...manifest(), owner: { label: 'A', show: 'auto', direct: true } })).toBe(base)
    expect(key({ ...manifest(), owner: { label: 'B', show: 'ask', direct: false }, decided_at: 'x' })).toBe(base)
  })

  const changes: Array<[string, (m: ReturnType<typeof manifest>) => void]> = [
    ['server', (m) => (m.server = 'probe2')],
    ['source', (m) => (m.source = 'plugin')],
    ['resource_uri', (m) => (m.resource_uri = 'ui://probe/other.html')],
    ['html_sha256', (m) => (m.html_sha256 = 'c'.repeat(64))],
    ['csp connect domain', (m) => m.csp.connect_domains.push('https://api2.example.com')],
    ['csp script hash', (m) => (m.csp.script_hashes = [`sha256-${'B'.repeat(43)}=`])],
    ['csp script url', (m) => (m.csp.script_urls = [])],
    ['permissions_requested', (m) => ((m.permissions_requested as string[]) = ['camera'])],
    ['prefers_border', (m) => (m.prefers_border = false)],
    ['prefers_border removed', (m) => delete (m as { prefers_border?: boolean }).prefers_border],
    ['a tool annotation (read_only)', (m) => ((m.tools[0] as { read_only: boolean }).read_only = true)],
    ['a tool annotation (destructive)', (m) => ((m.tools[0] as { destructive: boolean }).destructive = false)],
    ['a tool annotation (open_world)', (m) => ((m.tools[1] as { open_world: boolean }).open_world = false)],
    ['a tool visibility', (m) => ((m.tools[0] as { visibility: string[] }).visibility = ['app'])],
    ['a tool resource_uri', (m) => ((m.tools[0] as { resource_uri?: string }).resource_uri = 'ui://probe/view.html')],
    [
      'a tool added',
      (m) =>
        m.tools.push({
          name: 'zzz',
          visibility: ['model'],
          read_only: false,
          destructive: true,
          open_world: true,
        } as never),
    ],
    ['a tool removed', (m) => m.tools.pop()],
    ['a tool renamed', (m) => ((m.tools[0] as { name: string }).name = 'set_note2')],
    [
      'direct config fingerprint',
      (m) => ((m.direct as { config_fingerprint: string }).config_fingerprint = 'd'.repeat(64)),
    ],
    ['direct auth', (m) => ((m.direct as { auth: string }).auth = 'oauth')],
    ['direct removed', (m) => delete (m as { direct?: unknown }).direct],
  ]
  for (const [name, mutate] of changes) {
    it(`changes when ${name} changes`, () => {
      const m = manifest()
      mutate(m)
      expect(key(m)).not.toBe(key(manifest()))
    })
  }

  it('throws on a manifest that does not parse or repeats a tool name', () => {
    expect(() => key({ ...manifest(), html_sha256: 'short' })).toThrow()
    expect(() => key(null)).toThrow()
    const m = manifest()
    m.tools.push({ ...(m.tools[0] as object) } as never)
    expect(() => key(m)).toThrow(/duplicate/)
  })
  it('the same manifest from two concurrent callers gets one key', async () => {
    const keys = await Promise.all(Array.from({ length: 100 }, async () => key(manifest())))
    expect(new Set(keys).size).toBe(1)
  })
})

describe('upload header and the headless post', () => {
  it('bridgeMediaPut documents the CSP header', () => {
    expect(routes.bridgeMediaPut.note).toContain('X-Talos-App-Csp')
  })
  const post = (v: unknown) => routes.bridgePost.req.safeParse(v).success
  it('POST /bridge/post refuses app rows and app_action cards but accepts app.update', () => {
    expect(post(fixtures.reply)).toBe(true)
    expect(post(fixtures['reply.app_view'])).toBe(false)
    expect(post(fixtures['reply.app_echo'])).toBe(false)
    expect(post(fixtures['app.update'])).toBe(true)
    const cc = clone(fixtures['card.create'] as { card: Record<string, unknown> })
    expect(post(cc)).toBe(true)
    expect(post({ ...cc, card: { ...cc.card, kind: 'app_action' } })).toBe(false)
    expect(CardCreateFrame.safeParse({ ...cc, card: { ...cc.card, kind: 'app_action' } }).success).toBe(true)
  })
})

describe('AppErrorCode', () => {
  it('is exactly the spec list', () => {
    expect([...AppErrorCode.options]).toEqual([
      'view_unknown',
      'view_closed',
      'not_in_catalog',
      'cross_server',
      'not_app_visible',
      'app_only_unsupported',
      'too_large',
      'rate_limited',
      'too_many_pending',
      'needs_gesture',
      'needs_confirm',
      'mac_offline',
      'agent_declined',
      'owner_killed',
      'card_expired',
      'tool_failed',
      'timeout',
      'sig_invalid',
      'approval_changed',
      'direct_unavailable',
      'direct_auth',
    ])
  })
})

describe('hardening after review (WHATWG parser decides)', () => {
  const pin = (u: string) => AppCsp.safeParse({ ...goodCsp(), script_urls: [u] }).success
  const src = (u: string) => AppCsp.safeParse({ ...goodCsp(), connect_domains: [u] }).success
  it('pinned urls: a file passes; directories, //, encoded dots (any case), encoded slashes, default port fail', () => {
    expect(pin('https://cdn.example.com/lib/app.js')).toBe(true)
    for (const u of [
      'https://cdn.example.com/lib/',
      'https://cdn.example.com//',
      'https://cdn.example.com/a//b.js',
      'https://cdn.example.com/x/%2e%2e/evil.js',
      'https://cdn.example.com/x/%2E%2E/evil.js',
      'https://cdn.example.com/x/%2e/evil.js',
      'https://cdn.example.com/x%2Fevil.js',
      'https://cdn.example.com/x%5Cevil.js',
      'https://cdn.example.com:443/a.js',
      'https://cdn.example.com/%zz.js',
    ])
      expect(pin(u), u).toBe(false)
  })
  it('hosts: hex, octal-ish and short IPv4 spellings fail in sources and pinned urls', () => {
    for (const h of ['10.0.0.0x1', '127.0.0.0x1', '169.254.169.0xfe', '0x7f.0.0.1', '127.1', '0300.0.0.1'])
      expect(src(`https://${h}`), h).toBe(false)
    expect(pin('https://10.0.0.0x1/a.js')).toBe(false)
    expect(src('https://*.10.0.0.0x1')).toBe(false)
    expect(src('https://api.example.com')).toBe(true)
  })
  it('host _meta is stripped inside nested content (embedded resource) too', () => {
    const r = McpCallToolResult.parse({
      content: [
        {
          type: 'resource',
          resource: { uri: 'x', _meta: { 'claudecode/a': 1, keep: 2 } },
          _meta: { 'com.anthropic/b': 1 },
        },
      ],
    })
    expect(JSON.stringify(r)).not.toMatch(/claudecode\/|com\.anthropic\//)
    expect(JSON.stringify(r)).toContain('keep')
  })
  it('ready and history keep the readable items when one is unknown, and say which survive', () => {
    const ready = clone(fixtures.ready as Record<string, unknown>)
    const card = (fixtures['card.create'] as { card: Record<string, unknown> }).card
    ready.open_cards = [card, { ...card, kind: 'future' }, 'junk', null]
    const r = parseFrame(ready)
    expect(r.ok).toBe(true)
    if (r.ok && r.frame.type === 'ready') expect(r.frame.open_cards).toHaveLength(1)
    const page = clone(fixtures['history.page'] as Record<string, unknown>)
    const base = (fixtures.reply as { message: Record<string, unknown> }).message
    const before = (page.messages as unknown[]).length
    page.messages = [...(page.messages as unknown[]), { ...base, kind: 'future' }, { ...base, id: 'bad' }]
    const p = parseFrame(page)
    if (p.ok && p.frame.type === 'history.page') expect(p.frame.messages).toHaveLength(before)
    else throw new Error('history page dropped')
  })
  it('POST /bridge/post refuses any app field on the raw body, even a view this build would read as absent', () => {
    const reply = clone(fixtures.reply as { message: Record<string, unknown> })
    expect(routes.bridgePost.req.safeParse({ ...reply, message: { ...reply.message, app: { junk: 1 } } }).success).toBe(
      false,
    )
    expect(routes.bridgePost.req.safeParse({ ...reply, message: { ...reply.message, app_view_id: 'x' } }).success).toBe(
      false,
    )
    expect(routes.bridgePost.req.safeParse(reply).success).toBe(true)
  })
})
