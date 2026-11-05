// The public export leaves some files out (scripts/export-public.sh EXCLUDE). A doc a stranger follows to set Talos up must not
// send them to one of those files: they would land on a path that is not in the public repository (audit gap 16).
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')

const excludes = spawnSync('bash', [join(root, 'scripts', 'export-public.sh'), '--print-excludes'], {
  encoding: 'utf8',
})
  .stdout.split('\n')
  .filter(Boolean)

/** Setup-facing: what a person or an agent reads to install, start, update or phone-enroll Talos. */
function setupFacing(): string[] {
  const files = [
    'README.md',
    'SETUP.md',
    'CLAUDE.md',
    'AGENTS.md',
    'apps/mobile/README.md',
    'plugins/talos-app-mod/README.md',
    'docs/SETUP.md',
    'docs/ios.md',
    'docs/IOS-PUSH.md',
    'docs/desktop.md',
    'docs/bridge.md',
    'docs/deploy-railway.md',
    'docs/voice.md',
    'docs/iphone-checklist.md',
    'docs/OPTION-C.md',
    'docs/ARCHITECTURE.md',
    'docs/MEMORY.md',
    'docs/SCHEDULES.md',
    'docs/HEARTBEAT.md',
    'kit/START-HERE.md',
    'kit/README.md',
    'kit/BOOTSTRAP.md',
    'kit/UPGRADE.md',
    'kit/UNINSTALL.md',
  ]
  for (const f of readdirSync(join(root, 'kit', 'setup'))) if (f.endsWith('.md')) files.push(`kit/setup/${f}`)
  return files.filter((f) => existsSync(join(root, f)))
}

/** Every way a doc can name an excluded path: the full path, or (for a file) its bare name as a path or link target. */
function mentions(text: string, entry: string): boolean {
  if (text.includes(entry)) return true
  if (entry.endsWith('/')) return false
  const base = entry.split('/').pop() as string
  // a bare SPEC.md / FOLLOWUPS.md / ci-runner.yml reads as a file to open; "kit/SOURCE" has no extension, so only the full path counts
  return base.includes('.') && new RegExp(`(^|[^\\w.-])${base.replace(/\./g, '\\.')}([^\\w-]|$)`).test(text)
}

describe('setup-facing docs never send a reader to a file the public export leaves out', () => {
  it('the exclude list is the one the export script prints', () => {
    expect(excludes.length).toBeGreaterThan(5)
    expect(excludes).toContain('docs/SPEC.md')
    expect(excludes).toContain('scripts/smoke/')
  })

  it('the list of setup-facing docs is not empty and every file in it exists', () => {
    const files = setupFacing()
    expect(files).toContain('SETUP.md')
    expect(files).toContain('docs/ios.md')
    expect(files.length).toBeGreaterThan(20)
  })

  for (const file of setupFacing()) {
    it(file, () => {
      const text = readFileSync(join(root, file), 'utf8')
      const hits = excludes.filter((e) => mentions(text, e))
      expect(hits, `${file} names files that are not in the public repository`).toEqual([])
    })
  }
})
