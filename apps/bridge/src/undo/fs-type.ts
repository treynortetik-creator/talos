// Which file system holds a folder, by name, for "Undo to here": new files are offered for deletion only on a file
// system Talos has proved keeps a real birth time for each file (restore.ts). Everything else, and any type that
// cannot be read, proves nothing, so nothing is deleted there.
//
// macOS: Node's statfs gives no type name (f_fstypename), so the name comes from `/sbin/mount`: the one line whose
// device node (/dev/diskNsM) is the folder's own device, its rdev equal to the folder's st_dev. Matching by device,
// not by path, holds with firmlinks (/Users lives on /System/Volumes/Data, though its path starts with "/") and with
// mount points that hold spaces or " (". Matching by the node, not by stat of the mount point, holds where a mount
// point stats to another volume ("/" stats to the Data volume on the build Mac; a mount covered by another). Only
// local volumes have a node: a network, fuse or autofs folder, no line, or more than one line, is unknown.
// Linux: statfs's f_type magic number, named below; one not named is unknown.
import { statSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { type RunAsync, runCommandAsync } from '../run-command.ts'

/**
 * The file systems a restore may delete new files on: proved to keep each file's birth time through a rename (ext4:
 * probed on WSL2 ext4 with scripts/undo-fs-probe.ts). The rename probe still runs on each, so a machine where it fails
 * stays protected: ext2 and ext3 share ext4's magic number and read as 'ext4', and keep no birth time, so the probe is
 * what keeps them out.
 */
export const PROVEN_FS = new Set(['apfs', 'btrfs', 'ext4'])

/** Linux statfs f_type magic numbers, for the file systems a folder is likely to be on (linux/magic.h). */
const LINUX_MAGIC: Record<number, string> = {
  2435016766: 'btrfs',
  61267: 'ext4', // ext2, ext3 and ext4 share it
  1481003842: 'xfs',
  16914836: 'tmpfs',
  2035054128: 'overlay',
  26985: 'nfs',
  16914839: '9p', // v9fs: WSL's drvfs (/mnt/c) and plan9 shares
  1702057286: 'fuse',
  4283649346: 'cifs',
  4266872130: 'smb2',
  19780: 'msdos',
  538032816: 'exfat',
  1397118030: 'ntfs',
  801189825: 'zfs',
  4076150800: 'f2fs',
}

/** `/sbin/mount` answers at once; one that does not is unknown. */
const MOUNT_TIMEOUT_MS = 5000

export type FsTypeSeams = {
  platform?: NodeJS.Platform
  run?: RunAsync
  /** A path's device (st_dev); throws when it cannot be read. */
  devOf?: (path: string) => number
  /** macOS: the device a /dev node stands for (its rdev); throws when it cannot be read. */
  rdevOf?: (node: string) => number
  /** Linux: statfs's f_type. */
  magicOf?: (path: string) => Promise<number>
}

/**
 * One `/sbin/mount` line: `<device> on <mount point> (<type>, <options>)`. The mount point runs from the first " on "
 * to the LAST " (", so one holding a space or " (" reads whole. Undefined for a line that is not of that shape.
 */
export function parseMountLine(line: string): { device: string; point: string; type: string } | undefined {
  const on = line.indexOf(' on ')
  const open = line.lastIndexOf(' (')
  if (on <= 0 || open <= on + 4 || !line.endsWith(')')) return undefined
  const device = line.slice(0, on)
  const point = line.slice(on + 4, open)
  const type = line
    .slice(open + 2, -1)
    .split(',')[0]
    ?.trim()
  return point && type ? { device, point, type } : undefined
}

/** The name of the file system holding `path` (its realpath), or undefined when it cannot be told. Never throws. */
export async function fsTypeOf(path: string, s: FsTypeSeams = {}): Promise<string | undefined> {
  const platform = s.platform ?? process.platform
  const devOf = s.devOf ?? ((p: string) => statSync(p).dev)
  try {
    if (platform === 'linux') {
      const magic = await (s.magicOf ?? (async (p: string) => (await statfs(p)).type))(path)
      return LINUX_MAGIC[magic >>> 0]
    }
    if (platform !== 'darwin') return undefined
    const dev = devOf(path)
    const rdevOf = s.rdevOf ?? ((n: string) => statSync(n).rdev)
    const r = await (s.run ?? runCommandAsync)(['/sbin/mount'], '/', {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      signal: AbortSignal.timeout(MOUNT_TIMEOUT_MS),
    })
    if (r.code !== 0) return undefined
    const found: string[] = []
    for (const line of r.stdout.split('\n')) {
      const m = parseMountLine(line)
      // a local volume's node only: stat of a /dev node never waits on a network or a stuck fuse mount
      if (!m?.device.startsWith('/dev/')) continue
      let d: number | undefined
      try {
        d = rdevOf(m.device)
      } catch {
        d = undefined
      }
      if (d === dev) found.push(m.type)
    }
    return found.length === 1 ? found[0] : undefined
  } catch {
    return undefined
  }
}
