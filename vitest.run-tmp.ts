// Global setup of the root vitest run: one temp folder per run (#161, packages/testkit/src/run-tmp.ts), set as TMPDIR before
// any worker starts so the workers and what they spawn inherit it, and removed when the run ends.
import { startRunTmp } from './packages/testkit/src/run-tmp.ts'

export default function setup() {
  return startRunTmp('talos-vitest-run-').end
}
