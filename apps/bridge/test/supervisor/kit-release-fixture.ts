// A sealed kit release for tests, laid out as kit/scripts/plugin-release.py builds one (VENDOR/current -> releases/<v>, the plugin
// in talos-kit/ with the real hooks, a .talos-release recording its content hash, every file and folder read-only). Built once
// per test process unless asked for a fresh one; made writable again and removed when the process ends.

import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KIT_DIR, releaseContentSha } from '../../src/supervisor/worker-hook.ts'

const made: string[] = []
let shared: string | undefined

const walk = (dir: string, fn: (p: string, isDir: boolean) => void) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, fn)
    fn(p, e.isDirectory())
  }
}
export const seal = (root: string) => {
  walk(root, (p) => chmodSync(p, statSync(p).mode & ~0o222))
  chmodSync(root, statSync(root).mode & ~0o222)
}
export const unseal = (root: string) => {
  chmodSync(root, statSync(root).mode | 0o200)
  walk(root, (p) => chmodSync(p, statSync(p).mode | 0o200))
}

/** A vendor folder holding one sealed, active release of the checkout's real hooks. `fresh`: a new one, not the shared one. */
export function sealedRelease(opts: { fresh?: boolean; helper?: boolean; under?: string } = {}): string {
  if (!opts.fresh && !opts.under && shared) return shared
  // `under`: in that folder (a test's own), never in the system temp folder itself, which a test may then change
  const vendor = mkdtempSync(join(opts.under ?? tmpdir(), 'talos-kit-vendor-'))
  made.push(vendor)
  const release = join(vendor, 'releases', '9.9.9-test')
  const hooks = join(release, 'talos-kit', 'hooks')
  mkdirSync(hooks, { recursive: true })
  cpSync(join(KIT_DIR, 'hooks', 'permission-relay.py'), join(hooks, 'permission-relay.py'))
  if (opts.helper !== false) cpSync(join(KIT_DIR, 'hooks', '_talos_common.py'), join(hooks, '_talos_common.py'))
  const plugin = join(release, 'talos-kit')
  writeFileSync(
    join(plugin, '.talos-release'),
    `# test release\nversion=9.9.9-test\nkind=plugin-release\ncontent_sha256=${releaseContentSha(plugin)}\n`,
  )
  seal(release)
  symlinkSync('releases/9.9.9-test', join(vendor, 'current'))
  if (!opts.fresh && !opts.under) shared = vendor
  return vendor
}

/**
 * Writable again and gone: a sealed release left behind would stop the test runner removing its temp folder. Every test file
 * that uses sealedRelease calls this in its own afterAll (bun loads this module once for all the files of one run).
 */
export function cleanupReleases() {
  for (const v of made.splice(0)) {
    try {
      unseal(v)
      rmSync(v, { recursive: true, force: true })
    } catch {}
  }
  shared = undefined
}
process.on('exit', cleanupReleases) // a backstop only
