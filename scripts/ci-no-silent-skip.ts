// A Vitest reporter for the Linux job (scripts/ci-local/jobs-check.sh, job_linux): the script tests that skip on macOS run there,
// and a file whose every test skipped would pass in silence (a condition gone wrong, a tool missing on the box). For each file it
// prints "no-silent-skip: <file>: <ran> of <all> ran", and "no-silent-skip: ALL SKIPPED: <file>" for one where nothing ran; the job
// reads that line and fails. The default reporter beside it prints the run.
import { relative } from 'node:path'
import type { Reporter, TestModule, Vitest } from 'vitest/node'

/** The counts for one file: tests in it, and how many were not skipped. */
export function counts(m: Pick<TestModule, 'children'>): { all: number; ran: number } {
  const tests = [...m.children.allTests()]
  return { all: tests.length, ran: tests.filter((t) => t.result().state !== 'skipped').length }
}

export default class NoSilentSkip implements Reporter {
  private root = process.cwd()

  onInit(vitest: Vitest) {
    this.root = vitest.config.root
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>) {
    for (const m of modules) {
      const name = relative(this.root, m.moduleId)
      const { all, ran } = counts(m)
      console.log(`no-silent-skip: ${name}: ${ran} of ${all} ran`)
      if (ran === 0) console.log(`no-silent-skip: ALL SKIPPED: ${name}`)
    }
  }
}
