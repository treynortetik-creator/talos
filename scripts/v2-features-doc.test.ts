// scripts/v2-features-doc.ts turns the v2 features design spec into docs/V2-FEATURES.md: the front matter goes, any
// private appendix goes, the WP-V0 calls are applied, and it refuses to write anything that mentions an appendix or a
// private path. Same pattern as claude-code-doc.test.ts.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'v2-features-doc.ts')
const j = (...p: string[]) => p.join('')

// Every sentence a WP-V0 call rewrites, so the sample spec exercises each SCRUB rule.
const CALLS = [
  '- **Relay features** go in a new `ready.relay_features` that the relay fills from its own code.',
  '  `hub.ts` dispatch; the `relay_features` and last-known `presence.features`.',
  '     the existing attach path as a follow-up message with a `voice_reply` attachment and `reply_to` the text message.',
  '| Shortcut token | external | summarise, triage, propose a card. A "save this" note becomes a one-tap card ("Save to notes?") |',
  '- **The cost to the owner** is one tap for "save this" from the iPhone. Summarising and triaging stay free (V10 Q3).',
  '3. They arrive as untrusted Inbox data. The agent summarises and offers a card',
  '   ("Save to notes?", "Draft a reply?"), so "do X" from the iPhone share sheet costs one tap. Instructions that act',
  "- **Never exposed** (`memory/deny.ts`; config can't override it). Feature `memory/1` is advertised.",
]

const spec = (extra = '', appendix = false) =>
  [
    '# Talos app: v2 features addendum (2026-10-29, rev 2)',
    '',
    '> - **Labels.** front matter.',
    '',
    '## Changelog',
    '',
    '| 2 | 2026-10-29 | Answers the review |',
    '',
    '## V0. Answer in one screen',
    '',
    'Public text.',
    '',
    ...CALLS,
    '',
    extra,
    '## Sources (fetched 2026-10-29)',
    '',
    '- Review: `V2-FEATURES-REVIEW.md` (2026-10-29).',
    ...(appendix ? ['', j('## Appendix', ' P (private)'), '', j('- evidence: private', ' row')] : []),
    '',
  ].join('\n')

function run(input: string, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'v2doc-'))
  const src = join(dir, 'spec.md')
  const out = join(dir, 'V2-FEATURES.md')
  writeFileSync(src, input)
  const r = spawnSync(process.execPath, [script, src, '--out', out, ...args], { encoding: 'utf8' })
  let text = ''
  try {
    text = readFileSync(out, 'utf8')
  } catch {}
  return { code: r.status, out: `${r.stdout}${r.stderr}`, text, outPath: out, src }
}

describe('v2-features-doc.ts', () => {
  it('drops the front matter and changelog, writes the repo header with the WP-V0 calls, applies them', () => {
    const r = run(spec())
    expect(r.code, r.out).toBe(0)
    expect(r.text.startsWith('# Talos app: v2 features addendum (rev 2)\n')).toBe(true)
    expect(r.text).toContain('Calls made while building WP-V0')
    expect(r.text).toContain('## V0. Answer in one screen')
    expect(r.text).not.toContain('## Changelog')
    expect(r.text).not.toContain('front matter')
    expect(r.text).not.toContain('one-tap card')
    expect(r.text).not.toContain('relay_features')
    expect(r.text).toContain('sent `silent`')
    expect(r.text).toContain('`src/memory/deny.ts`')
    expect(r.text).toContain('`memory/1`') // a feature flag is not a private path
    expect(r.text).not.toContain('REVIEW.md')
  })
  it('drops a private appendix if one appears', () => {
    const r = run(spec('', true))
    expect(r.code, r.out).toBe(0)
    expect(r.text).not.toContain('private row')
    expect(r.text).not.toContain(j('Appendix', ' P'))
  })
  it('fails (and writes nothing) when the appendix is referenced in the public text', () => {
    const r = run(spec(j('See Appendix', ' P for the dates.')))
    expect(r.code).toBe(1)
    expect(r.text).toBe('')
  })
  for (const leak of [
    j('see `research/desktop', '-app.md` 4.4'),
    j('from `memory/reference', '/x.md`'),
    j('as he said in TG ', '24415'),
    j('/Users/', 'someone/Documents'),
    j('~/Desktop/', 'notes'),
  ]) {
    it(`fails on a private-path pattern: ${leak.slice(0, 12)}…`, () => {
      const r = run(spec(leak))
      expect(r.code).toBe(1)
      expect(r.text).toBe('')
      expect(r.out).not.toContain(leak)
    })
  }
  it('fails when a WP-V0 call no longer matches the spec (the header would lie)', () => {
    const r = run(spec().replace('A "save this" note becomes a one-tap card ("Save to notes?")', 'something else'))
    expect(r.code).toBe(1)
  })
  it('fails when the input has no V0 heading', () => {
    expect(run('# nothing\n').code).toBe(1)
  })
  it('--check fails when the committed copy differs', () => {
    const first = run(spec())
    expect(first.code).toBe(0)
    const again = spawnSync(process.execPath, [script, first.src, '--out', first.outPath, '--check'], {
      encoding: 'utf8',
    })
    expect(again.status).toBe(0)
    writeFileSync(first.outPath, `${first.text}edited\n`)
    const drift = spawnSync(process.execPath, [script, first.src, '--out', first.outPath, '--check'], {
      encoding: 'utf8',
    })
    expect(drift.status).toBe(1)
  })
})

describe('docs/V2-FEATURES.md (committed copy of the design spec)', () => {
  const doc = readFileSync(join(here, '..', 'docs', 'V2-FEATURES.md'), 'utf8')
  it('has no private appendix, no pointer to one and no private-path patterns', () => {
    expect(doc).not.toMatch(/^## Appendix P/m)
    expect(doc).not.toContain(j('Appendix', ' P'))
    expect(doc).not.toMatch(/\bPRIVATE\b/)
    expect(doc).not.toMatch(/(^|[\s`(])(research|memory)\/(?!1(?![A-Za-z0-9_.-]))[A-Za-z0-9_.-]+/m)
    expect(doc).not.toMatch(/\bTG [0-9]/)
    expect(doc).not.toMatch(/\/Users\/[A-Za-z]/)
    expect(doc).not.toMatch(/~\/(Desktop|Documents)\//)
  })
  it('starts at V0 under its own header with the WP-V0 calls and keeps every section through the sources', () => {
    expect(doc.startsWith('# Talos app: v2 features addendum')).toBe(true)
    expect(doc).toContain('Zero-tap share filing')
    for (const h of [
      '## V0.',
      '## V1.',
      '## V2.',
      '## V3.',
      '## V4.',
      '## V5.',
      '## V6.',
      '## V7.',
      '## V8.',
      '## V9.',
      '## V10.',
      '## Sources',
    ])
      expect(doc, h).toContain(h)
    expect(doc).not.toContain('## Changelog')
    expect(doc).not.toContain('one-tap card')
  })
  // With the design spec named (CHECK_PRIVATE_DOCS), no line of a private appendix may appear in the copy.
  const named = (process.env.CHECK_PRIVATE_DOCS ?? '').split(':').filter((d) => d && existsSync(d))
  it.skipIf(named.length === 0)('contains no line of a named private appendix', () => {
    for (const d of named) {
      const lines = readFileSync(d, 'utf8').split('\n')
      const at = lines.findIndex((l) => l.startsWith(j('## Appendix', ' P')))
      if (at < 0) continue
      const secret = lines
        .slice(at + 1)
        .map((l) => l.replace(/^[\s>*#|-]+/, '').replace(/[\s|]+$/, ''))
        .filter((l) => l.length >= 24)
      for (const l of secret) expect(doc.includes(l), 'a private appendix line is in docs/V2-FEATURES.md').toBe(false)
    }
  })
})
