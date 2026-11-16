// Which file system holds a folder (undo/fs-type.ts): on macOS the one `/sbin/mount` line whose /dev node is the folder's device, on
// Linux statfs's magic number. Anything it cannot tell for certain is unknown, and a restore then deletes nothing.
import { describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { RunAsync } from '../src/run-command.ts'
import { fsTypeOf, PROVEN_FS, parseMountLine } from '../src/undo/fs-type.ts'

const mount =
  (out: string, code = 0): RunAsync =>
  async () => ({ code, stdout: out, stderr: '' })
/** Devices by mount point (and the folder's own path), as stat would give them. */
const devs =
  (m: Record<string, number>) =>
  (p: string): number => {
    const d = m[p]
    if (d === undefined) throw new Error(`ENOENT ${p}`)
    return d
  }

const MAC = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  'devfs on /dev (devfs, local, nobrowse)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
  'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
  '/dev/disk5s1 on /Volumes/My Card (2) (exfat, local, nodev, nosuid, noowners)',
].join('\n')

describe('parseMountLine', () => {
  test('a mount point with a space and " (" in it reads whole; the type is the first word in the last brackets', () => {
    expect(parseMountLine('/dev/disk5s1 on /Volumes/My Card (2) (exfat, local, nodev)')).toEqual({
      device: '/dev/disk5s1',
      point: '/Volumes/My Card (2)',
      type: 'exfat',
    })
    expect(parseMountLine('map auto_home on /System/Volumes/Data/home (autofs, automounted)')).toEqual({
      device: 'map auto_home',
      point: '/System/Volumes/Data/home',
      type: 'autofs',
    })
    expect(parseMountLine('not a mount line')).toBeUndefined()
    expect(parseMountLine('/dev/x on /a (apfs')).toBeUndefined()
  })
})

describe('fsTypeOf on macOS', () => {
  /** The folders' devices, and the device each /dev node stands for (its rdev), as stat gives them on a Mac. */
  const s = (folders: Record<string, number>, nodes: Record<string, number>, out = MAC) => ({
    platform: 'darwin' as const,
    run: mount(out),
    devOf: devs(folders),
    rdevOf: devs(nodes),
  })
  const NODES = { '/dev/disk3s1s1': 5, '/dev/disk3s5': 3, '/dev/disk5s1': 9 }

  test("a folder under /Users is the Data volume's, though its path starts with / (a firmlink)", async () => {
    expect(await fsTypeOf('/Users/alex/p', s({ '/Users/alex/p': 3 }, NODES))).toBe('apfs')
  })

  test('a folder on a card whose mount point holds a space and " (": its own line', async () => {
    expect(await fsTypeOf('/Volumes/My Card (2)/x', s({ '/Volumes/My Card (2)/x': 9 }, NODES))).toBe('exfat')
  })

  test('the node decides, not the mount point: "/" stats to the Data volume here, and is not taken for it', async () => {
    const hfs = MAC.replace('/ (apfs, sealed', '/ (hfs, sealed')
    expect(await fsTypeOf('/Users/alex/p', s({ '/Users/alex/p': 3 }, NODES, hfs))).toBe('apfs')
  })

  test('no line on its device, two lines on it, a node that cannot be read, mount failing, or the folder unreadable: unknown', async () => {
    expect(await fsTypeOf('/x', s({ '/x': 7 }, NODES))).toBeUndefined() // a network or fuse folder: no node
    const twice = `${MAC}\n/dev/disk3s5 on /private/var/again (hfs, local)`
    expect(await fsTypeOf('/x', s({ '/x': 3 }, NODES, twice))).toBeUndefined()
    expect(await fsTypeOf('/x', s({ '/x': 3 }, { '/dev/disk3s1s1': 5 }))).toBeUndefined()
    const failing = { platform: 'darwin' as const, run: mount('', 1), devOf: devs({ '/x': 3 }), rdevOf: devs(NODES) }
    expect(await fsTypeOf('/x', failing)).toBeUndefined()
    expect(await fsTypeOf('/gone', s({}, NODES))).toBeUndefined()
  })

  test.if(process.platform === 'darwin')('this Mac: the test folder is on apfs', async () => {
    expect(await fsTypeOf(realpathSync(tmpdir()))).toBe('apfs')
  })
})

describe('fsTypeOf on Linux', () => {
  const linux = (magic: number) => ({ platform: 'linux' as const, magicOf: async () => magic })
  test('the magic numbers name the file system; one not named is unknown', async () => {
    expect(await fsTypeOf('/x', linux(0x9123683e))).toBe('btrfs')
    expect(await fsTypeOf('/x', linux(0xef53))).toBe('ext4')
    expect(await fsTypeOf('/x', linux(0x01021994))).toBe('tmpfs')
    expect(await fsTypeOf('/x', linux(0x01021997))).toBe('9p')
    expect(await fsTypeOf('/x', linux(-1859950530))).toBe('btrfs') // a signed f_type reads the same
    expect(await fsTypeOf('/x', linux(0x12345678))).toBeUndefined()
  })
  test('statfs failing: unknown', async () => {
    const failing = {
      platform: 'linux' as const,
      magicOf: async (): Promise<number> => {
        throw new Error('EIO')
      },
    }
    expect(await fsTypeOf('/x', failing)).toBeUndefined()
  })
})

describe('the allowlist', () => {
  test('is apfs, btrfs and ext4 (probed on WSL2 ext4); 9p (WSL drvfs, /mnt/c) and the rest are not', () => {
    expect([...PROVEN_FS].sort()).toEqual(['apfs', 'btrfs', 'ext4'])
    for (const fs of ['9p', 'drvfs', 'exfat', 'msdos', 'hfs', 'nfs', 'smbfs', 'fuse', 'tmpfs', 'overlay'])
      expect(PROVEN_FS.has(fs)).toBe(false)
  })
})
