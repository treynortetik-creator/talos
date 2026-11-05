// Playwright reporter for `pnpm drive`: output an agent can read without a trace viewer. One line per test.step; on a
// failure the error, the tail of the relay and bridge logs (the stack fixture attaches both), and where the trace is.
import { stripVTControlCharacters } from 'node:util'
import type { FullResult, Reporter, TestCase, TestError, TestResult, TestStep } from '@playwright/test/reporter'

const TAIL_LINES = 25

function tail(body: Buffer | undefined): string {
  const lines = (body?.toString('utf8') ?? '').split('\n').filter(Boolean)
  return lines
    .slice(-TAIL_LINES)
    .map((l) => `    | ${l.slice(0, 300)}`)
    .join('\n')
}

/** What names a journey on every line of output, so parallel runs can be told apart: its title, cut at 60 characters. */
function label(test: TestCase): string {
  return test.title.length > 60 ? `${test.title.slice(0, 57)}...` : test.title
}

export default class DriveReporter implements Reporter {
  private passed = 0
  private failed = 0
  private skipped = 0
  private errors = 0

  printsToStdio(): boolean {
    return true
  }

  onTestBegin(test: TestCase): void {
    console.log(`\nJOURNEY [${label(test)}] ${test.title}`)
  }

  /** Errors outside any test: a spec that fails to load, no test matching the filter, a broken global setup. */
  onError(error: TestError): void {
    this.errors++
    console.log(
      `\nERROR (outside any journey): ${stripVTControlCharacters(error.message ?? String(error)).slice(0, 1500)}`,
    )
  }

  onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
    if (step.category !== 'test.step') return
    const indent = '  '.repeat(1 + (step.parent?.category === 'test.step' ? 1 : 0))
    console.log(`${indent}[${label(test)}] ${step.error ? 'FAIL' : ' ok '} ${step.title} (${step.duration} ms)`)
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const expectedFail = test.expectedStatus === 'failed'
    if (result.status === 'skipped') this.skipped++
    else if (result.status === test.expectedStatus) this.passed++
    else this.failed++
    const verdict =
      result.status === test.expectedStatus
        ? expectedFail
          ? 'KNOWN-BUG (still failing, marked test.fail)'
          : 'PASS'
        : 'FAIL'
    console.log(`  [${label(test)}] => ${verdict} in ${(result.duration / 1000).toFixed(1)} s`)
    if (result.status === test.expectedStatus) return
    for (const e of result.errors)
      console.log(`  [${label(test)}] error: ${stripVTControlCharacters(e.message ?? String(e)).slice(0, 1500)}`)
    for (const a of result.attachments) {
      if (a.name === 'relay.log' || a.name === 'bridge.log')
        console.log(`  ${a.name} (last ${TAIL_LINES} lines):\n${tail(a.body)}`)
      if (a.name === 'trace' && a.path)
        console.log(`  trace: ${a.path}\n  open it with: pnpm exec playwright show-trace ${a.path}`)
    }
  }

  onEnd(result: FullResult): void {
    const ran = this.passed + this.failed + this.skipped
    const why = this.errors > 0 ? `, ${this.errors} error(s) outside any journey (above)` : ''
    const none = ran === 0 && this.errors === 0 ? ', and no journey ran (nothing matched, or nothing loaded)' : ''
    console.log(
      `\nSUMMARY ${result.status.toUpperCase()}: ${this.passed} passed, ${this.failed} failed, ${this.skipped} skipped${why}${none}`,
    )
  }
}
