// The committed frame fixtures are what scripts/gen-fixtures.ts makes today. A schema change that adds a field with a default
// (media_keep_days in config.sync and ready) leaves the old fixtures parsing, so only a regeneration shows they are stale.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

it('the committed fixtures are the ones the generator makes now (only the random signatures may differ)', () => {
  const r = spawnSync('bun', ['scripts/gen-fixtures.ts', '--check'], { cwd: root, encoding: 'utf8', timeout: 60_000 })
  expect(r.stderr).toBe('')
  expect(r.status).toBe(0)
}, 70_000)

// `pnpm gen:fixtures` runs the generator under Node, whose type stripping refuses TypeScript-only syntax (a parameter
// property, an enum) anywhere the generator imports: it must run there too, and make the same fixtures.
it('the generator runs under Node as well (pnpm gen:fixtures), and makes the same fixtures', () => {
  const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/gen-fixtures.ts', '--check'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  })
  expect(r.stderr).toBe('')
  expect(r.status).toBe(0)
}, 70_000)
