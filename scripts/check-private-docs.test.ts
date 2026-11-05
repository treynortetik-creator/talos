// check-no-personal.sh, private-document mode: no line of a private appendix (the "## Appendix P" section of a design
// doc kept outside the repo) may appear anywhere in the repo. The docs are named by CHECK_PRIVATE_DOCS or by the
// gitignored scripts/private-docs.txt, so their paths and contents never land in git.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'check-no-personal.sh')
const generic = join(here, 'denylist.generic.txt')

// Sample private text, built at run time so this file holds nothing the scan would flag.
const j = (...p: string[]) => p.join('')
const SECRET_LINE = j('On the 3rd the tick hung for ', 'forty minutes in a protected folder.')
const SECRET_ROW = j('| 2026-01-02 | job-', 'xyz stalled at 0% CPU, 0 bytes |')
const privateDoc = [
  '# Design',
  '',
  '## S1. Public part',
  '',
  'This sentence is public and may be copied.',
  '',
  j('## Appendix', ' P: PRIVATE evidence'),
  '',
  SECRET_LINE,
  SECRET_ROW,
  '- ok', // too short to be a reliable signal: ignored
  '',
].join('\n')

function run(files: Record<string, string>, opts: { env?: boolean; listFile?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cpd-'))
  const outside = mkdtempSync(join(tmpdir(), 'cpd-private-'))
  const doc = join(outside, 'design.md')
  writeFileSync(doc, privateDoc)
  const scripts = join(root, 'scripts')
  mkdirSync(scripts, { recursive: true })
  writeFileSync(join(scripts, 'check-no-personal.sh'), readFileSync(script))
  writeFileSync(join(scripts, 'denylist.generic.txt'), readFileSync(generic))
  if (opts.listFile) writeFileSync(join(scripts, 'private-docs.txt'), `# private docs\n${doc}\n`)
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), content)
  }
  const env = { ...process.env, CHECK_PRIVATE_DOCS: opts.env ? doc : '' }
  const r = spawnSync('bash', [join(scripts, 'check-no-personal.sh'), root], { encoding: 'utf8', env })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('check-no-personal.sh: private appendix lines', () => {
  it('passes when only the public part of the doc is copied', () => {
    const r = run({ 'docs/X.md': 'This sentence is public and may be copied.\n' }, { env: true })
    expect(r.out).toContain('ok')
    expect(r.code).toBe(0)
  })
  it('fails when a private line is copied, via CHECK_PRIVATE_DOCS', () => {
    const r = run({ 'docs/X.md': `intro\n${SECRET_LINE}\n` }, { env: true })
    expect(r.code).toBe(1)
    expect(r.out).toContain('docs/X.md:2')
  })
  it('fails via the gitignored scripts/private-docs.txt too, and matches inside other markdown', () => {
    const r = run({ 'src/a.ts': `// ${SECRET_ROW.replace(/^\| /, '')}\n` }, { listFile: true })
    expect(r.code).toBe(1)
    expect(r.out).toContain('src/a.ts:1')
  })
  it('never prints the private text itself (only file:line)', () => {
    const r = run({ 'docs/X.md': `${SECRET_LINE}\n` }, { env: true })
    expect(r.out).not.toContain('forty minutes')
  })
  it('fails when a private doc is named but has no Appendix P (a renamed heading must not silently pass)', () => {
    const root = mkdtempSync(join(tmpdir(), 'cpd-'))
    const doc = join(mkdtempSync(join(tmpdir(), 'cpd-private-')), 'd.md')
    writeFileSync(doc, '# nothing private here\n')
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'scripts', 'check-no-personal.sh'), readFileSync(script))
    writeFileSync(join(root, 'scripts', 'denylist.generic.txt'), readFileSync(generic))
    const r = spawnSync('bash', [join(root, 'scripts', 'check-no-personal.sh'), root], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_PRIVATE_DOCS: doc },
    })
    expect(r.status).toBe(2)
  })
  it('ignores a missing optional list file and an empty CHECK_PRIVATE_DOCS', () => {
    expect(run({ 'a.md': 'clean\n' }).code).toBe(0)
  })
})

describe('docs/SCHEDULES.md (committed copy of the design spec)', () => {
  const doc = readFileSync(join(here, '..', 'docs', 'SCHEDULES.md'), 'utf8')
  it('has no private appendix and no pointer to one', () => {
    expect(doc).not.toMatch(/^## Appendix P/m)
    expect(doc).not.toContain('Appendix P')
    expect(doc).not.toMatch(/PRIVATE/)
  })
  it('starts at S1 under its own header, without the design front matter', () => {
    expect(doc.startsWith('# Talos app: Schedules')).toBe(true)
    expect(doc).toContain('## S1. Goals, non-goals, integration contract')
    expect(doc).toContain('## S11. Later')
    expect(doc).not.toContain('## Changelog')
  })
})

describe('docs/CLAUDE-CODE.md (committed copy of the Claude Code design spec)', () => {
  const doc = readFileSync(join(here, '..', 'docs', 'CLAUDE-CODE.md'), 'utf8')
  it('has no private appendix and no pointer to one', () => {
    expect(doc).not.toMatch(/^## Appendix P/m)
    expect(doc).not.toContain(j('Appendix', ' P'))
  })
  // With the design spec named (CHECK_PRIVATE_DOCS, as the architect runs check:personal before every push), no line of
  // its private appendix may appear in the copy. CI has no private doc, so there this case is skipped and the generic
  // checks above and in claude-code-doc.test.ts carry the load.
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
      for (const l of secret) expect(doc.includes(l), 'a private appendix line is in docs/CLAUDE-CODE.md').toBe(false)
    }
  })
})
