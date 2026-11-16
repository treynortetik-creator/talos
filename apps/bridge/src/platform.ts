// The owner's computer (protocol host.ts Host; the bridge's hello feature host/mac|linux|windows, handshake.ts hostFeature): a
// Mac, a Linux computer, or the Windows PC, whose bridge runs in Talos's own Linux distro and so is told apart by root's marker
// there (Titan, 2026-11-14), never by WSL alone: a developer's own WSL Ubuntu has a terminal and no Talos tray, so it is Linux.
// The marker: /etc/talos-wsl/marker, which the Windows installer writes as
// root when it makes the distro (kit.py and uninstall.ps1 read it as "a distro Talos made"). It counts only as root wrote it, as
// rooted-kit.ts checks /etc/talos: a plain file of root's, in a folder of root's, neither writable by group or others, holding
// exactly "talos" and a newline. Anything else is a Linux computer, never the Windows PC: a sentence for the Windows PC tells
// its owner to use the tray, so no other account may make a computer read as one.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Host } from '@talos-app/protocol'

export const WINDOWS_KIT_MARKER = '/etc/talos-wsl/marker'
const MARKER_TEXT = 'talos\n'

/** Root's own: owned by uid 0 (a test's `root`), and no write bit for group or others. */
const rootsOwn = (st: { uid: number; mode: number }, root: number) => st.uid === root && (st.mode & 0o022) === 0

/** Is `marker` root's Windows-kit marker? Never through a link, and a file that is not exactly root's text is not. */
export function windowsKitMarker(marker: string = WINDOWS_KIT_MARKER, root = 0): boolean {
  try {
    const dir = lstatSync(dirname(marker))
    if (!dir.isDirectory() || !rootsOwn(dir, root)) return false
    const st = lstatSync(marker)
    if (!st.isFile() || !rootsOwn(st, root) || st.size !== MARKER_TEXT.length) return false
    const fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const again = fstatSync(fd)
      if (again.ino !== st.ino || again.dev !== st.dev || !rootsOwn(again, root)) return false
      const buf = Buffer.alloc(MARKER_TEXT.length + 1)
      const n = readSync(fd, buf, 0, buf.length, 0)
      return buf.subarray(0, n).toString('utf8') === MARKER_TEXT
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

/** The owner's computer for these inputs (a test's), or this one. A native Windows bridge (win32) is the Windows PC too. */
export function ownerHostFor(o: { platform: NodeJS.Platform; marker?: string; root?: number }): Host {
  if (o.platform === 'darwin') return 'mac'
  if (o.platform === 'win32') return 'windows'
  return windowsKitMarker(o.marker, o.root) ? 'windows' : 'linux'
}

/**
 * The tests' seam: test/preload.ts pins `host` to 'mac', so the tests that pin the Mac's sentences hold
 * on any machine, and a test of another computer's words sets it and puts it back. Null in the product: this computer's.
 */
export const OWNER_HOST_TEST: { host: Host | null } = { host: null }

let mine: Host | null = null
/** This computer's, read once (root's marker is written when the distro is made and never changes while Talos runs). */
export function ownerHost(): Host {
  if (OWNER_HOST_TEST.host) return OWNER_HOST_TEST.host
  mine ??= ownerHostFor({ platform: process.platform })
  return mine
}
