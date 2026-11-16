// A kit release is sealed read-only once it is in place. On a stock macOS APFS volume rename(2) of a directory whose own
// mode is read-only fails (EACCES: it must rewrite the directory's '..'), so a release sealed BEFORE it is renamed into
// releases/ can never be installed, and a sealed release can never be renamed away to be pruned. Both scripts run here on
// a temp vendor folder, the way the installer and `talos update` run them.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const KIT = resolve(__dirname, '..', 'kit')
const made: string[] = []
afterAll(() => {
  for (const d of made) {
    spawnSync('chmod', ['-R', 'u+w', d])
    rmSync(d, { recursive: true, force: true })
  }
})
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'talos-release-seal-'))
  made.push(d)
  return d
}
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
const writable = (p: string) => (statSync(p).mode & 0o222) !== 0

describe('a sealed kit release', () => {
  it('is built into releases/ and sealed there', () => {
    const vendor = join(temp(), 'kit')
    const r = spawnSync('python3', [join(KIT, 'scripts', 'plugin-release.py'), 'build', '--vendor', vendor], {
      encoding: 'utf8',
      env,
    })
    expect(r.status, r.stderr).toBe(0)
    const versions = readdirSync(join(vendor, 'releases')).filter((n) => !n.startsWith('.'))
    expect(versions).toHaveLength(1)
    const top = join(vendor, 'releases', versions[0] as string)
    expect(existsSync(join(top, 'talos-kit', '.claude-plugin', 'plugin.json'))).toBe(true)
    expect(writable(top)).toBe(false) // sealed after the move, all the way down
    expect(writable(join(top, 'talos-kit', '.claude-plugin', 'plugin.json'))).toBe(false)
    expect(readdirSync(join(vendor, 'releases')).filter((n) => n.startsWith('.build-'))).toEqual([])
  })

  it('a build run again over a release a killed run left unsealed seals it', () => {
    const vendor = join(temp(), 'kit')
    const build = () =>
      spawnSync('python3', [join(KIT, 'scripts', 'plugin-release.py'), 'build', '--vendor', vendor], {
        encoding: 'utf8',
        env,
      })
    expect(build().status).toBe(0)
    const top = join(
      vendor,
      'releases',
      readdirSync(join(vendor, 'releases')).filter((n) => !n.startsWith('.'))[0] as string,
    )
    spawnSync('chmod', ['-R', 'u+w', top]) // killed after the rename, before the seal
    const again = build()
    expect(again.status, again.stderr).toBe(0)
    expect(writable(top)).toBe(false)
  })

  it('an old sealed release can be pruned', () => {
    const vendor = join(temp(), 'kit')
    const vs = ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4']
    for (const v of vs) {
      const dir = join(vendor, 'releases', v, 'talos-kit', '.claude-plugin')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'plugin.json'), '{}')
      spawnSync('chmod', ['-R', 'a-w', join(vendor, 'releases', v)]) // sealed, as plugin-release.py leaves it
    }
    const code = `
import importlib.util, sys
sys.path.insert(0, ${JSON.stringify(join(KIT, 'scripts'))})
spec = importlib.util.spec_from_file_location("talos_update", ${JSON.stringify(join(KIT, 'scripts', 'talos-update.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.prune_releases(${JSON.stringify(vendor)}, "1.0.4", "1.0.3")
`
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf8', env })
    expect(r.status, r.stderr).toBe(0)
    expect(readdirSync(join(vendor, 'releases')).sort()).toEqual(['1.0.2', '1.0.3', '1.0.4'])
  })
})
