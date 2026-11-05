// Independent review of PR #84 (MCP Apps AP0). Each test pins a defect found in review and FAILS on the PR head.
import { describe, expect, it } from 'vitest'
import { AppCsp, buildAppCsp, CspSource, fromSpecCsp, McpCallToolResult, PinnedUrl, parseFrame } from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const fixtures = loadFixtures()
const clone = <T>(v: T): T => structuredClone(v)
const csp = (patch: Record<string, string[]>) => ({
  connect_domains: [],
  resource_domains: [],
  frame_domains: [],
  base_uri_domains: [],
  script_hashes: [],
  script_urls: [],
  style_urls: [],
  ...patch,
})

describe('review: CSP sources must not admit IPv4 literals in the forms a browser reads as IPv4', () => {
  // WHATWG URL: a host whose last label is a 0x-hex number is an IPv4 address. new URL('https://10.0.0.0x1').host
  // is '10.0.0.1'. The "last label holds a letter" check is fooled by the 'x'.
  for (const src of ['https://10.0.0.0x1', 'https://127.0.0.0x1', 'https://192.168.1.0xa', 'wss://169.254.169.0xfe']) {
    it(`refuses ${src} (browser host ${new URL(src).hostname})`, () => {
      expect(CspSource.safeParse(src).success).toBe(false)
    })
  }
  it('fromSpecCsp reports the hex IPv4 entry instead of carrying it into connect_domains', () => {
    const r = fromSpecCsp({ connectDomains: ['HTTPS://127.0.0.0X1'] })
    expect(r.csp.connect_domains).toEqual([])
    expect(r.problems).toHaveLength(1)
  })
  it('PinnedUrl refuses a hex IPv4 host too', () => {
    expect(PinnedUrl.safeParse('https://10.0.0.0x1/app.js').success).toBe(false)
  })
})

describe('review: script_urls / style_urls are "exact file URLs", not path prefixes', () => {
  // In CSP a source expression whose path ends in '/' matches every path under it: script-src
  // https://cdn.jsdelivr.net/npm/ lets the view load ANY npm package as script.
  for (const u of ['https://cdn.jsdelivr.net/npm/', 'https://cdn.example.com//', 'https://cdn.example.com/a/']) {
    it(`PinnedUrl refuses the directory ${u}`, () => {
      expect(PinnedUrl.safeParse(u).success).toBe(false)
    })
  }
  it('a directory never reaches script-src', () => {
    const header = (() => {
      try {
        return buildAppCsp(csp({ script_urls: ['https://cdn.jsdelivr.net/npm/'] }) as never)
      } catch {
        return 'refused'
      }
    })()
    expect(header).toBe('refused')
  })
  it('percent-encoded dot segments are refused like literal ones (browsers resolve %2e%2e to ..)', () => {
    for (const u of ['https://cdn.example.com/x/%2e%2e/evil.js', 'https://cdn.example.com/x/%2E%2e/evil.js']) {
      expect(new URL(u).pathname).toBe('/evil.js')
      expect(PinnedUrl.safeParse(u).success).toBe(false)
    }
  })
  it('AppCsp refuses a style_urls directory', () => {
    expect(AppCsp.safeParse(csp({ style_urls: ['https://cdn.example.com/css/'] })).success).toBe(false)
  })
})

describe('review: host _meta keys never reach a view', () => {
  it('strips com.anthropic/ and claudecode/ keys from content blocks, not just the top-level _meta', () => {
    const r = McpCallToolResult.parse({
      content: [{ type: 'text', text: 'hi', _meta: { 'com.anthropic/secret': 'x', 'claudecode/tool_use_id': 'y' } }],
      _meta: { 'com.anthropic/secret': 'x' },
    })
    expect(r._meta).toEqual({})
    expect(JSON.stringify(r)).not.toContain('com.anthropic/')
    expect(JSON.stringify(r)).not.toContain('claudecode/')
  })
})

describe('review: one unknown value never drops a whole ready or history page', () => {
  // AP0 adds Card.kind 'app_action' and Message.kind/author 'app'. A cached older PWA meets those as unknown values;
  // this build will meet the NEXT new kind the same way. workers_status already uses .catch for exactly this.
  it('ready with one open card of a kind this build does not know still parses (that card dropped)', () => {
    const ready = clone(fixtures.ready as Record<string, unknown>)
    const card = clone((fixtures['card.create'] as { card: Record<string, unknown> }).card)
    ready.open_cards = [card, { ...card, id: 'c_01HZZZZZZZZZZZZZZZZZZZZZZZ', kind: 'some_future_kind' }]
    const r = parseFrame(ready)
    expect(r.ok).toBe(true)
  })
  it('history.page with one row of an unknown kind keeps the other rows', () => {
    const page = clone(fixtures['history.page'] as Record<string, unknown>)
    const msgs = page.messages as Record<string, unknown>[]
    const base = clone((fixtures.reply as { message: Record<string, unknown> }).message)
    page.messages = [...msgs, { ...base, id: 'm_01HZZZZZZZZZZZZZZZZZZZZZZZ', kind: 'some_future_kind' }]
    const r = parseFrame(page)
    expect(r.ok).toBe(true)
  })
})
