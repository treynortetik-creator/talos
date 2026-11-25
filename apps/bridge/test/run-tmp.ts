// One temp folder per bridge test run (#161, packages/testkit/src/run-tmp.ts), removed when the run ends. Imported first by
// preload.ts, before anything makes a folder.
import { afterAll } from 'bun:test'
import { startRunTmp } from '../../../packages/testkit/src/run-tmp.ts'
import { timeFactor } from '../../../packages/testkit/src/time-factor.ts'

// Short on purpose: a test home's hub.sock is under it, and a unix socket path has room for 103 bytes on macOS (107 on
// Linux); the longer name pushed the hub socket past that under macOS's own temp folder, so the hub never listened.
export const RUN_PREFIX = 'tbrun-'
const run = startRunTmp(RUN_PREFIX, { adopt: true })
export const runTmp = run.dir
// `bun test` runs no exit handlers; an afterAll in the preload runs once, after the last file. Outside the test runner (a
// plain `bun` that loads this) afterAll throws, and the exit handler does it instead.
try {
  // the end waits for the run's own leftovers to exit (up to 10 s, times the time factor) before it fails the run: a hook that bun
  // cut short would let one pass
  afterAll(run.end, 60_000 * timeFactor())
} catch {
  process.on('exit', run.end)
}
