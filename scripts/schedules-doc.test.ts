// scripts/schedules-doc.ts turns the design spec into docs/SCHEDULES.md: front matter and the private appendix go,
// and it refuses to write anything that still mentions the appendix.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'schedules-doc.ts')
const j = (...p: string[]) => p.join('')
const APPX = j('## Appendix', ' P: PRIVATE evidence (delete before this file goes into `talos-app`)')

const spec = (extra = '') =>
  [
    '# Talos app: Schedules addendum (2026-10-29, rev 3.1)',
    '',
    '> **Status.** Design only.',
    '',
    '## Changelog',
    '',
    '**Rev 3.1:** things.',
    '',
    '---',
    '',
    '## S1. Goals, non-goals, integration contract',
    '',
    'Public text.',
    '',
    j('### S7.1 What actually goes wrong (generic, from one real install; dates in Appendix', ' P)'),
    '',
    extra,
    '---',
    '',
    APPX,
    '',
    j('| 2026-01-02 | private', ' row |'),
    '',
  ].join('\n')

function run(input: string, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'sdoc-'))
  const src = join(dir, 'spec.md')
  const out = join(dir, 'SCHEDULES.md')
  writeFileSync(src, input)
  const r = spawnSync(process.execPath, [script, src, '--out', out, ...args], { encoding: 'utf8' })
  let text = ''
  try {
    text = readFileSync(out, 'utf8')
  } catch {}
  return { code: r.status, out: `${r.stdout}${r.stderr}`, text, outPath: out, src }
}

describe('schedules-doc.ts', () => {
  it('drops the front matter and the private appendix and writes the repo header', () => {
    const r = run(spec())
    expect(r.code, r.out).toBe(0)
    expect(r.text.startsWith('# Talos app: Schedules addendum (rev 3.1)\n')).toBe(true)
    expect(r.text).toContain('## S1. Goals, non-goals, integration contract')
    expect(r.text).toContain('Public text.')
    expect(r.text).not.toContain('Changelog')
    expect(r.text).not.toContain('private row')
    expect(r.text).not.toContain(j('Appendix', ' P'))
    expect(r.text).toContain('### S7.1 What actually goes wrong (generic, from one real install)')
  })
  it('fails (and writes nothing) when the appendix is still referenced somewhere it cannot clean', () => {
    const r = run(spec(j('See Appendix', ' P for the dates.')))
    expect(r.code).toBe(1)
    expect(r.text).toBe('')
  })
  it('fails when the input has no S1 heading', () => {
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
