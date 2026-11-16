// A Playwright reporter for CI: each test whose outcome is "flaky" (it failed, then passed on its retry; the configs retry once
// when CI_FLAKE_FILE is set) is appended to CI_FLAKE_FILE as "<test>\t<file>", so the job's status can say "passed on retry" and
// logs/flakes.tsv keeps it. Without CI_FLAKE_FILE it does nothing. The list reporter beside it prints the run.
import { spawnSync } from 'node:child_process'
import { appendFileSync, realpathSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import type { FullConfig, Reporter, Suite } from '@playwright/test/reporter'

export default class FlakeReporter implements Reporter {
  private suite: Suite | undefined
  private root = process.cwd()

  onBegin(config: FullConfig, suite: Suite) {
    this.suite = suite
    // files are named from the repository's top, as the other runners name them; outside a repository, from the config's folder
    const dir = config.configFile ? dirname(config.configFile) : config.rootDir
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' })
    this.root = realpathSync(top.status === 0 ? top.stdout.trim() : dir) // test files come with their real path
  }

  onEnd() {
    const log = process.env.CI_FLAKE_FILE
    if (!log || !this.suite) return
    for (const t of this.suite.allTests()) {
      if (t.outcome() !== 'flaky') continue
      // titlePath: the root, the project, the file, then the describes and the title
      const project = t.parent.project()?.name
      const name = `${project ? `[${project}] ` : ''}${t.titlePath().slice(3).join(' > ')}`
      appendFileSync(log, `${name.replace(/[\t\r\n]/g, ' ')}\t${relative(this.root, t.location.file)}\n`)
    }
  }
}
