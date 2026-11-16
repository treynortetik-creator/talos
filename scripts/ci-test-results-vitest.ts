// A Vitest reporter for check (scripts/ci-local/jobs-check.sh, step_vitest): every test of the run as one line of
// CI_TEST_RESULTS_DIR/vitest.tsv, "vitest<TAB>file<TAB>name<TAB>state", for check's per-test file (scripts/ci-test-results.ts,
// docs/CI-MACHINES.md, "check on Titan"). state: pass, fail, skip, todo, or flaky (failed, then passed on the retry). A file that
// reported no test, or failed outside its tests (an import that threw, an error after the tests), gets one line "*<TAB>fail".
// Without CI_TEST_RESULTS_DIR it does nothing. The default reporter beside it prints the run.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Reporter, TestCase, TestModule, Vitest } from 'vitest/node'

const clean = (s: string) => s.replace(/[\t\r\n]/g, ' ')

export function testState(t: TestCase): string {
  const r = t.result()
  if (r.state === 'failed') return 'fail'
  if (r.state === 'passed') return t.diagnostic()?.flaky ? 'flaky' : 'pass'
  return t.options.mode === 'todo' ? 'todo' : 'skip' // skipped, or pending: never ran
}

export default class TestResultsReporter implements Reporter {
  private root = process.cwd()

  onInit(vitest: Vitest) {
    this.root = process.env.CI_TEST_RESULTS_ROOT || vitest.config.root
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>) {
    const dir = process.env.CI_TEST_RESULTS_DIR
    if (!dir) return
    const lines: string[] = []
    for (const m of modules) {
      const file = clean(relative(this.root, m.moduleId))
      let n = 0
      for (const t of m.children.allTests()) {
        n++
        lines.push(['vitest', file, clean(t.fullName), testState(t)].join('\t'))
      }
      if (n === 0 || m.errors().length > 0) lines.push(['vitest', file, '*', 'fail'].join('\t'))
    }
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'vitest.tsv'), lines.length ? `${lines.join('\n')}\n` : '')
  }
}
