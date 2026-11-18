// The reviewer eval's scorer and runner (evals/reviewer/README.md), with no model: the matcher (file, lines, severity, the
// must groups), the reader of a reviewer's answer, the case checks (every stored case is well formed and has its patch), and a
// whole run with a stand-in `claude` that answers fixed JSON, so the staging (one commit of the tree before the change, the
// change staged, no history to find the fix in) and the scoring are tested end to end.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { cleanUp, compare, loadCases, main } from './reviewer-eval.ts'
import { type Case, caseProblems, meets, parseReview, scoreCase, scoreRun } from './reviewer-eval-score.ts'

const here = dirname(fileURLToPath(import.meta.url))
vi.setConfig({ testTimeout: scaled(60_000), hookTimeout: scaled(60_000) })
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const c: Case = {
  id: 'x',
  title: 'x',
  base: 'b',
  buggy: 'u',
  fix: 'f',
  expect: [
    {
      file: 'apps/bridge/src/files/put.ts',
      lines: [50, 60],
      severity: 'high',
      must: [
        ['fold', 'NFKC'],
        ['AGENTS', 'instruction'],
      ],
    },
  ],
  decoys: [{ must: [['typo']] }],
}
const f = (o: Record<string, unknown> = {}) => ({
  id: 'F1',
  severity: 'high',
  file: 'apps/bridge/src/files/put.ts',
  line: 55,
  summary: 'The instruction-file check does not fold case like the disk does',
  failure_scenario: 'AGENTſ.md passes and opens as AGENTS.md',
  ...o,
})

describe('the matcher', () => {
  it('a finding in the file and lines, at the severity, matching every group, meets the expected finding', () => {
    expect(meets(f(), c.expect[0] as never)).toBe(true)
    expect(meets(f({ file: './apps/bridge/src/files/put.ts' }), c.expect[0] as never)).toBe(true)
    expect(meets(f({ line: 69 }), c.expect[0] as never)).toBe(true) // within ten lines of the range
  })

  it('another file, lines far off, two steps below the severity, an unknown severity, or a group with no match does not', () => {
    expect(meets(f({ file: 'apps/bridge/src/files/service.ts' }), c.expect[0] as never)).toBe(false)
    expect(meets(f({ line: 200 }), c.expect[0] as never)).toBe(false)
    expect(meets(f({ severity: 'medium' }), c.expect[0] as never)).toBe(true) // one step below still found the bug
    expect(meets(f({ severity: 'low' }), c.expect[0] as never)).toBe(false)
    expect(meets(f({ severity: 'blocker' }), c.expect[0] as never)).toBe(false)
    expect(
      meets(f({ summary: 'names are not checked', failure_scenario: 'AGENTS.md is uploaded' }), c.expect[0] as never),
    ).toBe(false)
  })

  it('scores a case: hit, near, the findings that met nothing, decoys; and a run: recall and severity agreement', () => {
    const hit = scoreCase(c, {
      findings: [f(), f({ id: 'F2', file: 'other.ts', summary: 'a typo', failure_scenario: '' })],
    })
    expect(hit).toMatchObject({
      hit: true,
      matched: ['F1'],
      unmatched: 1,
      decoysFlagged: 1,
      severityExact: 1,
      hitAtTop: true,
    })
    const near = scoreCase(c, { findings: [f({ summary: 'something else', failure_scenario: 'nothing' })] })
    expect(near.hit).toBe(false)
    expect(near.near?.id).toBe('F1')
    const miss = scoreCase(c, { findings: [] })
    expect(miss).toMatchObject({ hit: false, near: null, findings: 0 })
    const run = scoreRun([hit, near, miss])
    expect(run).toMatchObject({ cases: 3, hits: 1, severityAgreement: 1, hitAtTop: 1 })
    expect(run.recall).toBeCloseTo(1 / 3)
  })

  it('severity agreement counts a matched finding at the expected severity; one above or below is counted apart', () => {
    const medium = { ...c, expect: [{ ...(c.expect[0] as object), severity: 'medium' }] } as Case
    expect(scoreCase(medium, { findings: [f({ severity: 'medium' })] })).toMatchObject({ severityExact: 1 })
    expect(scoreCase(medium, { findings: [f({ severity: 'high' })] })).toMatchObject({
      severityExact: 0,
      severityOver: 1,
    })
    expect(scoreCase(medium, { findings: [f({ severity: 'LOW' })] })).toMatchObject({ severityUnder: 1, hit: true })
    const run = scoreRun([
      scoreCase(medium, { findings: [f({ severity: 'medium' })] }),
      scoreCase(medium, { findings: [f()] }),
    ])
    expect(run).toMatchObject({ severityAgreement: 0.5, severityOverShare: 0.5 })
  })

  it('`any`: a change with several real bugs is a hit when one is found, and each one found counts toward finding recall', () => {
    const two: Case = {
      ...c,
      expect_mode: 'any',
      expect: [c.expect[0] as never, { file: 'b.ts', severity: 'high', must: [['race']] }],
    }
    const one = scoreCase(two, { findings: [f()] })
    expect(one).toMatchObject({ hit: true, matched: ['F1', null] })
    const both = scoreCase(two, {
      findings: [f(), f({ id: 'F2', file: 'b.ts', summary: 'a race', failure_scenario: 'two at once' })],
    })
    expect(scoreRun([one, both]).findingRecall).toBeCloseTo(3 / 4)
    // `all` (the default) needs both; one finding never meets two expected ones
    expect(scoreCase({ ...two, expect_mode: 'all' }, { findings: [f()] }).hit).toBe(false)
  })

  it('hit@5 and precision@5 read only the first five findings, in the order given', () => {
    const noise = (i: number) => f({ id: `N${i}`, file: 'other.ts', summary: 'style', failure_scenario: 'none' })
    const late = scoreCase(c, { findings: [noise(1), noise(2), noise(3), noise(4), noise(5), f({ id: 'F9' })] })
    expect(late).toMatchObject({ hit: true, hitAtTop: false, topMatched: 0, topCount: 5 })
    const first = scoreCase(c, { findings: [f(), noise(1)] })
    expect(first).toMatchObject({ hitAtTop: true, topMatched: 1, topCount: 2 })
    expect(scoreRun([late, first]).precisionAtTop).toBeCloseTo(1 / 7)
  })

  it('an expected finding may name several files', () => {
    const e = { ...c.expect[0], file: ['a/one.ts', 'apps/bridge/src/files/put.ts'] }
    expect(meets(f(), e as never)).toBe(true)
  })
})

describe("reading a reviewer's answer", () => {
  it('takes plain JSON, JSON in a fence or after a sentence, and nothing else', () => {
    const j = { reviewed: [], findings: [f()], not_checked: [] }
    expect(parseReview(JSON.stringify(j))?.findings).toHaveLength(1)
    expect(parseReview(`Here it is:\n\`\`\`json\n${JSON.stringify(j)}\n\`\`\``)?.findings).toHaveLength(1)
    expect(parseReview(`I found {braces} in prose first. ${JSON.stringify(j)} done`)?.findings).toHaveLength(1)
    expect(parseReview('no review here')).toBeNull()
  })
})

describe('the cases', () => {
  it('every stored case is well formed and has its patch', () => {
    const all = loadCases(join(here, '..', 'evals', 'reviewer', 'cases'))
    expect(all.length).toBeGreaterThanOrEqual(10)
    for (const x of all) expect(x.problems, x.c.id).toEqual([])
  })

  it('a case with no file, a bad severity or a bad pattern is not', () => {
    expect(caseProblems({ id: 'a', title: 'a', base: 'b', buggy: 'c', fix: 'd', expect: [] })).toContain('no expect')
    const bad = caseProblems({
      id: 'a',
      title: 'a',
      base: 'b',
      buggy: 'c',
      fix: 'd',
      expect: [{ file: 'FILL IN', severity: 'huge', must: [['(']] }],
    })
    expect(bad.join('\n')).toMatch(/no file[\s\S]*severity[\s\S]*bad pattern/)
  })
})

describe('a run, with a stand-in claude', () => {
  it('stages the tree before the change with the change on top and no history, and scores the answer', () => {
    const T = mkdtempSync(join(tmpdir(), 'reval-'))
    dirs.push(T)
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    }
    const git = (cwd: string, ...a: string[]) => {
      const r = spawnSync('git', a, { cwd, env, encoding: 'utf8' })
      if (r.status !== 0) throw new Error(r.stderr)
      return r.stdout.trim()
    }
    // a repository with history: the base, the buggy change, and a fix the review must not be able to see
    const repo = join(T, 'repo')
    mkdirSync(join(repo, 'src'), { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'src', 'put.ts'), 'export const ok = 1\n')
    mkdirSync(join(repo, 'evals'))
    writeFileSync(join(repo, 'evals', 'answers.md'), 'the answer\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
    const base = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'src', 'put.ts'), 'export const ok = 1\nexport const bug = 2\n')
    const patch = git(repo, 'diff')
    git(repo, 'commit', '-qam', 'buggy')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'THE FIX')
    const cases = join(T, 'cases', 'one')
    mkdirSync(cases, { recursive: true })
    writeFileSync(join(cases, 'change.patch'), `${patch}\n`)
    writeFileSync(
      join(cases, 'case.json'),
      JSON.stringify({
        id: 'one',
        title: 'one',
        base,
        buggy: 'b',
        fix: 'f',
        expect: [{ file: 'src/put.ts', severity: 'medium', must: [['bug']] }],
      }),
    )
    // the stand-in writes down where it ran and what it saw, then answers in Claude Code's JSON envelope
    const seen = join(T, 'seen.txt')
    const fake = join(T, 'claude')
    const answer = JSON.stringify({
      findings: [
        {
          id: 'F1',
          severity: 'high',
          file: 'src/put.ts',
          line: 2,
          summary: 'a bug',
          failure_scenario: 'x',
          verdict: 'CONFIRMED',
        },
      ],
    })
    writeFileSync(
      fake,
      `#!/bin/sh\n{ git log --oneline; git diff --cached --name-only; ls; echo "ARGS $*"; } > '${seen}'\nprintf '%s' '${JSON.stringify({ type: 'result', result: answer }).replace(/'/g, "'\\''")}'\n`,
      { mode: 0o755 },
    )
    const prompt = join(T, 'prompt.md')
    writeFileSync(prompt, 'REVIEW PROMPT MARKER\n')
    const out = join(T, 'out')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    // a second case whose patch does not apply: it is a miss, and the run goes on past it
    const broken = join(T, 'cases', 'two')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'change.patch'), 'not a patch\n')
    writeFileSync(
      join(broken, 'case.json'),
      JSON.stringify({
        id: 'two',
        title: 'two',
        base,
        buggy: 'b',
        fix: 'f',
        expect: [{ file: 'x', severity: 'low', must: [['x']] }],
      }),
    )
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = main([
      'run',
      '--cases',
      join(T, 'cases'),
      '--repo',
      repo,
      '--claude',
      fake,
      '--out',
      out,
      '--prompt',
      prompt,
      '--claude-args',
      '["--settings","/tmp/no-plugins.json"]',
    ])
    err.mockRestore()
    log.mockRestore()
    expect(code).toBe(0)
    const saw = readFileSync(seen, 'utf8')
    expect(saw).toContain('before the change') // one commit: the tree before the change
    expect(saw).not.toContain('THE FIX')
    expect(saw).not.toContain('buggy')
    expect(saw).toContain('src/put.ts') // the change, staged
    expect(saw).not.toMatch(/^evals$/m) // the eval's own folder is not handed over
    expect(saw).toContain('REVIEW PROMPT MARKER')
    expect(saw).toContain('--model fable')
    expect(saw).toContain('--strict-mcp-config') // none of the machine's own MCP servers
    expect(saw).toContain('--settings /tmp/no-plugins.json') // the machine's extra arguments, passed through
    const [run] = readdirSync(out)
    const summary = JSON.parse(readFileSync(join(out, run as string, 'summary.json'), 'utf8'))
    expect(summary).toMatchObject({ cases: 2, hits: 1, recall: 0.5 })
    expect(JSON.parse(readFileSync(join(out, run as string, 'two.json'), 'utf8')).error).toMatch(/git apply/)
  })
})

describe('cleaning up a case', () => {
  it('a temp folder that will not go is retried, then left and named: it never ends the run', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls: unknown[] = []
    expect(() =>
      cleanUp('/nowhere/x', ((_p: string, o: unknown) => {
        calls.push(o)
        throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' })
      }) as never),
    ).not.toThrow()
    expect(calls[0]).toMatchObject({ recursive: true, force: true, maxRetries: 5 })
    expect(err.mock.calls.join(' ')).toContain('left in place')
    err.mockRestore()
    expect(() => main(['run', '--claude-args', 'not json'])).toThrow('JSON array of strings')
  })
})

describe('comparing two runs', () => {
  it('puts each case and the totals side by side', () => {
    const T = mkdtempSync(join(tmpdir(), 'reval-cmp-'))
    dirs.push(T)
    const put = (d: string, s: ReturnType<typeof scoreRun>) => {
      mkdirSync(join(T, d), { recursive: true })
      writeFileSync(join(T, d, 'summary.json'), JSON.stringify(s))
    }
    put('before', scoreRun([scoreCase(c, { findings: [] })]))
    put('after', scoreRun([scoreCase(c, { findings: [f()] })]))
    const lines = compare(join(T, 'before'), join(T, 'after'))
    expect(lines.find((l) => l.startsWith('x |'))).toMatch(/MISS .* \| HIT top=y n=1/)
    expect(lines).toContain('recall: 0% -> 100%')
  })
})
