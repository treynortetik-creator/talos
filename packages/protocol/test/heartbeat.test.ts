// HB1b: the Heartbeat contract (docs/SCHEDULES.md S1.7). Strict where Talos writes, tolerant where it reads. Everything here
// is fictional. "BUG n" is the item number in the HB1b review fix round.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  configHash,
  HEARTBEAT_META_KEY,
  HEARTBEAT_SOURCE_MAX_BYTES,
  HeartbeatConfig,
  HeartbeatItem,
  HeartbeatItemRead,
  HeartbeatItemStore,
  HeartbeatResult,
  HeartbeatSourceConfig,
  HeartbeatSourceItem,
  HeartbeatSourceRequest,
  heartbeatConfigFromMeta,
  heartbeatMetaOf,
  heartbeatMetaProblem,
  heartbeatMuteMatches,
  heartbeatMuteOnlyChange,
  JobMeta,
  META_MAX_BYTES,
  parseHeartbeatItems,
  parseHeartbeatSourceResponse,
  visibleMetaText,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (n: string): string => readFileSync(join(here, '..', '..', 'testkit', 'fixtures', 'heartbeat', n), 'utf8')

const T1 = '2026-10-05T13:45:00.000Z'
const T2 = '2026-10-05T16:15:00.000Z'
const item = (over: Record<string, unknown> = {}) => ({
  source: 'gh-main',
  key: 'pr:acme/widgets#12',
  sig: 'a1',
  title: 'Add a widget',
  url: 'https://example.com/acme/widgets/pull/12',
  level: 'fyi',
  class: 'own',
  why: 'github.pr-open',
  deadline: null,
  first_seen: T1,
  last_seen: T2,
  count: 2,
  ...over,
})
const gh = { id: 'gh-main', kind: 'github', enabled: true, args: { repos: ['acme/widgets'] }, timeout_s: 30 }
const inbox = { id: 'inbox', kind: 'inbox', enabled: true, args: {}, timeout_s: 20 }
const cmd = {
  id: 'work-watch',
  kind: 'command',
  enabled: true,
  args: { argv: ['/usr/bin/python3', '/home/alex/watch.py', 'check'] },
  timeout_s: 60,
}
const config = (over: Record<string, unknown> = {}) => ({
  schema: 'talos.heartbeat/1',
  mode: 'shadow',
  sources: [gh, inbox],
  mutes: [{ source: 'gh-main', key: 'pr:acme/widgets#7', until: '2026-10-12T00:00:00.000Z' }],
  wake_cap_per_day: 3,
  run_timeout_s: 120,
  ...over,
})
const metaOf = (c: unknown) => ({ [HEARTBEAT_META_KEY]: c })

describe('frozen names', () => {
  it('the meta key is talos.heartbeat and the config carries schema talos.heartbeat/1', () => {
    expect(HEARTBEAT_META_KEY).toBe('talos.heartbeat')
    expect(HeartbeatConfig.safeParse(config({ schema: 'talos.heartbeat/2' })).success).toBe(false)
    expect(HeartbeatConfig.safeParse({ ...config(), schema: undefined }).success).toBe(false)
  })
  it('mode is shadow or live and defaults to shadow; wake cap defaults to 3 and run timeout to 120', () => {
    const { mode: _m, wake_cap_per_day: _w, run_timeout_s: _r, ...bare } = config()
    const c = HeartbeatConfig.parse(bare)
    expect([c.mode, c.wake_cap_per_day, c.run_timeout_s]).toEqual(['shadow', 3, 120])
    expect(HeartbeatConfig.parse(config({ mode: 'live' })).mode).toBe('live')
    expect(HeartbeatConfig.safeParse(config({ mode: 'loud' })).success).toBe(false)
  })
  it('digest_slot is gone: a strict config refuses it', () => {
    expect(HeartbeatConfig.safeParse(config({ digest_slot: '17:15' })).success).toBe(false)
  })
})

describe('HeartbeatItem', () => {
  it('accepts a normal item with the new fields (sig, class, why, deadline)', () => {
    expect(HeartbeatItem.safeParse(item()).success).toBe(true)
    expect(HeartbeatItem.safeParse(item({ url: undefined, detail: 'CI is red on main' })).success).toBe(true)
    expect(HeartbeatItem.safeParse(item({ deadline: '2026-10-06T17:00:00-04:00', class: 'work' })).success).toBe(true)
  })
  it('refuses a missing sig, a bad class, a bad deadline, a hold level, a zero count and an extra key', () => {
    const { sig: _s, ...noSig } = item()
    expect(HeartbeatItem.safeParse(noSig).success).toBe(false)
    expect(HeartbeatItem.safeParse(item({ class: 'other' })).success).toBe(false)
    expect(HeartbeatItem.safeParse(item({ deadline: 'tomorrow' })).success).toBe(false)
    expect(HeartbeatItem.safeParse(item({ level: 'hold' })).success).toBe(false)
    expect(HeartbeatItem.safeParse(item({ level: 'loud' })).success).toBe(false)
    expect(HeartbeatItem.safeParse(item({ count: 0 })).success).toBe(false)
    expect(HeartbeatItem.safeParse(item({ extra: 1 })).success).toBe(false)
  })
  it('a sig with a hidden character is refused, not rewritten (key plus sig is the identity)', () => {
    expect(HeartbeatItem.safeParse(item({ sig: 'a​1' })).success).toBe(false)
    expect(HeartbeatItem.safeParse(item({ key: 'k‮' })).success).toBe(false)
  })
  it('the store schema is check-only: it refuses an unescaped hidden character and never rewrites text', () => {
    for (const f of ['title', 'detail', 'why'])
      expect(HeartbeatItem.safeParse(item({ [f]: 'a‮b' })).success, f).toBe(false)
    expect(HeartbeatItem.safeParse(item({ title: 'a\u0000b' })).success).toBe(false)
    expect(HeartbeatItem.parse(item({ title: 'a⟦U+202E⟧b' })).title).toBe('a⟦U+202E⟧b')
    expect(HeartbeatItemStore).toBe(HeartbeatItem)
  })
})

// The one place untrusted text is escaped: a source's answer.
describe('source item text is capped and escaped once, at the source parse', () => {
  const { source: _s, first_seen: _f, last_seen: _l, count: _c, ...bare } = item()
  const src = (over: Record<string, unknown>) => HeartbeatSourceItem.parse({ ...bare, ...over })
  it('title is capped at 120 code points and detail at 500, then escaped; a cut text ends with …', () => {
    expect(src({ title: 'T'.repeat(121) }).title).toBe(`${'T'.repeat(120)}…`)
    expect(src({ title: 'T'.repeat(120) }).title).toBe('T'.repeat(120))
    expect(src({ detail: 'D'.repeat(501) }).detail).toBe(`${'D'.repeat(500)}…`)
    expect(src({ detail: 'D'.repeat(500) }).detail).toBe('D'.repeat(500))
  })
  it('caps and escapes a hostile detail the way visibleMetaText does', () => {
    const hostile = `ok‮​\u0000${'A'.repeat(50 * 1024)}`
    const d = src({ detail: hostile }).detail as string
    for (const raw of ['‮', '​', '\u0000']) expect(d.includes(raw)).toBe(false)
    expect(d.startsWith(`${visibleMetaText('ok‮​\u0000')}AAA`)).toBe(true)
    expect(d.endsWith('…')).toBe(true)
    expect(new TextEncoder().encode(d).length).toBeLessThan(8 * 1024)
  })
  it('the escape bracket itself cannot pass for an escape', () => {
    expect(src({ title: 'fix‮gnp.exe ⟦U+0041⟧' }).title).toBe('fix⟦U+202E⟧gnp.exe ⟦U+27E6⟧U+0041⟧')
  })
  it('why is untrusted text too: capped and escaped', () => {
    expect(src({ why: `r‮${'x'.repeat(200)}` }).why).toContain('⟦U+202E⟧')
  })
})

describe('BUG 4: ItemUrl is https only and shows what it opens', () => {
  const url = (u: string) => HeartbeatItem.safeParse(item({ url: u })).success
  it('accepts an ordinary https link', () => {
    expect(url('https://example.com/a/b?x=1#y')).toBe(true)
  })
  it('refuses http, javascript, data, file and relative links', () => {
    for (const u of ['http://example.com/a', 'javascript:alert(1)', 'data:text/html,hi', 'file:///home/alex/x', '/a/b'])
      expect(url(u), u).toBe(false)
  })
  it('refuses a bidi override, zero-width, C1 and NUL character anywhere in the link', () => {
    for (const bad of ['‮', '​', '⁦', '\u0085', '\u009f', '\u0000', '­', '﻿', ' ', ' '])
      expect(url(`https://example.com/a${bad}b`), JSON.stringify(bad)).toBe(false)
  })
  it('refuses a link with a login in it (what is shown first is not the host)', () => {
    expect(url(`https://example.com${'@'}evil.example/x`)).toBe(false)
  })
  it('refuses a link over 500 characters', () => {
    expect(url(`https://example.com/${'a'.repeat(500)}`)).toBe(false)
  })
})

const answer = (items: unknown[]) =>
  JSON.stringify({ schema: 'talos.heartbeat-source/1', status: 'ok', cursor: null, items })
/** What HB2 does with a source's answer: parse it (the one escape), add the runner's fields, check it for the store. */
function runOnce(raw: string) {
  const r = parseHeartbeatSourceResponse(raw)
  if (!r.ok) throw new Error(r.error)
  return r.items.map((i) => HeartbeatItem.parse({ ...i, source: 'gh-main', first_seen: T1, last_seen: T2, count: 1 }))
}

describe('R2-1: text is escaped in exactly one place', () => {
  const nasty = `fix‮ ⟦U+0041⟧ ​ ${'é'.repeat(5)}`
  const rawItem = (over: Record<string, unknown> = {}) => ({
    key: 'k1',
    sig: 's1',
    title: nasty,
    level: 'act',
    class: 'work',
    why: nasty,
    deadline: null,
    detail: nasty,
    ...over,
  })
  it('source parse then the store schema: the stored text is the escaped text, not escaped twice', () => {
    const [stored] = runOnce(answer([rawItem()]))
    expect(stored?.title).toBe(`fix⟦U+202E⟧ ⟦U+27E6⟧U+0041⟧ ⟦U+200B⟧ ${'é'.repeat(5)}`)
    expect(stored?.title).not.toContain('⟦U+27E6⟧U+27E6')
  })
  it('10 runs of the same answer store identical text every time', () => {
    const first = JSON.stringify(runOnce(answer([rawItem()])))
    for (let i = 0; i < 10; i++) expect(JSON.stringify(runOnce(answer([rawItem()])))).toBe(first)
  })
  it('10 cycles of read, bump the count, store leave the text identical', () => {
    let row: Record<string, unknown> = runOnce(answer([rawItem()]))[0] as never
    const first = JSON.parse(JSON.stringify(row))
    for (let i = 0; i < 10; i++) {
      const read = HeartbeatItemRead.parse(JSON.parse(JSON.stringify(row)))
      row = HeartbeatItem.parse({ ...read, count: read.count + 1 }) // the store schema takes a read row unchanged
    }
    const last = row as { title: string; detail: string; why: string }
    expect([last.title, last.detail, last.why]).toEqual([first.title, first.detail, first.why])
  })
  it('raw hidden characters fed straight to the store are refused, not escaped', () => {
    for (const f of ['title', 'detail', 'why'])
      expect(HeartbeatItem.safeParse(item({ [f]: `a‮b` })).success, f).toBe(false)
    expect(HeartbeatItem.safeParse(item({ title: '​' })).success).toBe(false)
  })
  it('the store schema forbids an escape token the escaper would not make', () => {
    expect(HeartbeatItem.safeParse(item({ title: '⟦U+0041⟧' })).success).toBe(false)
  })
})

describe('R2-1: a source error is escaped once too', () => {
  const lv = { silent: 0, fyi: 0, act: 0 }
  const result = (error: string) => ({
    run_key: '2026-10-05T0945',
    outcome: 'failed',
    items_seen: 0,
    items_new: 0,
    seen_by_level: lv,
    new_by_level: lv,
    sources: [{ id: 'gh-main', ok: false, ms: 5, unreadable: 0, error }],
  })
  it('source parse, then the result schema: the error text is the same on every run, and not escaped twice', () => {
    const raw = JSON.stringify({ schema: 'talos.heartbeat-source/1', status: 'error', error: 'bad \u202e token ⟦x⟧' })
    const texts = Array.from({ length: 10 }, () => {
      const r = parseHeartbeatSourceResponse(raw)
      if (r.ok) throw new Error('expected an error')
      return HeartbeatResult.parse(result(r.error)).sources[0]?.error
    })
    expect(new Set(texts).size).toBe(1)
    expect(texts[0]).toBe('bad ⟦U+202E⟧ token ⟦U+27E6⟧x⟧')
  })
  it('a raw hidden character fed straight to the result is refused', () => {
    expect(HeartbeatResult.safeParse(result('a\u202eb')).success).toBe(false)
  })
})

describe('stored rows are read, not rewritten', () => {
  const nasty = `fix‮ ⟦U+0041⟧ ${'é'.repeat(5)}`
  it('the read schema returns stored text exactly as it is', () => {
    const [stored] = runOnce(
      answer([
        { key: 'k', sig: 's', title: nasty, level: 'fyi', class: 'own', why: nasty, deadline: null, detail: nasty },
      ]),
    )
    const read = HeartbeatItemRead.parse(JSON.parse(JSON.stringify(stored)))
    expect([read.title, read.detail, read.why]).toEqual([stored?.title, stored?.detail, stored?.why])
  })
  it('a stored row with a raw hidden character is unreadable (counted), not shown', () => {
    const r = parseHeartbeatItems([
      item({ title: 'ok' }),
      item({ key: 'k2', title: 'fix‮gnp' }),
      item({ key: 'k3', detail: 'a\u0000b' }),
    ])
    expect(r.items.map((i) => i.key)).toEqual(['pr:acme/widgets#12'])
    expect(r.unreadable).toBe(2)
  })
  it('a stored row cannot forge an escape: ⟦U+0041⟧ is not something the escaper makes', () => {
    expect(HeartbeatItemRead.safeParse(item({ title: '⟦U+0041⟧' })).success).toBe(false)
    expect(HeartbeatItemRead.safeParse(item({ title: '⟦U+202E⟧' })).success).toBe(true)
  })
})

describe('tolerant item reads', () => {
  it('HeartbeatItemRead ignores keys it does not know', () => {
    const r = HeartbeatItemRead.parse({ ...item(), future_field: 1 })
    expect(r).not.toHaveProperty('future_field')
  })
  it('a stored row with no deadline reads as deadline null', () => {
    const { deadline: _d, ...old } = item()
    expect(HeartbeatItemRead.parse(old).deadline).toBeNull()
  })
  it('parseHeartbeatItems keeps the readable rows and counts the rest', () => {
    const r = parseHeartbeatItems([item(), item({ level: 'loud' }), 'nope', item({ key: 'pr:acme/widgets#13' })])
    expect(r.items.map((i) => i.key)).toEqual(['pr:acme/widgets#12', 'pr:acme/widgets#13'])
    expect(r.unreadable).toBe(2)
  })
  it('parseHeartbeatItems on a non-array is zero items, one unreadable', () => {
    expect(parseHeartbeatItems({})).toEqual({ items: [], unreadable: 1 })
  })
})

describe('HeartbeatConfig: limits and per-kind args', () => {
  const src = (over: Record<string, unknown>) => HeartbeatSourceConfig.safeParse({ ...inbox, ...over }).success
  it('source timeout is 5 to 60 seconds', () => {
    expect([src({ timeout_s: 4 }), src({ timeout_s: 5 }), src({ timeout_s: 60 }), src({ timeout_s: 61 })]).toEqual([
      false,
      true,
      true,
      false,
    ])
  })
  it('run timeout is 30 to 150, wake cap is 1 to 6', () => {
    const ok = (o: Record<string, unknown>) => HeartbeatConfig.safeParse(config(o)).success
    expect([29, 30, 150, 151].map((n) => ok({ run_timeout_s: n }))).toEqual([false, true, true, false])
    expect([0, 1, 6, 7].map((n) => ok({ wake_cap_per_day: n }))).toEqual([false, true, true, false])
  })
  it('at most 12 sources, at least 1', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...inbox, id: `inbox-${i}` }))
    expect(HeartbeatConfig.safeParse(config({ sources: many(12), mutes: [] })).success).toBe(true)
    expect(HeartbeatConfig.safeParse(config({ sources: many(13), mutes: [] })).success).toBe(false)
    expect(HeartbeatConfig.safeParse(config({ sources: [] })).success).toBe(false)
  })
  it('github takes 1 to 20 repos written owner/name', () => {
    const g = (repos: unknown) => src({ kind: 'github', args: { repos } })
    expect([g([]), g(['acme/widgets']), g(['nope']), g(['a/b/c']), g(['x y/z'])]).toEqual([
      false,
      true,
      false,
      false,
      false,
    ])
    expect(g(Array.from({ length: 20 }, (_, i) => `acme/r${i}`))).toBe(true)
    expect(g(Array.from({ length: 21 }, (_, i) => `acme/r${i}`))).toBe(false)
    expect(src({ kind: 'github', args: {} })).toBe(false)
  })
  it('schedule-failures and inbox take no args; an unknown arg is refused when Talos writes', () => {
    expect(src({ kind: 'schedule-failures', args: {} })).toBe(true)
    expect(src({ kind: 'inbox', args: { all: true } })).toBe(false)
    expect(src({ kind: 'schedule-failures', args: { x: 1 } })).toBe(false)
  })
  it('command: argv 1 to 20 strings, argv[0] absolute, run directly', () => {
    const c = (args: unknown) => src({ kind: 'command', args })
    expect(c({ argv: ['/usr/bin/true'] })).toBe(true)
    expect([c({ argv: [] }), c({ argv: ['true'] }), c({ argv: ['./true'] }), c({ argv: [1] }), c({})]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ])
    expect(c({ argv: ['/bin/x', ...Array.from({ length: 19 }, () => 'a')] })).toBe(true)
    expect(c({ argv: ['/bin/x', ...Array.from({ length: 20 }, () => 'a')] })).toBe(false)
    expect(c({ argv: ['/bin/x', 'a\u0000b'] })).toBe(false)
    expect(c({ argv: ['/bin/x'], shell: true })).toBe(false)
  })
  it('command: cwd is absolute, env has at most 10 names matching [A-Z_][A-Z0-9_]*', () => {
    const c = (extra: Record<string, unknown>) => src({ kind: 'command', args: { argv: ['/bin/x'], ...extra } })
    expect([c({ cwd: '/home/alex' }), c({ cwd: 'home' }), c({ cwd: '../x' })]).toEqual([true, false, false])
    expect(c({ env: { FOO_1: 'x', _B: 'y' } })).toBe(true)
    for (const bad of ['foo', '1A', 'A-B', 'A B', ''] as const) expect(c({ env: { [bad]: 'x' } }), bad).toBe(false)
    const env = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`V${i}`, 'x']))
    expect(c({ env: env(10) })).toBe(true)
    expect(c({ env: env(11) })).toBe(false)
  })
  it('an unknown kind is refused when Talos writes', () => {
    expect(src({ kind: 'slack' })).toBe(false)
  })
  it('refuses duplicate source ids, a mute for a source that is not there', () => {
    expect(HeartbeatConfig.safeParse(config({ sources: [gh, gh] })).success).toBe(false)
    expect(HeartbeatConfig.safeParse(config({ mutes: [{ source: 'nope', until: T2 }] })).success).toBe(false)
  })
  it('the meta it makes is a valid JobMeta under 4 KiB, and a config over it is refused in plain words', () => {
    const m = heartbeatMetaOf(HeartbeatConfig.parse(config()))
    expect(m.ok && Object.keys(m.meta)).toEqual([HEARTBEAT_META_KEY])
    expect(m.ok && JobMeta.safeParse(m.meta).success).toBe(true)
    const big = HeartbeatConfig.parse(
      config({
        mutes: Array.from({ length: 20 }, (_, i) => ({ source: 'gh-main', key: `k${i}${'x'.repeat(150)}`, until: T2 })),
      }),
    )
    const r = heartbeatMetaOf(big)
    expect(!r.ok && r.problem).toMatch(/too big to save \(\d+ of 4096 bytes\)/)
    expect(META_MAX_BYTES).toBe(4096)
  })
})

describe('BUG 7: the read side is loose at every depth', () => {
  const read = (c: unknown) => heartbeatConfigFromMeta(metaOf(c))
  it('unknown keys inside a source, its args, a mute and the config are ignored', () => {
    const c = config({
      future: 1,
      sources: [
        { ...gh, extra: 1, args: { repos: ['acme/widgets'], branch: 'main' } },
        { ...cmd, args: { ...cmd.args, shell: true } },
      ],
      mutes: [{ source: 'gh-main', key: 'k', until: T2, note: 'x' }],
    })
    const r = read(c)
    expect(r && 'config' in r).toBe(true)
    if (r && 'config' in r) {
      expect(r.config.sources).toHaveLength(2)
      expect(JSON.stringify(r.config)).not.toContain('branch')
    }
  })
  it('the strict config still refuses the same unknown keys', () => {
    expect(HeartbeatConfig.safeParse(config({ sources: [{ ...gh, extra: 1 }] })).success).toBe(false)
    expect(
      HeartbeatConfig.safeParse(config({ sources: [{ ...gh, args: { repos: ['a/b'], branch: 'm' } }] })).success,
    ).toBe(false)
    expect(HeartbeatConfig.safeParse(config({ mutes: [{ source: 'gh-main', until: T2, note: 'x' }] })).success).toBe(
      false,
    )
  })
  it('none, readable, or a plain problem; an unknown source kind is skipped (with its mutes) and counted', () => {
    expect(heartbeatConfigFromMeta(null)).toBeNull()
    expect(heartbeatConfigFromMeta({ heartbeat: config() })).toBeNull() // the old key is not Heartbeat's
    const future = config({
      sources: [gh, { id: 'chat', kind: 'slack', enabled: true, args: { x: 1 }, timeout_s: 10 }],
      mutes: [{ source: 'chat', until: T2 }],
    })
    const r = read(future)
    expect(r && 'config' in r && [r.config.sources.length, r.config.mutes.length, r.skipped]).toEqual([1, 0, 1])
    const bad = read({ sources: 'x' })
    expect(bad && 'problem' in bad).toBe(true)
  })
})

describe('BUG 6: the strict check every write path asks (heartbeatMetaProblem)', () => {
  const times = { type: 'times' }
  it('no heartbeat key: nothing to say, any job', () => {
    expect(heartbeatMetaProblem({ other: 1 }, { type: 'daily' })).toBeNull()
    expect(heartbeatMetaProblem(null, undefined)).toBeNull()
    expect(heartbeatMetaProblem({ heartbeat: { sources: 'x' } }, { type: 'daily' })).toBeNull()
  })
  it('a good heartbeat on a times job: fine, other meta keys beside it allowed', () => {
    expect(heartbeatMetaProblem({ ...metaOf(config()), note: 'x' }, times)).toBeNull()
  })
  it('an unreadable heartbeat is refused with a plain message', () => {
    const p = heartbeatMetaProblem(metaOf({ sources: 'x' }), times)
    expect(p).toMatch(/not valid/)
    expect(p).toContain('Nothing was saved')
  })
  it('an unknown source kind is refused and the message names it', () => {
    const p = heartbeatMetaProblem(
      metaOf(config({ sources: [gh, { id: 'chat', kind: 'slack', enabled: true, args: {}, timeout_s: 10 }] })),
      times,
    )
    expect(p).toContain('kind this Talos doesn\'t know ("slack")')
  })
  it('an unknown key anywhere is refused (the strict config)', () => {
    expect(heartbeatMetaProblem(metaOf(config({ future: 1 })), times)).not.toBeNull()
    expect(heartbeatMetaProblem(metaOf(config({ sources: [{ ...gh, extra: 1 }] })), times)).not.toBeNull()
  })
  it('a job without several fire times is refused', () => {
    for (const when of [{ type: 'daily' }, { type: 'once' }, undefined, null])
      expect(heartbeatMetaProblem(metaOf(config()), when), JSON.stringify(when)).toContain('several times a day')
  })
  it('a hostile kind in the message is escaped', () => {
    const p = heartbeatMetaProblem(metaOf(config({ sources: [{ ...gh, id: 'zz', kind: 'a‮b' }] })), times)
    expect(p).toContain('⟦U+202E⟧')
  })
})

describe('configHash', () => {
  it('is sha256:<hex>, ignores key order and changes with any setting', () => {
    const a = HeartbeatConfig.parse(config())
    const reordered = HeartbeatConfig.parse(Object.fromEntries(Object.entries(config()).reverse()))
    expect(configHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(configHash(reordered)).toBe(configHash(a))
    expect(configHash(HeartbeatConfig.parse(config({ wake_cap_per_day: 4 })))).not.toBe(configHash(a))
    expect(configHash(HeartbeatConfig.parse(config({ sources: [gh, { ...inbox, timeout_s: 21 }] })))).not.toBe(
      configHash(a),
    )
  })
})

describe('BUG 2: mute-only change compares the raw heartbeat', () => {
  const NOW = '2026-10-05T12:00:00.000Z'
  const base = metaOf(config())
  const withMutes = (mutes: unknown, extra: Record<string, unknown> = {}) => metaOf({ ...config(extra), mutes })
  const mute = (over: Record<string, unknown>) => ({
    source: 'gh-main',
    key: 'pr:acme/widgets#9',
    until: '2026-10-20T00:00:00.000Z',
    ...over,
  })
  const kept = config().mutes
  it('adding an exact-key mute ending within 30 days is a mute-only change', () => {
    expect(heartbeatMuteOnlyChange(base, withMutes([...kept, mute({})]), NOW)).toBe(true)
  })
  it('30 days to the millisecond is in; one millisecond more is out', () => {
    const edge = new Date(Date.parse(NOW) + 30 * 86_400_000)
    expect(heartbeatMuteOnlyChange(base, withMutes([...kept, mute({ until: edge.toISOString() })]), NOW)).toBe(true)
    expect(
      heartbeatMuteOnlyChange(base, withMutes([...kept, mute({ until: new Date(+edge + 1).toISOString() })]), NOW),
    ).toBe(false)
  })
  it('a whole-source mute (no key) is not low risk, whatever its end', () => {
    const { key: _k, ...whole } = mute({})
    expect(heartbeatMuteOnlyChange(base, withMutes([...kept, whole]), NOW)).toBe(false)
  })
  it('a mute longer than 30 days is not low risk', () => {
    expect(heartbeatMuteOnlyChange(base, withMutes([...kept, mute({ until: '2026-12-31T00:00:00.000Z' })]), NOW)).toBe(
      false,
    )
  })
  it('with no clock a new mute cannot be judged, so it is not low risk; removing one needs no clock', () => {
    expect(heartbeatMuteOnlyChange(base, withMutes([...kept, mute({})]))).toBe(false)
    expect(heartbeatMuteOnlyChange(base, withMutes([]))).toBe(true)
  })
  it('an unknown key in the heartbeat, at any depth, is not low risk', () => {
    expect(heartbeatMuteOnlyChange(base, withMutes([], { future: 1 }), NOW)).toBe(false)
    expect(
      heartbeatMuteOnlyChange(base, metaOf({ ...config({ mutes: [] }), sources: [{ ...gh, extra: 1 }, inbox] }), NOW),
    ).toBe(false)
    expect(heartbeatMuteOnlyChange(base, withMutes([...kept, { ...mute({}), note: 'x' }]), NOW)).toBe(false) // even inside a mute
  })
  it('an unknown key smuggled in beside a mute change that otherwise would pass is high (the old loose compare said low)', () => {
    const loose = metaOf({ ...config(), wake_cap_per_day: 3, extra_cap: 999, mutes: [] })
    expect(heartbeatMuteOnlyChange(base, loose, NOW)).toBe(false)
  })
  it('any other change is high: sources, cap, mode, timeouts, other meta keys', () => {
    expect(heartbeatMuteOnlyChange(base, metaOf(config({ wake_cap_per_day: 4 })), NOW)).toBe(false)
    expect(heartbeatMuteOnlyChange(base, metaOf(config({ mode: 'live' })), NOW)).toBe(false)
    expect(heartbeatMuteOnlyChange(base, metaOf(config({ run_timeout_s: 100 })), NOW)).toBe(false)
    expect(heartbeatMuteOnlyChange(base, metaOf(config({ sources: [gh, { ...inbox, timeout_s: 21 }] })), NOW)).toBe(
      false,
    )
    expect(heartbeatMuteOnlyChange(base, { ...base, extra: 1 }, NOW)).toBe(false)
  })
  it('an unreadable side is not a mute-only change', () => {
    expect(heartbeatMuteOnlyChange(base, metaOf({ sources: 'x' }), NOW)).toBe(false)
    expect(heartbeatMuteOnlyChange(null, base, NOW)).toBe(false)
  })
})

describe('source process I/O', () => {
  it('request: the fixture parses, and a bad one does not', () => {
    const r = JSON.parse(fx('request.json'))
    expect(HeartbeatSourceRequest.safeParse(r).success).toBe(true)
    expect(HeartbeatSourceRequest.safeParse({ ...r, since: null, cursor: null }).success).toBe(true)
    expect(HeartbeatSourceRequest.safeParse({ ...r, dry: 'no' }).success).toBe(false)
    expect(HeartbeatSourceRequest.safeParse({ ...r, schema: 'talos.heartbeat-source/2' }).success).toBe(false)
    expect(HeartbeatSourceRequest.safeParse({ ...r, extra: 1 }).success).toBe(false)
  })
  it('response ok (fixture): the good items come through, the one with an unknown level is counted, not fatal', () => {
    const r = parseHeartbeatSourceResponse(fx('response-ok.json'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items.map((i) => i.key)).toEqual(['pr:acme/widgets#12', 'pr:acme/widgets#13', 'mail:7'])
    expect(r.unreadable).toBe(1)
    expect(r.cursor).toEqual({ etag: 'W/"a2"' })
    expect(r.items[0]?.deadline).toBe('2026-10-06T17:00:00-04:00')
    expect(r.items[2]?.deadline).toBeNull()
  })
  it('response error (fixture): a source error carrying the message', () => {
    expect(parseHeartbeatSourceResponse(fx('response-error.json'))).toEqual({
      ok: false,
      error: 'github: 401 bad credentials',
    })
  })
  it('response oversize (fixture, 51 items): a source error, not 50 items', () => {
    const r = parseHeartbeatSourceResponse(fx('response-oversize.json'))
    expect(r).toEqual({ ok: false, error: 'the source returned 51 items; the limit is 50' })
  })
  it('exactly 50 items is fine', () => {
    const o = JSON.parse(fx('response-oversize.json'))
    o.items = o.items.slice(0, 50)
    const r = parseHeartbeatSourceResponse(JSON.stringify(o))
    expect(r.ok && r.items.length).toBe(50)
  })
  it('over 256 KiB is a source error, not a cut-off; the line is under the limit and the bytes are counted, not characters', () => {
    const ok = { schema: 'talos.heartbeat-source/1', status: 'ok', cursor: { pad: '' }, items: [] }
    const mk = (bytes: number) => {
      const s0 = JSON.stringify(ok)
      return JSON.stringify({ ...ok, cursor: { pad: 'x'.repeat(bytes - s0.length) } })
    }
    expect(parseHeartbeatSourceResponse(mk(HEARTBEAT_SOURCE_MAX_BYTES)).ok).toBe(true)
    const over = parseHeartbeatSourceResponse(mk(HEARTBEAT_SOURCE_MAX_BYTES + 1))
    expect(over).toEqual({
      ok: false,
      error: `the source printed ${HEARTBEAT_SOURCE_MAX_BYTES + 1} bytes; the limit is 262144 (256 KiB)`,
    })
    // 3-byte characters: 100k of them are 100k characters but 300k bytes
    const wide = JSON.stringify({ ...ok, cursor: { pad: '€'.repeat(100_000) } })
    expect(parseHeartbeatSourceResponse(wide).ok).toBe(false)
  })
  it('not JSON, a wrong schema, an unknown status, and ok carrying an error are source errors', () => {
    const ok = { schema: 'talos.heartbeat-source/1', status: 'ok', cursor: null, items: [] }
    const bad = (o: unknown) => parseHeartbeatSourceResponse(typeof o === 'string' ? o : JSON.stringify(o))
    for (const o of [
      '{oops',
      '',
      '[]',
      { ...ok, schema: 'talos.heartbeat-source/9' },
      { ...ok, status: 'maybe' },
      { ...ok, error: 'but fine' },
      { ...ok, items: 'x' },
      { schema: ok.schema, status: 'ok', items: [] },
    ])
      expect(bad(o).ok, JSON.stringify(o)).toBe(false)
  })
  it('an ok answer with no items key is an error, never an empty list', () => {
    expect(
      parseHeartbeatSourceResponse(JSON.stringify({ schema: 'talos.heartbeat-source/1', status: 'ok', cursor: null }))
        .ok,
    ).toBe(false)
  })
  it('hostile text in an item or an error is capped and escaped on the way in', () => {
    const r = parseHeartbeatSourceResponse(
      JSON.stringify({
        schema: 'talos.heartbeat-source/1',
        status: 'ok',
        cursor: null,
        items: [
          {
            key: 'k',
            sig: 's',
            title: `‮${'t'.repeat(500)}`,
            level: 'act',
            class: 'work',
            why: 'r',
            deadline: null,
            url: 'javascript:1',
          },
          { key: 'k2', sig: 's', title: `‮x`, level: 'act', class: 'work', why: 'r', deadline: null },
        ],
      }),
    )
    expect(r.ok && r.items).toHaveLength(1) // the javascript: url costs that one item
    expect(r.ok && r.unreadable).toBe(1)
    expect(r.ok && r.items[0]?.title).toBe('⟦U+202E⟧x')
    const e = parseHeartbeatSourceResponse(
      JSON.stringify({ schema: 'talos.heartbeat-source/1', status: 'error', error: `‮${'e'.repeat(9000)}` }),
    )
    expect(!e.ok && e.error.startsWith('⟦U+202E⟧eee')).toBe(true)
    expect(!e.ok && e.error.length).toBeLessThan(260)
  })
})

describe('HeartbeatResult', () => {
  const lv = (silent: number, fyi: number, act: number) => ({ silent, fyi, act })
  const res = (over: Record<string, unknown> = {}) => ({
    run_key: '2026-10-05T0945',
    outcome: 'partial',
    items_seen: 5,
    items_new: 1,
    seen_by_level: lv(2, 2, 1),
    new_by_level: lv(0, 1, 0),
    sources: [
      { id: 'gh-main', ok: true, ms: 420, unreadable: 0 },
      { id: 'inbox', ok: false, ms: 20_000, unreadable: 0, error: 'timed out' },
    ],
    ...over,
  })
  it('has seven outcomes, partial among them', () => {
    for (const outcome of ['silent', 'fyi', 'woke', 'capped', 'quiet', 'partial', 'failed'])
      expect(HeartbeatResult.safeParse(res({ outcome })).success, outcome).toBe(true)
    expect(HeartbeatResult.safeParse(res({ outcome: 'loud' })).success).toBe(false)
  })
  it('counts by level must add up to the totals', () => {
    expect(HeartbeatResult.safeParse(res({ seen_by_level: lv(2, 2, 2) })).success).toBe(false)
    expect(HeartbeatResult.safeParse(res({ new_by_level: lv(1, 1, 0) })).success).toBe(false)
    expect(HeartbeatResult.safeParse(res({ seen_by_level: { silent: 2, fyi: 2, act: 1, hold: 0 } })).success).toBe(
      false,
    )
  })
  it('a source that is ok cannot carry an error', () => {
    expect(
      HeartbeatResult.safeParse(
        res({ sources: [{ id: 'gh-main', ok: true, ms: 1, unreadable: 0, error: 'but fine' }] }),
      ).success,
    ).toBe(false)
  })
  it('ms is at most 150000', () => {
    const s = (ms: number) =>
      HeartbeatResult.safeParse(res({ sources: [{ id: 'gh-main', ok: true, ms, unreadable: 0 }] })).success
    expect([s(150_000), s(150_001)]).toEqual([true, false])
  })
  it('takes a slot key or a date as run_key, and refuses other text and negative counts', () => {
    expect(HeartbeatResult.safeParse(res({ run_key: '2026-10-05' })).success).toBe(true)
    expect(HeartbeatResult.safeParse(res({ run_key: 'today' })).success).toBe(false)
    expect(HeartbeatResult.safeParse(res({ items_new: -1 })).success).toBe(false)
  })
})

describe('R2-2: dropped items are visible in the result', () => {
  const lv = (silent: number, fyi: number, act: number) => ({ silent, fyi, act })
  const res = (outcome: string, unreadable: number) => ({
    run_key: '2026-10-05T0945',
    outcome,
    items_seen: 0,
    items_new: 0,
    seen_by_level: lv(0, 0, 0),
    new_by_level: lv(0, 0, 0),
    sources: [{ id: 'gh-main', ok: true, ms: 10, unreadable }],
  })
  it('a source entry carries the count of items dropped as unreadable, and it is required', () => {
    expect(HeartbeatResult.safeParse(res('partial', 3)).success).toBe(true)
    const noCount = { ...res('partial', 0), sources: [{ id: 'gh-main', ok: true, ms: 10 }] }
    expect(HeartbeatResult.safeParse(noCount).success).toBe(false)
    expect(HeartbeatResult.safeParse(res('partial', -1)).success).toBe(false)
  })
  it('a source that sent items of which ALL were unreadable cannot be reported silent; partial is allowed', () => {
    const r = parseHeartbeatSourceResponse(answer([{ nope: 1 }, { level: 'loud' }]))
    expect(r.ok && [r.items.length, r.unreadable]).toEqual([0, 2])
    const unreadable = r.ok ? r.unreadable : 0
    expect(HeartbeatResult.safeParse(res('silent', unreadable)).success).toBe(false)
    expect(HeartbeatResult.safeParse(res('partial', unreadable)).success).toBe(true)
  })
  it('silent with nothing dropped is still fine', () => {
    expect(HeartbeatResult.safeParse(res('silent', 0)).success).toBe(true)
  })
})

describe('R2-3: environment names that change how a program loads or finds things are refused', () => {
  const env = (name: string) =>
    HeartbeatSourceConfig.safeParse({ ...cmd, args: { argv: ['/bin/x'], env: { [name]: 'x' } } }).success
  const refused = [
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'NODE_OPTIONS',
    'NODE_PATH',
    'PYTHONPATH',
    'PYTHONSTARTUP',
    'PYTHONHOME',
    'PERL5LIB',
    'PERL5OPT',
    'RUBYOPT',
    'BASH_ENV',
    'ENV',
    'PATH',
    'HOME',
    'SHELL',
    'IFS',
  ]
  for (const n of refused) it(`${n} is refused`, () => expect(env(n)).toBe(false))
  it('ordinary names are still fine, including ones that merely contain a refused word', () => {
    for (const n of ['LANG', 'TZ', 'MY_PATH', 'HOMEDIR', 'ENVIRON', 'PATHS', 'SHELLY', 'NODE_ENV', 'TOKEN_FILE'])
      expect(env(n), n).toBe(true)
  })
  it('the message says why in plain words', () => {
    const p = heartbeatMetaProblem(
      {
        [HEARTBEAT_META_KEY]: config({
          sources: [{ ...cmd, args: { argv: ['/bin/x'], env: { LD_PRELOAD: 'x' } } }],
          mutes: [],
        }),
      },
      { type: 'times' },
    )
    expect(p).toContain('changes how a program loads')
  })
})

describe('R2-4: no secrets in env (it is shown on the approval card and stored in jobs.json)', () => {
  const val = (v: string) =>
    HeartbeatSourceConfig.safeParse({ ...cmd, args: { argv: ['/bin/x'], env: { FOO: v } } }).success
  const secrets = [
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'gho_abcdef',
    'github_pat_11ABC',
    'xoxb-1234-abcd',
    'xoxp-1234-abcd',
    'sk-abc',
    'AKIAIOSFODNN7EXAMPLE',
  ]
  for (const v of secrets) it(`${v.slice(0, 8)}… is refused`, () => expect(val(v)).toBe(false))
  it('a long high-entropy string over 32 characters is refused', () => {
    expect(val('q8Zr3KvB1xLw9PtN4yHs7DfG2jMc6VbX5aE0')).toBe(false)
    expect(val('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c')).toBe(false)
  })
  it('ordinary values are fine: short words, paths, a long plain sentence-like or repetitive value', () => {
    for (const v of [
      'C',
      'en_US.UTF-8',
      '/home/alex/.config/watch/settings.json',
      'x'.repeat(40),
      'a-very-long-but-plain-label-name-here',
      'sk',
      'task-1',
    ])
      expect(val(v), v).toBe(true)
  })
  it('the message says secrets do not belong there', () => {
    const p = heartbeatMetaProblem(
      {
        [HEARTBEAT_META_KEY]: config({
          sources: [{ ...cmd, args: { argv: ['/bin/x'], env: { FOO: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } } }],
          mutes: [],
        }),
      },
      { type: 'times' },
    )
    expect(p).toContain('looks like a secret')
  })
})

describe('R2-7: a mute matches by exact string equality, never by pattern', () => {
  const NOW = '2026-10-05T12:00:00.000Z'
  const m = (key: string | undefined, until = '2026-10-12T00:00:00.000Z') => ({
    source: 'gh-main',
    ...(key === undefined ? {} : { key }),
    until,
  })
  const hit = (mute: ReturnType<typeof m>, source: string, key: string, now = NOW) =>
    heartbeatMuteMatches([mute], { source, key }, now)
  it('the same source and the same key', () => expect(hit(m('pr:1'), 'gh-main', 'pr:1')).toBe(true))
  it('a key with pattern characters matches only itself', () => {
    for (const k of ['pr:*', 'pr:.*', 'pr:[0-9]', 'pr:?', '^pr:1$']) {
      expect(hit(m(k), 'gh-main', 'pr:1'), k).toBe(false)
      expect(hit(m(k), 'gh-main', k), k).toBe(true)
    }
  })
  it('no prefix, suffix, case-folding or whitespace-trimming match', () => {
    expect(hit(m('pr:1'), 'gh-main', 'pr:12')).toBe(false)
    expect(hit(m('pr:1'), 'gh-main', 'xpr:1')).toBe(false)
    expect(hit(m('pr:A'), 'gh-main', 'pr:a')).toBe(false)
    expect(hit(m('pr:1'), 'gh-main', 'pr:1 ')).toBe(false)
  })
  it('a different source never matches', () => expect(hit(m('pr:1'), 'inbox', 'pr:1')).toBe(false))
  it('a mute with no key mutes the whole source', () => {
    expect(hit(m(undefined), 'gh-main', 'anything')).toBe(true)
    expect(hit(m(undefined), 'inbox', 'anything')).toBe(false)
  })
  it('a mute that has ended does not match (at the instant it ends, it is over)', () => {
    expect(hit(m('pr:1', '2026-10-05T12:00:00.000Z'), 'gh-main', 'pr:1')).toBe(false)
    expect(hit(m('pr:1', '2026-10-05T12:00:00.001Z'), 'gh-main', 'pr:1')).toBe(true)
  })
  it('a clock that cannot be read matches nothing', () => expect(hit(m('pr:1'), 'gh-main', 'pr:1', 'nope')).toBe(false))
})

describe('HB2 review: source class, repo names', () => {
  const src = (over: Record<string, unknown>) => ({
    id: 'gh-main',
    kind: 'github',
    enabled: true,
    args: { repos: ['acme/widgets'] },
    timeout_s: 30,
    ...over,
  })
  const cfg = (sources: unknown[]) => ({
    schema: 'talos.heartbeat/1',
    mode: 'shadow',
    sources,
    mutes: [],
    wake_cap_per_day: 3,
    run_timeout_s: 120,
  })

  it('a source may say class work or own; absent stays absent (the hash of an older config does not move)', () => {
    expect(HeartbeatConfig.safeParse(cfg([src({ class: 'work' })])).success).toBe(true)
    expect(HeartbeatConfig.safeParse(cfg([src({ class: 'own' })])).success).toBe(true)
    expect(HeartbeatConfig.safeParse(cfg([src({ class: 'urgent' })])).success).toBe(false)
    const plain = HeartbeatConfig.parse(cfg([src({})]))
    expect('class' in (plain.sources[0] as object)).toBe(false)
  })
  it('reading is tolerant, and an unknown class is treated as work, never own', () => {
    const r = heartbeatConfigFromMeta({
      [HEARTBEAT_META_KEY]: cfg([
        src({ class: 'urgent' }),
        src({ id: 'gh-two', class: 'own' }),
        src({ id: 'gh-three' }),
      ]),
    })
    expect(r && 'config' in r).toBe(true)
    if (r && 'config' in r) {
      expect(r.config.sources[0]?.class).toBe('work')
      expect(r.config.sources[1]?.class).toBe('own')
      expect('class' in (r.config.sources[2] as object)).toBe(false)
    }
  })
  it('a repo owner or name of "." or ".." is refused', () => {
    for (const bad of ['./widgets', '../widgets', 'acme/.', 'acme/..', '../..'])
      expect(HeartbeatConfig.safeParse(cfg([src({ args: { repos: [bad] } })])).success, bad).toBe(false)
    expect(HeartbeatConfig.safeParse(cfg([src({ args: { repos: ['acme/widgets.js', 'a.b/c..d'] } })])).success).toBe(
      true,
    )
  })
})
