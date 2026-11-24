#!/usr/bin/env bun
// `bun test`, one process per test file, a few at a time:
//   bun run apps/bridge/scripts/test-parallel.ts [--jobs N] [--file-timeout SECONDS] [--only PREFIX | --skip PREFIX]
//     [--shard K/N [--pile-tools T1|T2|... [--needs]]] [--files LIST] [dir]
// Bun 1.3 runs every file in one process, one after another. The bridge suite spends nearly all of its time waiting on
// real child processes and timers, so files side by side finish in a fraction of the time (docs/CI-LOCAL.md has the numbers).
//
// This replaces nothing but the scheduling: same files, same `bun test`, same exit-code gate. A file in its own process is
// stricter than a shared one, because it cannot lean on what an earlier file left behind. It fails closed: a run is green
// only if every file it found exited 0 AND reported at least one test, so a crash at load, a file that lost its tests and
// a killed process are all red. `dir` defaults to the bridge package; the tests point it at fixtures.
//
// A file also gets a wall-clock limit, 5 minutes unless --file-timeout <seconds> or BUN_TEST_FILE_TIMEOUT says otherwise
// (the flag wins). Bun's own test timeout is a timer inside the process, so a file stuck in one synchronous call (a filesystem call
// the kernel never answers, a busy loop) can't be stopped by it, and without a limit here the run waits for ever. Past the
// limit the runner sends SIGKILL to the file's bun process and to every process it started, names the file and the limit,
// counts the file as red and carries on with the others. A file that is still there 10 s after the kill (a kernel wait SIGKILL
// cannot break) is red as "did not die after SIGKILL" and left behind, so it cannot hold a worker slot. The limit is at most
// 2147483 s, the most setTimeout takes.
//
// --only and --skip split the files by path prefix, so CI can run the same prefix through both and miss nothing: test/schedules/
// waits 3 seconds on the real Chronos CLI, which only holds on a quiet machine, so CI runs those files alone on the machine
// (the `suites` mutex), a third of the cores at a time. Each file has its own temp home and Chronos and binds no fixed port.
//
// --shard K/N runs pile K of N: after --only and --skip, the files are sorted biggest first (name breaks a tie) and dealt
// greedily, each to the lightest pile so far, so on the same commit every machine deals the same piles, and the N piles are
// every file once (docs/CI-MACHINES.md: check's rest files, half on one machine and half on another). An empty pile is green.
//
// Tools a file needs: a `// ci-requires: tmux` line in its first 20 lines (a comma list; only the tools in KNOWN_TOOLS, so a
// typo is an error, not a file that quietly needs nothing). --pile-tools gives each pile the tools of the machine that runs it
// ("tmux|": pile 1 has tmux, pile 2 nothing; docs/CI-MACHINES.md, "Tools a test file needs"). A file that needs a tool is dealt
// only among the piles that have it, the rest as before, so the same input deals the same piles on every machine. A needing
// file that no pile can take is dealt as any other: the machine that gets it refuses its pile (--needs says what a pile
// needs, runs nothing) and Lemnos runs that pile instead. Without --pile-tools the piles are exactly what they were.
//
// There is no retry: a file that fails fails (the owner's rule; scripts/ci-no-retries.test.ts). The old --retry-failed is read as the folder to test and refused.
//
// TALOS_TEST_JUNIT_DIR (CI's check, scripts/ci-test-results.ts): each file's per-test report, bun's junit, as <name>.xml there
// (<name> is the file's path with / made _). a file that ended without a report (a crash, the file limit) leaves <name>.crashed holding its path.

// A test's default timeout goes from 5 to 20 seconds here. That timeout only catches a hang: several real-process tests take
// 2 to 4 seconds alone and more with files beside them, and it fired on tests that passed every assertion. A test that sets
// its own timeout, every assertion and every wait inside a test stay exactly as written.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

// Bun's own default: *.test.*, *_test.*, *.spec.*, *_spec.* with these extensions, anywhere but node_modules. A test in
// scripts/test-parallel.test.ts compares this list with what `bun test` itself picks up.
const TEST_FILE = /(\.test|_test|\.spec|_spec)\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/
// scaled by TALOS_TEST_TIME_FACTOR (scripts/gate.sh: 3 on a machine with 4 cores or fewer), as the file's wall-clock limit is
const TIME_FACTOR = (() => {
  const n = Number(process.env.TALOS_TEST_TIME_FACTOR)
  return Number.isFinite(n) && n >= 1 ? n : 1
})()
const HANG_MS = 20_000 * TIME_FACTOR
// About 1.9 times the slowest file that passes. Over 60 CI check logs (2026-11), the slowest passing files were
// test/schedules/thread-schedules.test.ts (p50 99 s, p90 128 s, max 159 s) and test/schedules/job-memory.test.ts (max 140 s),
// as bun's per-file "Ran N tests across 1 file. [..s]" line reports them. A limit of 3 times that (about 480 s) would add
// 3 minutes to every run with a stuck file. A limit under about 2 times it risks killing a healthy file on a loaded Mac.
const FILE_LIMIT_SECONDS = 300
// setTimeout takes at most 2^31-1 ms; past that it fires at once, which would kill every file after 1 ms.
const FILE_LIMIT_MAX_SECONDS = 2_147_483
// How long a killed file gets to go before the runner gives up waiting on it.
const KILL_GRACE_MS = 10_000
// test/run-tmp.ts RUN_PREFIX: a file's temp folder of this name is adopted as its run's (#161).
const RUN_TMP_PREFIX = 'tbrun-'

export function findTestFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && TEST_FILE.test(e.name)) out.push(relative(root, p))
    }
  }
  walk(root)
  return out.sort()
}

/** The tools a `// ci-requires:` line may name. */
export const KNOWN_TOOLS = ['tmux']

/** The tools a test file needs, from a `// ci-requires: a, b` line in its first 20 lines; an unknown or empty list throws. */
export function requires(text: string): string[] {
  const head = text.split('\n').slice(0, 20)
  for (const line of head) {
    const m = /^\s*\/\/\s*ci-requires:(.*)$/.exec(line)
    if (!m) continue
    const tools = (m[1] as string)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    if (tools.length === 0) throw new Error('a ci-requires: line names no tool')
    for (const t of tools)
      if (!KNOWN_TOOLS.includes(t))
        throw new Error(`ci-requires: unknown tool '${t}' (known: ${KNOWN_TOOLS.join(', ')})`)
    return tools
  }
  return []
}

/** Pile k (1-based) of n: the files sorted by size, biggest first, then by name, each dealt to the lightest pile so far (the
 * first such pile on a tie). Every machine deals the same piles from the same files, and the piles are disjoint and complete.
 * With pileTools (one tool list per pile), a file that needs tools is dealt only among the piles that have them all; one that
 * no pile can take is dealt among all of them, as a file that needs nothing. */
export function shard(
  files: { name: string; size: number; needs?: string[] }[],
  k: number,
  n: number,
  pileTools?: string[][],
): string[] {
  const sorted = [...files].sort((a, b) => b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const piles = Array.from({ length: n }, (_, i) => ({ weight: 0, names: [] as string[], tools: pileTools?.[i] ?? [] }))
  for (const f of sorted) {
    const needs = pileTools ? (f.needs ?? []) : []
    const able = piles.filter((p) => needs.every((t) => p.tools.includes(t)))
    const from = able.length > 0 ? able : piles
    let light = from[0] as (typeof piles)[number]
    for (const p of from) if (p.weight < light.weight) light = p
    light.weight += f.size
    light.names.push(f.name)
  }
  return piles[k - 1]?.names ?? []
}

/** The names of the tests a `bun test` run reports as failed: its "(fail) <name> [<time>]" lines. */
export function failedTests(output: string): string[] {
  return [...output.matchAll(/^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/gm)].map((m) => m[1] as string)
}

/** The number of tests a `bun test` run says it ran, or null when it never got as far as saying so. */
/**
 * What the summary keeps of a failed file's output, so a flake seen once in a long log can still be read: the failing tests'
 * names; the error block of the first one, found backwards from its "(fail)" line to the error that precedes it (an error a
 * passing test printed earlier is not taken), with bun's "timed out" line after it; and, for a file with no "(fail)" at
 * all (killed, or it crashed), its last lines.
 */
export function failureSummary(output: string, maxLines = 12): string[] {
  const lines = output.split('\n').map((l) => l.trimEnd())
  const first = lines.findIndex((l) => /^\(fail\) /.test(l))
  if (first < 0) return lines.filter((l) => l.trim() !== '').slice(-Math.min(5, maxLines))
  let start = -1
  for (let i = first - 1; i >= 0 && start < 0; i--) {
    if (/^\(fail\) |^\(pass\) /.test(lines[i] as string)) break // another test's lines: stop
    if (/^\s*(\w*[Ee]rror:|AssertionError\b)/.test(lines[i] as string)) start = i
  }
  const block =
    start >= 0
      ? lines
          .slice(start, first)
          .filter((l) => l.trim() !== '')
          .slice(0, maxLines)
      : []
  const after = lines.slice(first + 1, first + 3).filter((l) => /timed out after/.test(l))
  return [...failedTests(output).map((n) => `(fail) ${n}`), ...block, ...after]
}

export function testsRan(output: string): number | null {
  const m = /^Ran (\d+) tests? across \d+ files?\./m.exec(output)
  return m ? Number(m[1]) : null
}

type Result = {
  file: string
  code: number
  ran: number | null
  pass: number
  fail: number
  output: string
  timedOut: boolean
  stuck: boolean
}

/** A process and everything below it, found by parent id. Taken before the first kill: a child outlives its parent as an orphan. */
function descendants(root: number): number[] {
  // A ps that hangs or fails leaves just the root, which is still killed.
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 10_000 }).stdout ?? ''
  const kids = new Map<number, number[]>()
  for (const line of ps.trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (pid !== undefined && ppid !== undefined) kids.set(ppid, [...(kids.get(ppid) ?? []), pid])
  }
  const out = [root]
  for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i] as number) ?? []))
  return out
}

/** SIGKILL, not SIGTERM: a process stuck in a system call never gets to handle a signal. Only ids this run started. */
function killTree(tree: readonly number[]): void {
  for (const pid of tree) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

/**
 * The ids of `tree` still running: neither gone nor a zombie. A zombie has ended (it only waits for its parent, often init by
 * now, to read its exit), so it counts as gone. One `ps` for the lot; a ps that fails leaves the answer at "none running", as
 * the kill was sent.
 */
function stillRunning(tree: readonly number[]): number[] {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,stat='], { encoding: 'utf8', timeout: 10_000 }).stdout ?? ''
  const live = new Set<number>()
  for (const line of ps.trim().split('\n')) {
    const [pid, stat] = line.trim().split(/\s+/)
    if (pid && stat && !stat.startsWith('Z')) live.add(Number(pid))
  }
  return tree.filter((pid) => live.has(pid))
}

/**
 * Waits until every process of a killed tree has ended, for at most `graceMs`, and returns the ids still running then. The root's
 * exit is not enough: SIGKILL ends each process when the kernel next runs it, and on a loaded machine a child of the file
 * (a `sleep` it started) was still there, or a zombie that kill(pid, 0) calls alive, after the runner said the file was killed.
 */
export async function treeEnded(tree: readonly number[], graceMs: number): Promise<number[]> {
  const until = Date.now() + graceMs
  for (;;) {
    const left = stillRunning(tree)
    if (left.length === 0 || Date.now() >= until) return left
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** The exit code, or null if the process has not ended within `graceMs`. */
export async function exitWithin(exited: Promise<number>, graceMs: number): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), graceMs)
  })
  try {
    return await Promise.race([exited, late])
  } finally {
    clearTimeout(timer)
  }
}

async function runFile(root: string, file: string, tmp: string, limitSeconds: number): Promise<Result> {
  // Output goes to files, not pipes: a child a test left behind holds a pipe open, and waiting for its end stalled the whole run.
  const name = file.replaceAll('/', '_')
  const [outPath, errPath] = [join(tmp, `${name}.out`), join(tmp, `${name}.err`)]
  // Bun.file() as a child's output does not truncate: a file run again in one folder would read the first run's report after its own.
  for (const p of [outPath, errPath]) rmSync(p, { force: true })
  // The file's own temp folder, made before its bun starts so everything it spawns inherits it (test/run-tmp.ts adopts it).
  // Removed below once the file is over, killed or not (#161).
  const runTmp = mkdtempSync(join(tmpdir(), RUN_TMP_PREFIX))
  const junitDir = process.env.TALOS_TEST_JUNIT_DIR
  const junit = junitDir ? join(junitDir, `${name}.xml`) : undefined
  if (junitDir && junit) {
    mkdirSync(junitDir, { recursive: true })
  }
  const report = junit ? ['--reporter=junit', `--reporter-outfile=${junit}`] : []
  const p = Bun.spawn(['bun', 'test', `--timeout=${HANG_MS}`, ...report, `./${file}`], {
    cwd: root,
    stdin: 'ignore',
    stdout: Bun.file(outPath),
    stderr: Bun.file(errPath),
    // the report goes by flag: a runner the file's tests start themselves must not write into this run's folder
    env: { ...process.env, TMPDIR: runTmp, TALOS_TEST_JUNIT_DIR: undefined },
  })
  let code = await exitWithin(p.exited, limitSeconds * 1000)
  const timedOut = code === null
  // a kernel wait SIGKILL cannot break would hold this worker slot for ever: give up on the file instead
  let survivors: number[] = []
  if (timedOut) {
    const tree = descendants(p.pid) // before the kill: a child outlives its parent as an orphan
    const started = Date.now()
    killTree(tree)
    code = await exitWithin(p.exited, KILL_GRACE_MS)
    // the whole tree within the same grace, not just the root: "killed with its children" is true once this returns
    survivors = (await treeEnded(tree, Math.max(0, KILL_GRACE_MS - (Date.now() - started)))).filter(
      (pid) => pid !== p.pid,
    )
  }
  const stuck = code === null || survivors.length > 0
  if (!stuck) rmSync(runTmp, { recursive: true, force: true }) // a stuck one may still write there: a later run prunes it
  const killed = timedOut
    ? `\n${file}: killed, it ran past the file limit of ${limitSeconds} s${code === null ? `; it did not die after SIGKILL (pid ${p.pid} left running)` : ''}${survivors.length ? `; ${survivors.length === 1 ? 'a process it started' : 'processes it started'} did not die after SIGKILL (pid ${survivors.join(', ')} left running)` : ''}\n`
    : ''
  if (junitDir && junit && !existsSync(junit)) writeFileSync(join(junitDir, `${name}.crashed`), `${file}\n`)
  const output = `${readFileSync(outPath, 'utf8')}${readFileSync(errPath, 'utf8')}${killed}`
  const n = (word: string) => Number(new RegExp(`^\\s*(\\d+) ${word}$`, 'm').exec(output)?.[1] ?? 0)
  return { file, code: code ?? -1, ran: testsRan(output), pass: n('pass'), fail: n('fail'), output, timedOut, stuck }
}

/** A flag and its value. A flag given with no value (last on the line, or followed by another flag) is an error: read as "not
 * given" it would quietly run every file (--shard, --only) or skip nothing (--skip). */
function flag(argv: string[], name: string): { value: string | undefined; rest: string[] } {
  const at = argv.indexOf(name)
  if (at < 0) return { value: undefined, rest: argv }
  const value = argv[at + 1]
  if (value === undefined || value.startsWith('--')) throw new UsageError(`test-parallel: ${name} needs a value`)
  return { value, rest: argv.filter((_, i) => i !== at && i !== at + 1) }
}
class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const j = flag(argv, '--jobs')
  const only = flag(j.rest, '--only')
  const skip = flag(only.rest, '--skip')
  const sh = flag(skip.rest, '--shard')
  const pt = flag(sh.rest, '--pile-tools')
  const list = flag(pt.rest, '--files')
  const fileTimeout = flag(list.rest, '--file-timeout')
  const needsOnly = fileTimeout.rest.includes('--needs')
  const rest = fileTimeout.rest.filter((a) => a !== '--needs')
  const jobs = Number(j.value ?? process.env.BUN_TEST_JOBS ?? 4)
  if (!Number.isInteger(jobs) || jobs < 1) {
    console.error('test-parallel: --jobs must be a whole number >= 1')
    return 64
  }
  const limit = Number(fileTimeout.value ?? process.env.BUN_TEST_FILE_TIMEOUT ?? FILE_LIMIT_SECONDS * TIME_FACTOR)
  if (!Number.isFinite(limit) || limit <= 0 || limit > FILE_LIMIT_MAX_SECONDS) {
    console.error(
      `test-parallel: --file-timeout (or BUN_TEST_FILE_TIMEOUT) must be a number of seconds > 0 and <= ${FILE_LIMIT_MAX_SECONDS}`,
    )
    return 64
  }
  let shardK = 1
  let shardN = 1
  if (sh.value !== undefined) {
    const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(sh.value)
    shardK = Number(m?.[1])
    shardN = Number(m?.[2])
    if (!m || shardK > shardN) {
      console.error('test-parallel: --shard is K/N, whole numbers, 1 <= K <= N')
      return 64
    }
  }
  const root = resolve(rest[0] ?? join(dirname(import.meta.path), '..'))
  const found = findTestFiles(root).filter(
    (f) =>
      (only.value === undefined || f.startsWith(only.value)) && (skip.value === undefined || !f.startsWith(skip.value)),
  )
  if (found.length === 0) {
    console.error(`test-parallel: no test files under ${root}`)
    return 1
  }
  // --files: only the test files named in that file, one per line, relative to the root (the fast gate's selection). A name
  // that is not a test file here is an error, never a file quietly left out.
  if (list.value !== undefined) {
    const named = [
      ...new Set(
        readFileSync(list.value, 'utf8')
          .split('\n')
          .filter((l) => l !== ''),
      ),
    ]
    const missing = named.filter((f) => !found.includes(f))
    if (named.length === 0 || missing.length > 0) {
      console.error(
        `test-parallel: --files names ${named.length === 0 ? 'no file' : `what is not a test file here: ${missing.join(', ')}`}`,
      )
      return 64
    }
    found.splice(0, found.length, ...found.filter((f) => named.includes(f)))
  }
  let pileTools: string[][] | undefined
  if (pt.value !== undefined) {
    pileTools = pt.value.split('|').map((p) =>
      p
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    )
    const bad = pileTools.flat().find((t) => !KNOWN_TOOLS.includes(t))
    if (pileTools.length !== shardN || bad !== undefined) {
      console.error(
        `test-parallel: --pile-tools is one tool list per pile, ${shardN} of them, '|'-separated, of ${KNOWN_TOOLS.join(', ')}`,
      )
      return 64
    }
  }
  const needs = new Map<string, string[]>()
  for (const f of found) {
    try {
      needs.set(f, requires(readFileSync(join(root, f), 'utf8')))
    } catch (e) {
      console.error(`test-parallel: ${f}: ${(e as Error).message}`)
      return 64
    }
  }
  const files =
    shardN === 1
      ? found
      : shard(
          found.map((name) => ({ name, size: statSync(join(root, name)).size, needs: needs.get(name) })),
          shardK,
          shardN,
          pileTools,
        )
  // --needs: the tools this pile's files need, one per line, and nothing run (a part machine checks it has them first)
  if (needsOnly) {
    for (const t of [...new Set(files.flatMap((f) => needs.get(f) ?? []))].sort()) console.log(t)
    return 0
  }
  // the piles of one run can be checked to add up to the whole
  if (shardN > 1) console.log(`test-parallel: shard ${shardK}/${shardN}: ${files.length} of ${found.length} files`)
  if (files.length === 0) {
    console.log(`test-parallel: shard ${shardK}/${shardN} has no files (${found.length} files, ${shardN} piles)`)
    return 0
  }
  const start = performance.now()
  const tmp = mkdtempSync(join(tmpdir(), 'bun-tests-'))
  // Biggest file first: a big file is a long one, and a long file started last is the whole run's tail (docs/CI-LOCAL.md).
  const size = (f: string) => statSync(join(root, f)).size
  const queue = [...files].sort((a, b) => size(b) - size(a) || (a < b ? -1 : 1))
  const results: Result[] = []
  const pool = async (list: string[], each: (file: string) => Promise<void>) => {
    const q = [...list]
    await Promise.all(
      Array.from({ length: Math.min(jobs, q.length) }, async () => {
        for (let file = q.shift(); file !== undefined; file = q.shift()) await each(file)
      }),
    )
  }
  await pool(queue, async (file) => {
    const r = await runFile(root, file, tmp, limit)
    results.push(r)
    // A file's whole output at once, so two files never interleave in the log.
    process.stdout.write(`\n${r.file}: exit ${r.code}\n${r.output}`)
  })
  const failed = (r: Result) => r.timedOut || r.code !== 0 || !r.ran
  rmSync(tmp, { recursive: true, force: true })
  const bad = results
    .filter(failed)
    .map((r) =>
      r.stuck
        ? `${r.file} (killed after ${limit} s, did not die after SIGKILL)`
        : r.timedOut
          ? `${r.file} (killed after ${limit} s)`
          : r.file,
    )
  const sum = (f: (r: Result) => number) => results.reduce((a, r) => a + f(r), 0)
  const secs = ((performance.now() - start) / 1000).toFixed(2)
  console.log(`\n ${sum((r) => r.pass)} pass\n ${sum((r) => r.fail)} fail`)
  console.log(`Ran ${sum((r) => r.ran ?? 0)} tests across ${results.length} files. [${secs}s]`)
  if (bad.length > 0) {
    console.error(`test-parallel: FAILED (${bad.length} of ${files.length}):\n- ${bad.join('\n- ')}`)
    // what failed, and how, where a caller that keeps only the end of the log still sees it
    for (const r of results.filter(failed)) {
      const why = failureSummary(r.output)
      if (why.length > 0) console.error(`\n${r.file}:\n${why.map((l) => `  ${l}`).join('\n')}`)
    }
  }
  return bad.length === 0 && results.length === files.length ? 0 : 1
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)))
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    console.error(e.message)
    process.exit(64)
  }
}
