// The owner's computer (platform.ts): a Mac by its platform, the Windows PC only by root's marker as Titan's installer writes it
// (never by WSL alone), any other Linux computer otherwise; and the hello's host feature follows it (handshake.ts).
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostFeature } from '../src/handshake.ts'
import { ownerHostFor, WINDOWS_KIT_MARKER, windowsKitMarker } from '../src/platform.ts'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
/** A marker folder of this test's own (its uid stands in for root's), 0755, and its marker 0644 with `text`. */
const markerAt = (text = 'talos\n') => {
  const root = mkdtempSync(join(tmpdir(), 'talos-wsl-'))
  roots.push(root)
  const dir = join(root, 'talos-wsl')
  mkdirSync(dir)
  chmodSync(dir, 0o755)
  const marker = join(dir, 'marker')
  writeFileSync(marker, text)
  chmodSync(marker, 0o644)
  return { dir, marker }
}
const me = process.getuid?.() ?? 0

describe('the Windows-kit marker', () => {
  test('root’s file, in root’s folder, holding exactly "talos" and a newline: the Windows PC', () => {
    expect(WINDOWS_KIT_MARKER).toBe('/etc/talos-wsl/marker')
    const { marker } = markerAt()
    expect(windowsKitMarker(marker, me)).toBe(true)
    expect(ownerHostFor({ platform: 'linux', marker, root: me })).toBe('windows')
  })
  test('anything else is a Linux computer: other text, another owner, a write bit for others, a link, a folder others can write', () => {
    for (const text of ['talos', 'talos\n\n', 'Talos\n', 'talos \n', '', 'mac\n']) {
      const { marker } = markerAt(text)
      expect(windowsKitMarker(marker, me), JSON.stringify(text)).toBe(false)
    }
    const a = markerAt()
    expect(windowsKitMarker(a.marker, me + 1)).toBe(false) // not root's
    chmodSync(a.marker, 0o664)
    expect(windowsKitMarker(a.marker, me)).toBe(false) // group can write it
    const b = markerAt()
    chmodSync(b.dir, 0o775)
    expect(windowsKitMarker(b.marker, me)).toBe(false) // the folder is writable by the group
    const c = markerAt()
    const link = join(c.dir, 'link')
    symlinkSync(c.marker, link)
    expect(windowsKitMarker(link, me)).toBe(false) // never through a link
    expect(windowsKitMarker(join(c.dir, 'missing'), me)).toBe(false)
    expect(ownerHostFor({ platform: 'linux', marker: join(c.dir, 'missing'), root: me })).toBe('linux')
  })
  test('a Mac is a Mac whatever is on its disk', () => {
    const { marker } = markerAt()
    expect(ownerHostFor({ platform: 'darwin', marker, root: me })).toBe('mac')
  })
})

describe('the host feature', () => {
  test('follows the computer: a developer’s WSL without root’s marker is Linux, Talos’s distro is the Windows PC', () => {
    const { marker } = markerAt()
    expect(hostFeature(ownerHostFor({ platform: 'linux', marker, root: me }))).toBe('host/windows')
    expect(hostFeature(ownerHostFor({ platform: 'linux', marker: '/nonexistent/talos-wsl/marker', root: me }))).toBe(
      'host/linux',
    )
    expect(hostFeature(ownerHostFor({ platform: 'darwin', marker, root: me }))).toBe('host/mac')
    expect(hostFeature(ownerHostFor({ platform: 'win32', root: me }))).toBe('host/windows')
  })
})
