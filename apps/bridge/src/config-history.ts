// A short history of config.json: before each write, the file as it was is saved under $TALOS_APP_HOME/config-history/
// as <timestamp>-<pid>-<random>.json (0600, folder 0700), and the newest 20 are kept. It only reads the config file and
// writes its own folder, and it never throws: a failed save is a log line, and the config save goes ahead.
import { chmodSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './fsutil.ts'

/** How many versions are kept. */
export const CONFIG_HISTORY_KEEP = 20
const NAME = /^\d{8}T\d{9}Z(-\d+-[a-z0-9]+)?\.json$/

type Warn = { warn(msg: string, fields?: Record<string, unknown>): void }

const stampOf = (ms: number) => new Date(ms).toISOString().replace(/[-:.]/g, '')

/** Saves the current `configPath` into `dir` and trims the folder to the newest `CONFIG_HISTORY_KEEP`. Never throws. */
export function saveConfigVersion(o: { configPath: string; dir: string; log?: Warn; now?: () => number }): void {
  try {
    let text: string
    try {
      text = readFileSync(o.configPath, 'utf8')
    } catch {
      return // no file yet: nothing to keep
    }
    // unique per process and per call, so two writes in one millisecond (or from two processes) never overwrite each other
    const name = `${stampOf((o.now ?? Date.now)())}-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`
    writeFileAtomic(join(o.dir, name), text, 0o600)
    chmodSync(o.dir, 0o700) // a folder made earlier with looser bits is tightened on every write
    const all = readdirSync(o.dir)
      .filter((n) => NAME.test(n))
      .map((n) => ({ n, t: statSync(join(o.dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : a.n > b.n ? -1 : 0))
    for (const old of all.slice(CONFIG_HISTORY_KEEP)) rmSync(join(o.dir, old.n), { force: true })
  } catch (e) {
    try {
      o.log?.warn('config-history: version not saved', { error: (e as Error).message })
    } catch {
      // a broken logger must not stop the config save either
    }
  }
}
