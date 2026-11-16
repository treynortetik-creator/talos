// A Vitest reporter for CI (scripts/ci-local.sh passes it with --retry=1): each test that failed and then passed on its retry is
// appended to CI_FLAKE_FILE as "<test>\t<file>", so the job's status can say "passed on retry" and logs/flakes.tsv keeps it.
// Without CI_FLAKE_FILE it does nothing. It reports nothing else: the default reporter beside it prints the run.
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import type { Reporter, TestCase, Vitest } from 'vitest/node'

export default class FlakeReporter implements Reporter {
  private root = process.cwd()

  onInit(vitest: Vitest) {
    this.root = vitest.config.root
  }

  onTestCaseResult(test: TestCase) {
    const log = process.env.CI_FLAKE_FILE
    if (!log || test.result().state !== 'passed' || !test.diagnostic()?.flaky) return
    appendFileSync(log, `${test.fullName.replace(/[\t\r\n]/g, ' ')}\t${relative(this.root, test.module.moduleId)}\n`)
  }
}
