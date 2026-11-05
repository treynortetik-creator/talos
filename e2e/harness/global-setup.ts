// Builds what the suite runs against: the relay bundle and the production web bundle (never the fake-mode build).
import { spawnSync } from 'node:child_process'
import { ROOT } from './paths.ts'

// Never let an e2e bridge find the owner's real Chronos (a test bridge closed a live run on 2026-11-03).
process.env.TALOS_APP_CHRONOS_AUTODISCOVER = 'off'

export default function globalSetup(): void {
  if (process.env.E2E_SKIP_BUILD) return // several suites at once share one build (scripts/e2e-clock-sweep.sh)
  for (const filter of ['@talos-app/relay', '@talos-app/web']) {
    const r = spawnSync('pnpm', ['--filter', filter, 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, VITE_FAKE: '' },
    })
    if (r.status !== 0) throw new Error(`build failed for ${filter}`)
  }
}
