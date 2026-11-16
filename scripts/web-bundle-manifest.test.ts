// The saved web bundle's manifest (scripts/web-bundle-manifest.mjs): only sha, version, deployed_at and file hashes; no
// source maps; verify catches a missing, changed or extra file.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs script, no types
import { makeManifest, verifyManifest } from './web-bundle-manifest.mjs'

const SHA = 'a'.repeat(40)
const AT = '2026-11-12T17:31:35Z'
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function bundle(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'web-bundle-'))
  dirs.push(d)
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true })
    writeFileSync(join(d, f), body)
  }
  return d
}

describe('web-bundle manifest', () => {
  it('holds sha, version, deployed_at and a hash per file, and nothing else', () => {
    const d = bundle({ 'index.html': '<div id="root"></div>', 'assets/app-1.js': 'x', 'sw.js': 'y' })
    const m = makeManifest(d, SHA, 'ec3b174', AT)
    expect(Object.keys(m).sort()).toEqual(['deployed_at', 'files', 'sha', 'version'])
    expect(Object.keys(m.files)).toEqual(['assets/app-1.js', 'index.html', 'sw.js'])
    expect(m.files['index.html']).toMatch(/^[0-9a-f]{64}$/)
    expect(verifyManifest(d, m)).toEqual([])
  })

  it('refuses source maps, a folder with no index.html, a symlink, and a malformed sha, version or time', () => {
    expect(() => makeManifest(bundle({ 'index.html': '', 'assets/a.js.map': '{}' }), SHA, 'v', AT)).toThrow(
      /source maps/,
    )
    expect(() => makeManifest(bundle({ 'a.js': '' }), SHA, 'v', AT)).toThrow(/index.html/)
    const d = bundle({ 'index.html': '' })
    symlinkSync('/etc/hosts', join(d, 'hosts'))
    expect(() => makeManifest(d, SHA, 'v', AT)).toThrow(/symlink/)
    const ok = bundle({ 'index.html': '' })
    expect(() => makeManifest(ok, 'abc', 'v', AT)).toThrow(/sha/)
    expect(() => makeManifest(ok, SHA, 'has space', AT)).toThrow(/version/)
    expect(() => makeManifest(ok, SHA, 'v', 'yesterday')).toThrow(/deployed_at/)
  })

  it('verify refuses a manifest with no files, no index.html, a bad sha or a source map', () => {
    const d = bundle({ 'index.html': 'a' })
    const m = makeManifest(d, SHA, 'v', AT)
    expect(verifyManifest(d, { ...m, files: undefined })).toContain('manifest: no files, or no index.html')
    expect(verifyManifest(d, { ...m, files: {} })).toContain('manifest: no files, or no index.html')
    expect(verifyManifest(d, { ...m, sha: 'abc' })).toContain('manifest: no valid sha')
    expect(verifyManifest(d, { ...m, files: { ...m.files, 'a.js.map': 'x' } }).join()).toMatch(/source maps/)
    expect(verifyManifest(d, null)).toEqual(['not a manifest'])
  })

  it('verify names a missing, a changed and an extra file', () => {
    const d = bundle({ 'index.html': 'a', 'b.js': 'b', 'c.js': 'c' })
    const m = makeManifest(d, SHA, 'v', AT)
    rmSync(join(d, 'b.js'))
    writeFileSync(join(d, 'c.js'), 'changed')
    writeFileSync(join(d, 'd.js'), 'extra')
    expect(verifyManifest(d, m).sort()).toEqual(['changed: c.js', 'missing: b.js', 'not in the manifest: d.js'])
  })
})
