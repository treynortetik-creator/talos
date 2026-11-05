// scripts/claude-code-doc.ts turns the Claude Code integration design spec into docs/CLAUDE-CODE.md: the front matter
// and the private appendix go, and it refuses to write anything that still mentions the appendix or a private path.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'claude-code-doc.ts')
const j = (...p: string[]) => p.join('')
const APPX = j('## Appendix', ' P (private; WP-C0 cuts from this heading to the end of the file)')

const spec = (extra = '') =>
  [
    '# Talos app: Claude Code integration addendum (2026-10-29, rev 2.1)',
    '',
    j('> **Public-repo rule.** **Appendix', ' P** at the end holds private evidence.'),
    '',
    '## Changelog',
    '',
    '**Rev 2.1:** things.',
    '',
    '---',
    '',
    '## C0. Answer in one screen',
    '',
    'Public text.',
    '',
    j(
      '**WP-C0 copy step.** Copy C0-C12 only: cut from the first line that **begins** with `## Appendix',
      ' P` to the end of the',
    ),
    "file (inline mentions like this one don't match); then fail if the result still has such a line; then run",
    "`check:personal` with the private denylist, which carries the private notes' folder names and chat-message id patterns",
    "(kept out of this file so it doesn't trip its own check).",
    '',
    extra,
    '---',
    '',
    APPX,
    '',
    j('- evidence: private', ' row'),
    '',
  ].join('\n')

function run(input: string, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ccdoc-'))
  const src = join(dir, 'spec.md')
  const out = join(dir, 'CLAUDE-CODE.md')
  writeFileSync(src, input)
  const r = spawnSync(process.execPath, [script, src, '--out', out, ...args], { encoding: 'utf8' })
  let text = ''
  try {
    text = readFileSync(out, 'utf8')
  } catch {}
  return { code: r.status, out: `${r.stdout}${r.stderr}`, text, outPath: out, src }
}

describe('claude-code-doc.ts', () => {
  it('drops the front matter and the private appendix, rewrites the copy-step paragraph, writes the repo header', () => {
    const r = run(spec())
    expect(r.code, r.out).toBe(0)
    expect(r.text.startsWith('# Talos app: Claude Code integration addendum (rev 2.1)\n')).toBe(true)
    expect(r.text).toContain('## C0. Answer in one screen')
    expect(r.text).toContain('Public text.')
    expect(r.text).toContain('**WP-C0 copy step.** `scripts/claude-code-doc.ts`')
    expect(r.text).not.toContain('Changelog')
    expect(r.text).not.toContain('private row')
    expect(r.text).not.toContain(j('Appendix', ' P'))
  })
  it('fails (and writes nothing) when the appendix is still referenced somewhere it cannot clean', () => {
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
      expect(r.out).not.toContain(leak) // the private text itself is never printed
    })
  }
  it('fails when the input has no C0 heading', () => {
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

describe('docs/CLAUDE-CODE.md (committed copy of the design spec)', () => {
  const doc = readFileSync(join(here, '..', 'docs', 'CLAUDE-CODE.md'), 'utf8')
  it('has no private appendix, no pointer to one and no private-path patterns', () => {
    expect(doc).not.toMatch(/^## Appendix P/m)
    expect(doc).not.toContain(j('Appendix', ' P'))
    expect(doc).not.toMatch(/\bPRIVATE\b/)
    expect(doc).not.toMatch(/(^|[\s`(])(research|memory)\/[A-Za-z0-9_.-]+/m)
    expect(doc).not.toMatch(/\bTG [0-9]/)
    expect(doc).not.toMatch(/\/Users\/[A-Za-z]/)
    expect(doc).not.toMatch(/~\/(Desktop|Documents)\//)
  })
  it('starts at C0 under its own header and keeps every section through the sources', () => {
    expect(doc.startsWith('# Talos app: Claude Code integration addendum')).toBe(true)
    for (const h of [
      '## C0.',
      '## C1.',
      '## C3.',
      '## C4.',
      '## C6.',
      '## C7.',
      '## C10.',
      '## C11.',
      '## C12.',
      '## Sources',
    ])
      expect(doc, h).toContain(h)
    expect(doc).not.toContain('## Changelog')
  })
})
