#!/usr/bin/env bun
// `bun test`, one process per test file, a few at a time:
//   bun run apps/bridge/scripts/test-parallel.ts [--jobs N] [--only PREFIX | --skip PREFIX] [dir]
// Bun 1.3 runs every file in one process, one after another. The bridge suite spends nearly all of its time waiting on
// real child processes and timers, so files side by side finish in a fraction of the time (docs/CI-LOCAL.md has the numbers).
//
// This replaces nothing but the scheduling: same files, same `bun test`, same exit-code gate. A file in its own process is
// stricter than a shared one, because it cannot lean on what an earlier file left behind. It fails closed: a run is green
// only if every file it found exited 0 AND reported at least one test, so a crash at load, a file that lost its tests and
// a killed process are all red. `dir` defaults to the bridge package; the tests point it at fixtures.
//
// --only and --skip split the files by path prefix, so CI can run the same prefix through both and miss nothing: test/schedules/
// waits 3 seconds on the real Chronos CLI, which only holds on a quiet machine, so those files go one at a time.
//
// A test's default timeout goes from 5 to 20 seconds here. That timeout only catches a hang: several real-process tests take
// 2 to 4 seconds alone and more with files beside them, and it fired on tests that passed every assertion. A test that sets
// its own timeout, every assertion and every wait inside a test stay exactly as written.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

// Bun's own default: *.test.*, *_test.*, *.spec.*, *_spec.* with these extensions, anywhere but node_modules. A test in
// scripts/test-parallel.test.ts compares this list with what `bun test` itself picks up.
const TEST_FILE = /(\.test|_test|\.spec|_spec)\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/
const HANG_MS = 20_000

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

/** The number of tests a `bun test` run says it ran, or null when it never got as far as saying so. */
export function testsRan(output: string): number | null {
  const m = /^Ran (\d+) tests? across \d+ files?\./m.exec(output)
  return m ? Number(m[1]) : null
}

type Result = { file: string; code: number; ran: number | null; pass: number; fail: number; output: string }

async function runFile(root: string, file: string, tmp: string): Promise<Result> {
  // Output goes to files, not pipes: a child a test left behind holds a pipe open, and waiting for its end stalled the whole run.
  const name = file.replaceAll('/', '_')
  const [outPath, errPath] = [join(tmp, `${name}.out`), join(tmp, `${name}.err`)]
  const p = Bun.spawn(['bun', 'test', `--timeout=${HANG_MS}`, `./${file}`], {
    cwd: root,
    stdin: 'ignore',
    stdout: Bun.file(outPath),
    stderr: Bun.file(errPath),
  })
  const code = await p.exited
  const output = `${readFileSync(outPath, 'utf8')}${readFileSync(errPath, 'utf8')}`
  const n = (word: string) => Number(new RegExp(`^\\s*(\\d+) ${word}$`, 'm').exec(output)?.[1] ?? 0)
  return { file, code, ran: testsRan(output), pass: n('pass'), fail: n('fail'), output }
}

function flag(argv: string[], name: string): { value: string | undefined; rest: string[] } {
  const at = argv.indexOf(name)
  if (at < 0) return { value: undefined, rest: argv }
  return { value: argv[at + 1], rest: argv.filter((_, i) => i !== at && i !== at + 1) }
}

async function main(argv: string[]): Promise<number> {
  const j = flag(argv, '--jobs')
  const only = flag(j.rest, '--only')
  const skip = flag(only.rest, '--skip')
  const jobs = Number(j.value ?? process.env.BUN_TEST_JOBS ?? 4)
  if (!Number.isInteger(jobs) || jobs < 1) {
    console.error('test-parallel: --jobs must be a whole number >= 1')
    return 64
  }
  const root = resolve(skip.rest[0] ?? join(dirname(import.meta.path), '..'))
  const files = findTestFiles(root).filter(
    (f) =>
      (only.value === undefined || f.startsWith(only.value)) && (skip.value === undefined || !f.startsWith(skip.value)),
  )
  if (files.length === 0) {
    console.error(`test-parallel: no test files under ${root}`)
    return 1
  }
  const start = performance.now()
  const tmp = mkdtempSync(join(tmpdir(), 'bun-tests-'))
  const queue = [...files]
  const results: Result[] = []
  await Promise.all(
    Array.from({ length: Math.min(jobs, files.length) }, async () => {
      for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        const r = await runFile(root, file, tmp)
        results.push(r)
        // A file's whole output at once, so two files never interleave in the log.
        process.stdout.write(`\n${r.file}: exit ${r.code}\n${r.output}`)
      }
    }),
  )
  rmSync(tmp, { recursive: true, force: true })
  const bad = results.filter((r) => r.code !== 0 || !r.ran).map((r) => r.file)
  const sum = (f: (r: Result) => number) => results.reduce((a, r) => a + f(r), 0)
  const secs = ((performance.now() - start) / 1000).toFixed(2)
  console.log(`\n ${sum((r) => r.pass)} pass\n ${sum((r) => r.fail)} fail`)
  console.log(`Ran ${sum((r) => r.ran ?? 0)} tests across ${results.length} files. [${secs}s]`)
  if (bad.length > 0) console.error(`test-parallel: FAILED (${bad.length} of ${files.length}):\n- ${bad.join('\n- ')}`)
  return bad.length === 0 && results.length === files.length ? 0 : 1
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
