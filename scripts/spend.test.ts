// scripts/spend.py (one machine's token spend from its Claude Code transcripts) and scripts/spend-summary.py (Lemnos: keeps
// each machine's line and prints the daily summary). A tracker only: nothing here blocks or slows work.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'spend-'))
  dirs.push(d)
  return d
}
const py = (script: string, args: string[], input?: string, o: { path?: string; cwd?: string } = {}) =>
  spawnSync('python3', [join(here, script), ...args], {
    encoding: 'utf8',
    input,
    cwd: o.cwd,
    env: { PATH: o.path ?? process.env.PATH ?? '' },
  })

const usage = (i: number, cn: number, cr: number, o: number) => ({
  input_tokens: i,
  cache_creation_input_tokens: cn,
  cache_read_input_tokens: cr,
  output_tokens: o,
})
const turn = (id: string, ts: string, model: string, u: ReturnType<typeof usage>) =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage: u } })
const write = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}

// One project with a session (two turns, one written twice as Claude Code does, one per content block) and two subagents;
// one turn outside the day; three project folders that are skipped.
const projects = () => {
  const root = tmp()
  const s = join(root, '-Users-me-Talos', 'sess1')
  write(
    `${s}.jsonl`,
    [
      turn('m1', '2026-11-11T10:00:00Z', 'claude-opus-5-5', usage(10, 100, 1000, 5)),
      turn('m1', '2026-11-11T10:00:01Z', 'claude-opus-5-5', usage(10, 100, 1000, 5)),
      turn('m2', '2026-11-11T11:00:00Z', 'claude-opus-5-5', usage(20, 200, 2000, 7)),
      turn('m0', '2026-11-10T23:59:59Z', 'claude-opus-5-5', usage(9999, 0, 0, 9999)),
      JSON.stringify({ type: 'user', timestamp: '2026-11-11T10:00:00Z', message: { content: 'hi' } }),
      'not json',
      '[1, 2]',
      'null',
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-11T10:00:00',
        message: { id: 'nz', usage: usage(7, 7, 7, 7) },
      }),
    ].join('\n'),
  )
  write(
    join(s, 'subagents', 'agent-a1.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', name: 'lemnos-ci', description: 'd', model: 'opus' }),
  )
  write(
    join(s, 'subagents', 'agent-a1.jsonl'),
    turn('s1', '2026-11-11T12:00:00Z', 'claude-opus-5-5', usage(1, 2, 3, 4)),
  )
  write(
    join(s, 'subagents', 'deep', 'agent-a2.meta.json'),
    JSON.stringify({ agentType: 'Explore', description: 'd', model: 'sonnet' }),
  )
  write(
    join(s, 'subagents', 'deep', 'agent-a2.jsonl'),
    [
      turn('s2', '2026-11-11T13:00:00Z', 'claude-sonnet-4-6', usage(1, 1, 1, 1)),
      turn('s3', '2026-11-11T13:01:00Z', 'claude-sonnet-4-6', usage(1, 1, 1, 1)),
    ].join('\n'),
  )
  for (const skip of ['-private-tmp-x', 'a-scratchpad-b', '-Users-me--cache-talos-ci-tmp-lemnos-d1'])
    write(join(root, skip, 's.jsonl'), turn('x', '2026-11-11T10:00:00Z', 'claude-opus-5-5', usage(5, 5, 5, 5)))
  return root
}
const DAY = ['--days', '1', '--until', '2026-11-12']

describe('spend.py: one machine, the previous UTC day', () => {
  it('--json: a stable, versioned shape; each message counted once; skipped folders and other days left out', () => {
    const r = py('spend.py', [...DAY, '--json', '--root', projects(), '--machine', 'lemnos'])
    expect(r.status, r.stderr).toBe(0)
    const j = JSON.parse(r.stdout)
    expect(j.schema).toBe('talos-spend/1')
    expect(j.machine).toBe('lemnos')
    expect(j.window).toEqual({ start: '2026-11-11T00:00:00Z', end: '2026-11-12T00:00:00Z', days: 1 })
    expect(j.by).toBe('agent')
    expect(j.total).toEqual({ runs: 3, turns: 5, input: 33, cache_new: 304, cache_read: 3005, output: 18 })
    expect(j.rows).toEqual([
      { key: 'main', runs: 1, turns: 2, input: 30, cache_new: 300, cache_read: 3000, output: 12 },
      { key: 'lemnos-ci', runs: 1, turns: 1, input: 1, cache_new: 2, cache_read: 3, output: 4 },
      { key: 'Explore', runs: 1, turns: 2, input: 2, cache_new: 2, cache_read: 2, output: 2 },
    ]) // most tokens first
  })

  it('--by model and --by project', () => {
    const root = projects()
    const m = JSON.parse(
      py('spend.py', [...DAY, '--json', '--machine', 'lemnos', '--root', root, '--by', 'model']).stdout,
    )
    expect(m.rows.map((x: { key: string; turns: number }) => [x.key, x.turns])).toEqual([
      ['claude-opus-5-5', 3],
      ['claude-sonnet-4-6', 2],
    ])
    const p = JSON.parse(
      py('spend.py', [...DAY, '--json', '--machine', 'lemnos', '--root', root, '--by', 'project']).stdout,
    )
    expect(p.rows.map((x: { key: string }) => x.key)).toEqual(['-Users-me-Talos'])
  })

  it('the table: a TOTAL row, cache_read in its own column, and the footer', () => {
    const r = py('spend.py', [...DAY, '--root', projects()])
    expect(r.status, r.stderr).toBe(0)
    const lines = r.stdout.trimEnd().split('\n')
    expect(lines[0]).toMatch(/^agent\s+runs\s+turns\s+input\s+cache_new\s+cache_read\s+output$/)
    expect(lines.find((l) => l.startsWith('TOTAL'))).toMatch(/^TOTAL\s+3\s+5\s+33\s+304\s+3005\s+18$/)
    expect(lines.at(-1)).toBe('raw tokens, not plan usage; records expire ~30 days')
  })

  it('no transcripts at all: zero rows, exit 0', () => {
    const j = JSON.parse(
      py('spend.py', [...DAY, '--json', '--machine', 'lemnos', '--root', join(tmp(), 'none')]).stdout,
    )
    expect(j.total.turns).toBe(0)
    expect(j.rows).toEqual([])
  })

  it('bad arguments are refused', () => {
    for (const bad of [
      ['--by', 'user'],
      ['--days', '0'],
      ['--until', '11/12/2026'],
      ['--machine', 'Bad Name'],
      ['--json'],
    ])
      expect(py('spend.py', bad).status, bad.join(' ')).toBe(2)
  })
})

describe('spend-summary.py: Lemnos keeps each line and posts one summary', () => {
  const line = (machine: string, input: number) =>
    JSON.stringify({
      schema: 'talos-spend/1',
      machine,
      window: { start: '2026-11-11T00:00:00Z', end: '2026-11-12T00:00:00Z', days: 1 },
      by: 'agent',
      rows: [],
      total: { runs: 2, turns: 4, input, cache_new: 1_500_000, cache_read: 20_000_000, output: 300_000 },
    })
  const jobs = (d: string) => {
    const f = join(d, 'jobs.json')
    writeFileSync(
      f,
      JSON.stringify([
        { runner_name: 'm5-max', started_at: '2026-11-11T10:00:00Z', completed_at: '2026-11-11T10:30:00Z' },
        { runner_name: 'm5-max-2', started_at: '2026-11-11T11:00:00Z', completed_at: '2026-11-11T11:15:00Z' },
        { runner_name: 'titan', started_at: '2026-11-11T11:00:00Z', completed_at: '2026-11-11T11:02:30Z' },
        { runner_name: 'titan', started_at: '2026-11-11T12:00:00Z', completed_at: null },
        { runner_name: null, started_at: '2026-11-11T12:00:00Z', completed_at: '2026-11-11T12:09:00Z' },
      ]),
    )
    return f
  }
  const setup = () => {
    const d = tmp()
    return { d, dir: join(d, 'spend'), tsv: join(d, 'logs', 'spend.tsv'), jobs: jobs(d) }
  }
  const summarize = (s: ReturnType<typeof setup>) =>
    py('spend-summary.py', [
      'summarize',
      '--date',
      '2026-11-11',
      '--dir',
      s.dir,
      '--tsv',
      s.tsv,
      '--jobs-file',
      s.jobs,
      '--machines',
      'lemnos,delphi,titan',
    ])
  const tsvRows = (s: ReturnType<typeof setup>) =>
    readFileSync(s.tsv, 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => l.split('\t'))

  it('receive keeps a line as <date>/<machine>.json; a malformed one is refused and nothing is kept', () => {
    const s = setup()
    expect(py('spend-summary.py', ['receive', '--dir', s.dir], line('delphi', 1)).status).toBe(0)
    expect(JSON.parse(readFileSync(join(s.dir, '2026-11-11', 'delphi.json'), 'utf8')).machine).toBe('delphi')
    const week = line('delphi', 1).replace('"days":1', '"days":7')
    for (const bad of ['nope', JSON.stringify({ schema: 'talos-spend/0' }), line('../x', 1), week])
      expect(py('spend-summary.py', ['receive', '--dir', s.dir], bad).status, bad).toBe(2)
    expect(existsSync(join(s.dir, 'x.json'))).toBe(false)
  })

  it('a machine with no line by summary time shows as "no report", never 0; job minutes come from the jobs', () => {
    const s = setup()
    py('spend-summary.py', ['receive', '--dir', s.dir], line('lemnos', 1_200_000))
    const r = summarize(s)
    expect(r.status, r.stderr).toBe(0)
    const out = r.stdout.trim()
    expect(out.split('\n')).toHaveLength(1)
    expect(out).toMatch(/^spend 2026-11-11 UTC: /)
    expect(out).toContain('lemnos 2 runs, in 1.2M, cache 1.5M new / 20.0M read, out 0.3M, 45 job-min')
    expect(out).toContain('delphi no report')
    expect(out).toContain('titan no report, 2.5 job-min')
    expect(out).not.toMatch(/delphi[^·]*\b0 runs/)
    expect(out).toMatch(/\(raw tokens, not plan usage\)$/)
    const rows = tsvRows(s)
    expect(rows.map((x) => [x[0], x[1], x[2]])).toEqual([
      ['2026-11-11', 'lemnos', 'report'],
      ['2026-11-11', 'delphi', 'no report'],
      ['2026-11-11', 'titan', 'no report'],
    ])
    expect(rows[1]?.slice(3, 9)).toEqual(['', '', '', '', '', ''])
  })

  it('a late line goes into spend.tsv without a repost; a second late run adds nothing', () => {
    const s = setup()
    py('spend-summary.py', ['receive', '--dir', s.dir], line('lemnos', 1))
    expect(summarize(s).status).toBe(0)
    py('spend-summary.py', ['receive', '--dir', s.dir], line('delphi', 5))
    const late = summarize(s)
    expect(late.status, late.stderr).toBe(0)
    expect(late.stdout).toBe('') // nothing to post
    const rows = tsvRows(s)
    expect(rows.at(-1)?.slice(0, 6)).toEqual(['2026-11-11', 'delphi', 'late', '2', '4', '5'])
    expect(summarize(s).stdout).toBe('')
    expect(tsvRows(s)).toHaveLength(rows.length)
  })

  it('job minutes that cannot be read are "?", never 0', () => {
    const s = setup()
    py('spend-summary.py', ['receive', '--dir', s.dir], line('lemnos', 1))
    writeFileSync(s.jobs, 'not json')
    const out = summarize(s).stdout
    expect(out).toContain('? job-min')
    expect(out).not.toContain(' 0 job-min')
  })

  // Delphi runs the daily summary outside a checkout: the repo is explicit (--repo, default this one), never `gh repo view`.
  // A fake gh: the runs of the day, then each run's jobs; every call is written down.
  const fakeGh = (body: string) => {
    const bin = tmp()
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "${bin}/calls"\n${body}\n`, { mode: 0o755 })
    return { path: `${bin}:${process.env.PATH ?? ''}`, calls: () => readFileSync(join(bin, 'calls'), 'utf8') }
  }
  const GH_OK = `case "$*" in
  *"actions/runs?created="*) echo 77 ;;
  *"runs/77/jobs"*) echo '{"runner_name":"delphi","started_at":"2026-11-11T10:00:00Z","completed_at":"2026-11-11T10:20:00Z"}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac`
  const summarizeGh = (s: ReturnType<typeof setup>, gh: { path: string }, extra: string[] = []) =>
    py(
      'spend-summary.py',
      ['summarize', '--date', '2026-11-11', '--dir', s.dir, '--tsv', s.tsv, '--machines', 'delphi', ...extra],
      undefined,
      { path: gh.path, cwd: tmp() }, // not a checkout
    )

  it('outside a checkout: the runner minutes come from this repo by default, for that UTC day', () => {
    const s = setup()
    const gh = fakeGh(GH_OK)
    const r = summarizeGh(s, gh)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('delphi no report, 20 job-min')
    expect(gh.calls()).toContain('repos/treynortetik-creator/talos-app/actions/runs?created=2026-11-11&per_page=100')
    expect(gh.calls()).not.toContain('repo view')
  })

  it('--repo names another repo', () => {
    const s = setup()
    const gh = fakeGh(GH_OK)
    expect(summarizeGh(s, gh, ['--repo', 'other/thing']).status).toBe(0)
    expect(gh.calls()).toContain('repos/other/thing/actions/runs?created=2026-11-11')
  })

  it('a GitHub error says why on stderr, and the minutes are "?", never 0', () => {
    const s = setup()
    const gh = fakeGh('echo "HTTP 401: Bad credentials (https://api.github.com/)" >&2; exit 1')
    const r = summarizeGh(s, gh)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('delphi no report, ? job-min')
    expect(r.stderr).toMatch(/spend-summary: could not read the runner minutes.*HTTP 401: Bad credentials/)
  })

  it('input under 0.1M is left out of the line (cache and output still show)', () => {
    const s = setup()
    py('spend-summary.py', ['receive', '--dir', s.dir], line('lemnos', 33))
    const out = summarize(s).stdout
    expect(out).toContain('lemnos 2 runs, cache 1.5M new / 20.0M read, out 0.3M, 45 job-min')
    expect(out).not.toContain('in 0.0M')
  })
})
