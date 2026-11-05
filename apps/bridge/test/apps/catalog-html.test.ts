import { describe, expect, it } from 'bun:test'
import { statSync, writeFileSync } from 'node:fs'
import {
  matchTool,
  normaliseAnnotations,
  readCatalog,
  runsWithoutTap,
  sameLabels,
  toolPrefixFor,
  toolRunsWithoutTap,
  writeCatalog,
} from '../../src/apps/catalog.ts'
import { checkHtml } from '../../src/apps/html-check.ts'
import { appPaths } from '../../src/apps/paths.ts'
import { approvedFixture, readProbe, tmp } from './helpers.ts'

describe('normaliseAnnotations (M6.3 cases)', () => {
  it('SDK {readOnly:true} with no destructive: read-only, not destructive', () => {
    expect(normaliseAnnotations({ readOnly: true })).toEqual({ read_only: true, destructive: false, open_world: true })
  })
  it('MCP hints with destructiveHint:false give the same triple as the SDK shape', () => {
    const mcp = normaliseAnnotations({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    const sdk = normaliseAnnotations({ readOnly: true, openWorld: false })
    expect(mcp).toEqual(sdk)
    expect(mcp).toEqual({ read_only: true, destructive: false, open_world: false })
  })
  it('read-only and destructive together is destructive (a card)', () => {
    const t = normaliseAnnotations({ readOnly: true, destructive: true })
    expect(t.destructive).toBe(true)
    expect(runsWithoutTap(t)).toBe(false)
  })
  it('nothing: not read-only, destructive, open world', () => {
    expect(normaliseAnnotations(undefined)).toEqual({ read_only: false, destructive: true, open_world: true })
    expect(normaliseAnnotations({})).toEqual({ read_only: false, destructive: true, open_world: true })
  })
  it('an unknown value fails safe: strings and numbers are not booleans', () => {
    expect(normaliseAnnotations({ readOnly: 'true', destructive: 0, openWorld: 'no' })).toEqual({
      read_only: false,
      destructive: true,
      open_world: true,
    })
    expect(normaliseAnnotations(null)).toEqual({ read_only: false, destructive: true, open_world: true })
    expect(normaliseAnnotations([true])).toEqual({ read_only: false, destructive: true, open_world: true })
  })
  it('not read-only with an explicit destructive:false stays non-destructive (and still needs a tap)', () => {
    const t = normaliseAnnotations({ readOnly: false, destructive: false })
    expect(t).toEqual({ read_only: false, destructive: false, open_world: true })
    expect(runsWithoutTap(t)).toBe(false)
  })
  it('real probe output through the SDK shape: read_note is no-tap, set_note and show_widget are not', async () => {
    const { tools } = await readProbe()
    const by = (n: string) => normaliseAnnotations(tools.find((t) => t.name === n)?.annotations)
    expect(runsWithoutTap(by('read_note'))).toBe(true)
    expect(runsWithoutTap(by('set_note'))).toBe(false)
    expect(runsWithoutTap(by('show_widget'))).toBe(false) // no annotations at all
  })
  it('a drifted server relabels set_note read-only and the labels no longer compare equal', async () => {
    const a = await readProbe()
    const b = await readProbe({ PROBE_GEN: '1', PROBE_DRIFT: 'annotations' })
    const norm = (r: typeof a, n: string) => normaliseAnnotations(r.tools.find((t) => t.name === n)?.annotations)
    expect(runsWithoutTap(norm(a, 'set_note'))).toBe(false)
    expect(runsWithoutTap(norm(b, 'set_note'))).toBe(true)
  })
})

describe('tool names and matching', () => {
  it('plugin servers: plugin:<p>:<s> becomes mcp__plugin_<p>_<s>__', () => {
    expect(toolPrefixFor('plugin:pl:plugsrv')).toBe('mcp__plugin_pl_plugsrv__')
    expect(toolPrefixFor('example-server')).toBe('mcp__example-server__')
    expect(toolPrefixFor('we ird.name')).toBe('mcp__we_ird_name__')
  })
  it('matchTool prefers the exact name, then the longest __ suffix, and rejects another prefix', () => {
    const server = {
      server: 'a',
      source: 'local',
      tool_prefix: 'mcp__a__',
      tools: [
        { name: 'x', visibility: ['model', 'app'], read_only: false, destructive: true, open_world: true },
        { name: 'get__x', visibility: ['model', 'app'], read_only: false, destructive: true, open_world: true },
      ],
      resources: [],
    } as never
    expect(matchTool(server, 'mcp__a__x')?.name).toBe('x')
    expect(matchTool(server, 'mcp__a__get__x')?.name).toBe('get__x')
    expect(matchTool(server, 'mcp__b__x')).toBeUndefined()
    expect(matchTool(server, 'mcp__a__y')).toBeUndefined()
  })
  it('ask_each_time overrides the label run rule', () => {
    const t = {
      name: 'q',
      visibility: ['model', 'app'],
      read_only: true,
      destructive: false,
      open_world: true,
    } as never
    expect(toolRunsWithoutTap({}, t)).toBe(true)
    expect(toolRunsWithoutTap({ ask_each_time: ['q'] }, t)).toBe(false)
  })
  it('sameLabels is order-insensitive for visibility and strict for the rest', () => {
    const a = {
      name: 'q',
      visibility: ['model', 'app'],
      read_only: true,
      destructive: false,
      open_world: true,
    } as never
    expect(sameLabels(a, { ...(a as object), visibility: ['app', 'model'] } as never)).toBe(true)
    expect(sameLabels(a, { ...(a as object), read_only: false } as never)).toBe(false)
    expect(sameLabels(a, { ...(a as object), open_world: false } as never)).toBe(false)
  })
})

describe('catalog file', () => {
  it('missing is "nothing catalogued", corrupt and unparseable are failures, a good one reads back; 0600', async () => {
    const home = tmp()
    const P = appPaths(home)
    expect(readCatalog(P)).toEqual({ ok: true, catalog: undefined })
    const fx = await approvedFixture(home)
    const r = readCatalog(P)
    expect(r.ok && r.catalog?.servers[0]?.server).toBe('probe')
    expect(statSync(P.catalog).mode & 0o777).toBe(0o600)
    writeFileSync(P.catalog, '{not json')
    expect(readCatalog(P)).toEqual({ ok: false, reason: 'catalog is not JSON' })
    writeFileSync(P.catalog, JSON.stringify({ rev: 'x' }))
    expect(readCatalog(P).ok).toBe(false)
    writeCatalog(P, fx.cat)
    expect(readCatalog(P).ok).toBe(true)
    expect(statSync(P.catalog).mode & 0o777).toBe(0o600)
  })
})

const CSP = { resource_domains: ['https://cdn.example.com', 'https://*.static.example.com'] }
const SRI256 = `sha256-${'A'.repeat(43)}=`

describe('static HTML check (M5.1)', () => {
  it('hashes each inline script over its exact raw text', async () => {
    const body = 'document.title="x"'
    const r = await checkHtml(`<html><script>${body}</script><script type="module">import 1</script></html>`, CSP)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const { createHash } = await import('node:crypto')
      expect(r.script_hashes[0]).toBe(`sha256-${createHash('sha256').update(body).digest('base64')}`)
      expect(r.script_hashes.length).toBe(2)
    }
  })
  it('a "javascript:" inside script text is fine; as a URL attribute it is refused, however it is spelled', async () => {
    expect((await checkHtml('<script>if (u.startsWith("javascript:")) bad()</script>', CSP)).ok).toBe(true)
    for (const attr of ['href', 'src', 'action', 'formaction', 'xlink:href']) {
      const r = await checkHtml(`<a ${attr}="javascript:alert(1)">x</a>`, CSP)
      expect(r.ok).toBe(false)
    }
    expect((await checkHtml('<a href=" \tJaVa\nScRiPt:alert(1)">x</a>', CSP)).ok).toBe(false)
    expect((await checkHtml('<a href="https://x.example.com/javascript:ok">x</a>', CSP)).ok).toBe(true)
  })
  it('inline event handlers are refused', async () => {
    for (const h of ['onclick', 'onerror', 'onload', 'ONFOCUS'])
      expect((await checkHtml(`<img ${h}="x()">`, CSP)).ok).toBe(false)
    expect((await checkHtml('<div data-online="1" title="on">x</div>', CSP)).ok).toBe(true)
  })
  it('remote scripts and styles need integrity, crossorigin, a declared host and an exact file URL', async () => {
    const s = (attrs: string) => checkHtml(`<script ${attrs}></script>`, CSP)
    const bad1 = await s('src="https://cdn.example.com/a.js"')
    expect(!bad1.ok && bad1.reason).toContain(
      'Code not pinned: loads https://cdn.example.com/a.js without an integrity hash',
    )
    expect((await s(`src="https://cdn.example.com/a.js" integrity="${SRI256}"`)).ok).toBe(false) // no crossorigin
    expect((await s(`src="https://other.example.com/a.js" integrity="${SRI256}" crossorigin`)).ok).toBe(false) // host not declared
    expect((await s(`src="http://cdn.example.com/a.js" integrity="${SRI256}" crossorigin`)).ok).toBe(false)
    expect((await s(`src="//cdn.example.com/a.js" integrity="${SRI256}" crossorigin`)).ok).toBe(false)
    expect((await s(`src="a.js" integrity="${SRI256}" crossorigin`)).ok).toBe(false)
    expect((await s(`src="https://cdn.example.com/a.js?v=2" integrity="${SRI256}" crossorigin`)).ok).toBe(false) // query
    expect((await s('src="https://cdn.example.com/a.js" integrity="md5-xx" crossorigin')).ok).toBe(false)
    const ok = await checkHtml(
      `<script src="https://cdn.example.com/a.js" integrity="${SRI256}" crossorigin="anonymous"></script><link rel="stylesheet" href="https://x.static.example.com/s.css" integrity="${SRI256}" crossorigin><link rel="modulepreload" href="https://cdn.example.com/m.js" integrity="${SRI256}" crossorigin>`,
      CSP,
    )
    expect(ok).toEqual({
      ok: true,
      script_hashes: [],
      script_urls: ['https://cdn.example.com/a.js', 'https://cdn.example.com/m.js'],
      style_urls: ['https://x.static.example.com/s.css'],
    })
    // a stylesheet link with no integrity is refused just like a script
    expect((await checkHtml('<link rel="stylesheet" href="https://cdn.example.com/s.css">', CSP)).ok).toBe(false)
  })
  it('accepts the real probe view or says why not (it is a hand-written raw JSON-RPC view)', async () => {
    const { contents } = await readProbe()
    const r = await checkHtml(contents[0]?.text ?? '', { resource_domains: [] })
    expect(r.ok).toBe(true)
  })
  it('garbage HTML does not throw', async () => {
    const r = await checkHtml('<<<<script>>>"\u0000', CSP)
    expect(typeof r.ok).toBe('boolean')
  })
})
