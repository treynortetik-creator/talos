// The reviewer eval (evals/reviewer/README.md): past changes that hid a real bug, and the finding a review should produce for
// each. For every case the change is staged in a fresh repository made from the tree before it (no history, so the review
// cannot find the fix), a headless Claude Code reviews it with the prompt, and the answer is scored (reviewer-eval-score.ts).
//
//   node scripts/reviewer-eval.ts run [--case <id>]... [--model fable] [--prompt <path>] [--max-cases <n>] [--claude <bin>]
//                                     [--max-turns <n>] [--timeout-s <n>] [--cases <dir>] [--repo <dir>] [--out <dir>]
//                                     [--claude-args '<JSON array of extra arguments>']   e.g. '["--settings","<file>"]'
//   The spawned claude runs with --strict-mcp-config (no MCP server of the machine's own) and the extra arguments after it.
//   node scripts/reviewer-eval.ts check [--cases <dir>]       every case is well formed and its patch is there
//   node scripts/reviewer-eval.ts compare <run folder> <run folder>   two runs side by side (a prompt change, before and after)
//   node scripts/reviewer-eval.ts add <id> --base <sha> (--buggy <sha> | --patch <file>) [--fix <sha>] [--title <text>]
//
// Never run by the gate or CI (each case is a paid review); results go to evals/reviewer/results/ (gitignored).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Case,
  type CaseScore,
  caseProblems,
  parseReview,
  type Review,
  scoreCase,
  scoreRun,
  TOP,
} from './reviewer-eval-score.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVALS = join(ROOT, 'evals', 'reviewer')

type Opts = {
  cases: string
  repo: string
  out: string
  prompt: string
  model: string
  claude: string
  maxTurns: number
  timeoutS: number
  maxCases: number
  only: string[]
  /** Extra arguments for the spawned claude (`--claude-args`, a JSON array of strings). */
  claudeArgs: string[]
}

function parseArgs(argv: string[]): { cmd: string; rest: string[]; o: Opts; flags: Record<string, string> } {
  const o: Opts = {
    cases: join(EVALS, 'cases'),
    repo: ROOT,
    out: join(EVALS, 'results'),
    prompt: join(EVALS, 'prompt.md'),
    model: 'fable',
    claude: 'claude',
    maxTurns: 60,
    timeoutS: 1200,
    maxCases: Number.POSITIVE_INFINITY,
    only: [],
    claudeArgs: [],
  }
  const flags: Record<string, string> = {}
  const rest: string[] = []
  const [cmd = 'help', ...args] = argv
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (!a.startsWith('--')) {
      rest.push(a)
      continue
    }
    const v = args[++i]
    if (v === undefined) throw new Error(`${a} needs a value`)
    if (a === '--case') o.only.push(v)
    else if (a === '--cases') o.cases = resolve(v)
    else if (a === '--repo') o.repo = resolve(v)
    else if (a === '--out') o.out = resolve(v)
    else if (a === '--prompt') o.prompt = resolve(v)
    else if (a === '--model') o.model = v
    else if (a === '--claude') o.claude = v
    else if (a === '--max-turns') o.maxTurns = Number(v)
    else if (a === '--timeout-s') o.timeoutS = Number(v)
    else if (a === '--max-cases') o.maxCases = Number(v)
    else if (a === '--claude-args') {
      let parsed: unknown
      try {
        parsed = JSON.parse(v)
      } catch {
        throw new Error('--claude-args takes a JSON array of strings')
      }
      if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string'))
        throw new Error('--claude-args takes a JSON array of strings')
      o.claudeArgs = parsed as string[]
    } else flags[a.slice(2)] = v
  }
  return { cmd, rest, o, flags }
}

export function loadCases(dir: string): Array<{ dir: string; c: Case; problems: string[] }> {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, 'case.json')))
    .sort()
    .map((d) => {
      const at = join(dir, d)
      let c: Case
      try {
        c = JSON.parse(readFileSync(join(at, 'case.json'), 'utf8')) as Case
      } catch (e) {
        return { dir: at, c: { id: d } as Case, problems: [`case.json does not parse: ${(e as Error).message}`] }
      }
      const problems = caseProblems(c)
      if (c.id !== d) problems.push(`id ${c.id} is not its folder's name ${d}`)
      if (!existsSync(join(at, 'change.patch'))) problems.push('no change.patch')
      return { dir: at, c, problems }
    })
}

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'eval',
  GIT_AUTHOR_EMAIL: 'eval@example.com',
  GIT_COMMITTER_NAME: 'eval',
  GIT_COMMITTER_EMAIL: 'eval@example.com',
}
function run(cmd: string, args: string[], cwd: string, input?: Buffer) {
  const r = spawnSync(cmd, args, { cwd, env: gitEnv, input, maxBuffer: 512 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr?.toString().slice(0, 500)}`)
  return r.stdout
}

/** A repository holding only the tree at `base` (one commit, no history) with the case's patch staged on top. */
export function stage(repo: string, base: string, patch: string): string {
  const at = mkdtempSync(join(tmpdir(), 'reviewer-eval-'))
  // the eval's own folder is left out: a case whose base is later than it would otherwise hand the review its answers
  const tree = run('git', ['archive', '--format=tar', base, '--', '.', ':(exclude)evals'], repo)
  run('tar', ['-x', '-C', at], at, tree)
  run('git', ['init', '-q', '-b', 'main'], at)
  run('git', ['add', '-A'], at)
  run('git', ['commit', '-q', '--no-verify', '-m', 'before the change'], at)
  run('git', ['apply', '--index', '--whitespace=nowarn', patch], at)
  return at
}

/** Removes a case's temp repository. Never throws: a folder that will not go (a process still writing in it) is retried,
 * then left, and named, so one case cannot end the run. */
export function cleanUp(at: string, rm: typeof rmSync = rmSync): void {
  try {
    rm(at, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (e) {
    console.error(`could not remove ${at} (${(e as Error).message}); left in place`)
  }
}

/** The review's answer: Claude Code's `--output-format json` result text, read as the review's JSON. */
function review(o: Opts, at: string, prompt: string): { review: Review | null; raw: string; error?: string } {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k]
  const task = `${prompt}\n\n---\nThe change to review is staged in this repository: run \`git diff --cached\` to see it.`
  const r = spawnSync(
    o.claude,
    [
      '-p',
      task,
      '--model',
      o.model,
      '--output-format',
      'json',
      '--max-turns',
      String(o.maxTurns),
      '--allowedTools',
      'Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git log:*),Bash(git status:*),Bash(ls:*)',
      '--disallowedTools',
      'Edit,Write,NotebookEdit,WebFetch,WebSearch',
      // no MCP server from this machine's own config: a messaging plugin's poller, say, must not start a second time
      '--strict-mcp-config',
      ...o.claudeArgs,
    ],
    { cwd: at, env, encoding: 'utf8', timeout: o.timeoutS * 1000, maxBuffer: 64 * 1024 * 1024 },
  )
  const raw = r.stdout ?? ''
  if (r.error) return { review: null, raw, error: r.error.message }
  let text = raw
  try {
    const j = JSON.parse(raw) as { result?: unknown }
    if (typeof j.result === 'string') text = j.result
  } catch {
    // not Claude Code's JSON envelope: read the output as the answer itself
  }
  const v = parseReview(text)
  return v ? { review: v, raw } : { review: null, raw, error: `no review JSON in the answer (exit ${r.status})` }
}

function cmdRun(o: Opts): number {
  const all = loadCases(o.cases)
  const bad = all.filter((x) => x.problems.length)
  for (const b of bad) console.error(`case ${b.c.id}: ${b.problems.join('; ')}`)
  if (bad.length) return 2
  const chosen = all.filter((x) => !o.only.length || o.only.includes(x.c.id)).slice(0, o.maxCases)
  if (!chosen.length) {
    console.error('no case to run')
    return 2
  }
  const prompt = readFileSync(o.prompt, 'utf8')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = join(o.out, `${stamp}-${o.model}`)
  mkdirSync(out, { recursive: true })
  const scores: CaseScore[] = []
  for (const { dir, c } of chosen) {
    const t0 = Date.now()
    let at: string | undefined
    let rec: Record<string, unknown>
    try {
      at = stage(o.repo, c.base, join(dir, 'change.patch'))
      const r = review(o, at, prompt)
      const s = scoreCase(c, r.review ?? { findings: [] })
      scores.push(s)
      rec = { case: c.id, score: s, review: r.review, error: r.error, seconds: Math.round((Date.now() - t0) / 1000) }
      writeFileSync(join(out, `${c.id}.raw.txt`), r.raw)
    } catch (e) {
      const s = scoreCase(c, { findings: [] })
      scores.push(s)
      rec = { case: c.id, score: s, review: null, error: (e as Error).message }
    } finally {
      if (at) cleanUp(at)
    }
    writeFileSync(join(out, `${c.id}.json`), `${JSON.stringify(rec, null, 2)}\n`)
    const s = scores.at(-1) as CaseScore
    console.log(
      `${s.hit ? 'HIT ' : s.near ? 'NEAR' : 'MISS'}  ${c.id}  findings=${s.findings}${rec.error ? `  (${rec.error})` : ''}`,
    )
  }
  const total = scoreRun(scores)
  writeFileSync(
    join(out, 'summary.json'),
    `${JSON.stringify({ model: o.model, prompt: o.prompt, ...total }, null, 2)}\n`,
  )
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`
  console.log(
    `\nrecall ${total.hits}/${total.cases} (${pct(total.recall)}), findings found ${pct(total.findingRecall)}, ` +
      `hit@${TOP} ${total.hitAtTop}/${total.cases}, precision@${TOP} ${pct(total.precisionAtTop)}\n` +
      `severity: exact ${pct(total.severityAgreement)}, higher ${pct(total.severityOverShare)}, lower ${pct(total.severityUnderShare)}; ` +
      `findings per case ${total.findingsPerCase.toFixed(1)} (${total.unmatchedPerCase.toFixed(1)} unmatched), decoys flagged ${total.decoysFlagged}\n${out}`,
  )
  return 0
}

function cmdCheck(o: Opts): number {
  const all = loadCases(o.cases)
  let bad = 0
  for (const x of all) {
    if (x.problems.length) {
      bad++
      console.error(`case ${x.c.id}: ${x.problems.join('; ')}`)
    }
  }
  console.log(`${all.length} cases, ${bad} with problems`)
  return bad || !all.length ? 1 : 0
}

function cmdAdd(o: Opts, rest: string[], flags: Record<string, string>): number {
  const id = rest[0]
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('add <id>: lower-case letters, digits and -')
  if (!flags.base) throw new Error('add needs --base <sha> (the tree before the change)')
  // pinned to the full sha: a case must not move when a branch does
  const base = run('git', ['rev-parse', '--verify', `${flags.base}^{commit}`], o.repo)
    .toString()
    .trim()
  const at = join(o.cases, id)
  if (existsSync(at)) throw new Error(`${at} is there already`)
  mkdirSync(at, { recursive: true })
  const patch = flags.patch
    ? readFileSync(resolve(flags.patch))
    : run('git', ['diff', '--binary', base, flags.buggy ?? 'HEAD'], o.repo)
  writeFileSync(join(at, 'change.patch'), patch)
  const c: Case = {
    id,
    title: flags.title ?? id,
    base,
    buggy: flags.buggy ?? 'uncommitted',
    fix: flags.fix ?? '',
    expect: [{ file: 'FILL IN', severity: 'high', must: [['FILL IN']] }],
  }
  writeFileSync(join(at, 'case.json'), `${JSON.stringify(c, null, 2)}\n`)
  writeFileSync(join(at, 'README.md'), `# ${c.title}\n\nWhat the bug was, and what caught it.\n`)
  console.log(`wrote ${at}: fill in case.json's expect and README.md`)
  return 0
}

/** Two runs' results side by side: per case HIT/NEAR/MISS, hit@TOP and findings, then the totals and what changed. */
export function compare(a: string, b: string): string[] {
  const read = (d: string) => {
    const summary = JSON.parse(readFileSync(join(d, 'summary.json'), 'utf8')) as ReturnType<typeof scoreRun> & {
      prompt?: string
    }
    return { summary, by: new Map(summary.perCase.map((c) => [c.id, c])) }
  }
  const x = read(a)
  const y = read(b)
  const mark = (c: CaseScore | undefined) => (!c ? '-' : c.hit ? 'HIT' : c.near ? 'NEAR' : 'MISS')
  const ids = [...new Set([...x.by.keys(), ...y.by.keys()])].sort()
  const lines = [`case | ${a} | ${b}`]
  for (const id of ids) {
    const p = x.by.get(id)
    const q = y.by.get(id)
    lines.push(
      `${id} | ${mark(p)} top=${p?.hitAtTop ? 'y' : 'n'} n=${p?.findings ?? '-'} | ${mark(q)} top=${q?.hitAtTop ? 'y' : 'n'} n=${q?.findings ?? '-'}`,
    )
  }
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`
  for (const [k, f] of [
    ['recall', (s: typeof x.summary) => pct(s.recall)],
    ['findings found', (s: typeof x.summary) => pct(s.findingRecall)],
    [`hit@${TOP}`, (s: typeof x.summary) => `${s.hitAtTop}/${s.cases}`],
    [`precision@${TOP}`, (s: typeof x.summary) => pct(s.precisionAtTop)],
    ['severity exact', (s: typeof x.summary) => pct(s.severityAgreement)],
    ['findings per case', (s: typeof x.summary) => s.findingsPerCase.toFixed(1)],
  ] as const)
    lines.push(`${k}: ${f(x.summary)} -> ${f(y.summary)}`)
  return lines
}

export function main(argv: string[]): number {
  const { cmd, rest, o, flags } = parseArgs(argv)
  if (cmd === 'compare') {
    if (rest.length !== 2) throw new Error('compare <run folder> <run folder>')
    for (const l of compare(resolve(rest[0] as string), resolve(rest[1] as string))) console.log(l)
    return 0
  }
  if (cmd === 'run') return cmdRun(o)
  if (cmd === 'check') return cmdCheck(o)
  if (cmd === 'add') return cmdAdd(o, rest, flags)
  console.log(
    readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n')
      .slice(0, 10)
      .join('\n'),
  )
  return cmd === 'help' ? 0 : 64
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)))
