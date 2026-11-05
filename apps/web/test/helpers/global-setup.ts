// Builds the production bundle the relay-backed specs serve (`apps/web/dist`). Skipped when SKIP_BUILD=1.
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export default function globalSetup() {
  if (process.env.SKIP_BUILD === '1') return
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const r = spawnSync('pnpm', ['exec', 'vite', 'build'], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, VITE_FAKE: '' },
  })
  if (r.status !== 0) throw new Error('vite build failed')
}
