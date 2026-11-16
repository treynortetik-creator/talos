// The sealed kit a thread session's permission hook comes from, when root keeps it (Fable R1-2, tier 1: the Windows install). In
// the talos user's own folder a release and the digest vouching for it are both that user's to rewrite; on a box where root set
// Talos up (a Talos distro: its marker below), root copies the release into a folder only root can write and records the digest it worked out
// itself (Titan's `talos-wsl.sh kit-update`, run only from the Windows side, with interop off in the distro):
//   /opt/talos-app/kit/current -> releases/<version>      root:root
//   /etc/talos/kit-release                                root:root 0644, at most 4 KB: {"v":1,"version","content_sha256"}
// Then ONLY that kit is used: never the home one, never TALOS_KIT_HOME. Anything missing, not root's or not matching fails
// closed (the start is refused, in words the Windows user follows). What makes a box "root's" is the Talos distro's marker,
// /etc/talos-wsl/marker, which root writes on every Talos distro at install (install.ps1), never /etc/talos itself: that folder is
// made only when a launch is first approved, and a plain Linux owner may make one for launch-approved alone (Fable R1-1, R1-2).
// A box without the marker is unchanged.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Where root keeps it. Tests point these at their own folders, with their own uid as "root". */
export const ROOTED_KIT = {
  marker: '/etc/talos-wsl/marker',
  etc: '/etc/talos',
  vendor: '/opt/talos-app/kit',
  root: 0,
  managed: '/etc/claude-code/managed-settings.json',
}

/**
 * Root's Claude Code policy on a Talos distro (A', Titan's measurement 2): only root's own kit may load as a marketplace, by its
 * path as written, so no plugin the talos user enables loads into any session, Main's included. talos-local is also declared
 * here: Claude Code then rewrites the talos user's own record of it (known_marketplaces.json) at every start, whose install
 * location could otherwise load a home copy under root's allowed source (Fable R1-1, measured by Titan on 2.1.322 and 2.1.323). The exact bytes kit-update writes
 * (packages/protocol/fixtures/managed-settings.json pins them on both sides).
 */
export const MANAGED_SETTINGS =
  '{"strictKnownMarketplaces":[{"source":"directory","path":"/opt/talos-app/kit"}],"extraKnownMarketplaces":{"talos-local":{"source":{"source":"directory","path":"/opt/talos-app/kit"}}}}\n'

/**
 * The folder every hook a thread session may run in rooted mode lives under (root's releases, real path), or null on a box that
 * is no Talos distro. A refused anchor gives the releases folder too: whatever the start then says, no hook outside it runs.
 */
export function rootedHookDir(a: KitAnchor = kitAnchor()): string | null {
  if ('mode' in a && a.mode === 'home') return null
  const releases = join('vendor' in a ? a.vendor : ROOTED_KIT.vendor, 'releases')
  try {
    return realpathSync(releases)
  } catch {
    return releases
  }
}

/**
 * Why root's managed settings are not the policy kit-update writes, or null: the file root's plain file, not writable by others,
 * holding exactly MANAGED_SETTINGS, in a root folder nobody else can write; and no drop-in beside it (managed-settings.d), since
 * a drop-in's marketplace list is joined to the file's and could let another one load (Titan, measured on 2.1.322 and 2.1.323).
 */
export function managedProblem(file: string, root: number): string | null {
  const dir = dirname(file)
  let d: ReturnType<typeof lstatSync>
  try {
    d = lstatSync(dir)
  } catch {
    return `Claude Code's policy for this PC (${file}) is missing`
  }
  if (d.isSymbolicLink() || !d.isDirectory() || d.uid !== root || (d.mode & 0o022) !== 0)
    return `${dir} is not root's own folder`
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  } catch {
    return `Claude Code's policy for this PC (${file}) is missing`
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.uid !== root || (st.mode & 0o022) !== 0 || st.size > 4096)
      return `${file} is not root's own policy`
    const buf = Buffer.alloc(4097)
    const n = readSync(fd, buf, 0, 4097, 0)
    if (buf.subarray(0, n).toString('utf8') !== MANAGED_SETTINGS) return `${file} is not the policy Talos installs`
  } finally {
    closeSync(fd)
  }
  const dropins = join(dir, 'managed-settings.d')
  let entries: string[] = []
  try {
    const st = lstatSync(dropins)
    if (!st.isDirectory() || st.isSymbolicLink()) return `${dropins} is there and is not an empty folder`
    // root's and nobody else's to write, or "empty" could change after this look (Fable R1-4)
    if (st.uid !== root || (st.mode & 0o022) !== 0) return `${dropins} is not root's own folder`
    entries = readdirSync(dropins)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return `${dropins} cannot be looked at`
  }
  if (entries.length > 0)
    return `${dropins} holds a policy beside Talos's (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`
  return null
}

/**
 * The marketplace manifest root's kit serves (`/opt/talos-app/kit/.claude-plugin/marketplace.json`): it decides which plugin the
 * one allowlisted marketplace offers, so kit-update writes these fixed bytes itself, never the talos user's copy
 * (packages/protocol/fixtures/kit-marketplace.json pins them; kit/scripts/plugin-release.py lays out the same).
 */
export const KIT_MARKETPLACE = `${JSON.stringify(
  {
    name: 'talos-local',
    description: 'The Talos kit releases installed on this machine.',
    owner: { name: 'Talos' },
    plugins: [
      {
        name: 'talos',
        source: './current/talos-kit',
        description:
          'The Talos zone: memory hooks, safety guards, skills, agents and helper scripts for a Talos agent.',
      },
    ],
  },
  null,
  2,
)}\n`

/** Why root's kit's marketplace manifest is not root's fixed one, or null: root's folder and file, read-only, exactly those bytes. */
export function marketplaceProblem(vendor: string, root: number): string | null {
  const dir = join(vendor, '.claude-plugin')
  const file = join(dir, 'marketplace.json')
  let d: ReturnType<typeof lstatSync>
  try {
    d = lstatSync(dir)
  } catch {
    return `the kit's ${file} is missing`
  }
  if (d.isSymbolicLink() || !d.isDirectory() || d.uid !== root || (d.mode & 0o022) !== 0)
    return `the kit's ${dir} is not root's own folder`
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  } catch {
    return `the kit's ${file} is missing`
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.uid !== root || (st.mode & 0o222) !== 0 || st.size > 4096)
      return `the kit's ${file} is not root's read-only file`
    const buf = Buffer.alloc(4097)
    const n = readSync(fd, buf, 0, 4097, 0)
    if (buf.subarray(0, n).toString('utf8') !== KIT_MARKETPLACE)
      return `the kit's ${file} is not the one Talos installs`
  } finally {
    closeSync(fd)
  }
  return null
}

/** What the start refusal tells the owner to do (they have no terminal). */
export const UPDATE_THE_KIT = 'open Talos in the tray and choose "Update the kit"'

export type KitAnchor =
  /** Not a Talos distro (no marker): the kit is the user's own (plain Linux); the release vouches for itself. */
  | { mode: 'home' }
  /** Root's: use only `vendor`, every path root's, and this digest and version. */
  | { mode: 'rooted'; vendor: string; version: string; sha: string; root: number }
  | { refused: string }

/** Which kit a session's hook may come from on this box, or why none. */
export function kitAnchor(
  r: { marker: string; etc: string; vendor: string; root: number; managed: string } = ROOTED_KIT,
): KitAnchor {
  // the marker's folder: none at all is a box that is no Talos distro; one that is there must be root's and hold root's marker
  // (a folder with no good marker in it is never read as "not a Talos distro": Fable R2-4)
  const markerDir = dirname(r.marker)
  let md: ReturnType<typeof lstatSync>
  try {
    md = lstatSync(markerDir)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { mode: 'home' }
    return { refused: `${markerDir} cannot be looked at (${code}); ${UPDATE_THE_KIT}` }
  }
  if (md.isSymbolicLink() || !md.isDirectory() || md.uid !== r.root || (md.mode & 0o022) !== 0)
    return { refused: `${markerDir} is not root's own folder; ${UPDATE_THE_KIT}` }
  let m: ReturnType<typeof lstatSync>
  try {
    m = lstatSync(r.marker)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return { refused: `${r.marker} cannot be looked at (${code}); ${UPDATE_THE_KIT}` }
  }
  // a Talos distro: from here on everything is root's or nothing is used (the marker itself root's plain file)
  if (m.isSymbolicLink() || !m.isFile() || m.uid !== r.root || (m.mode & 0o022) !== 0)
    return { refused: `${r.marker} is not root's own; ${UPDATE_THE_KIT}` }
  let d: ReturnType<typeof lstatSync>
  try {
    d = lstatSync(r.etc)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return {
      refused:
        code === 'ENOENT'
          ? `the kit is not installed for this PC yet; ${UPDATE_THE_KIT}`
          : `${r.etc} cannot be looked at (${code}); ${UPDATE_THE_KIT}`,
    }
  }
  if (d.isSymbolicLink() || !d.isDirectory() || d.uid !== r.root || (d.mode & 0o022) !== 0)
    return { refused: `${r.etc} is not root's own folder; ${UPDATE_THE_KIT}` }
  const file = join(r.etc, 'kit-release')
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return {
      refused:
        code === 'ENOENT'
          ? `the kit is not installed for this PC yet; ${UPDATE_THE_KIT}`
          : `${file} cannot be opened (${code}); ${UPDATE_THE_KIT}`,
    }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.uid !== r.root || (st.mode & 0o022) !== 0 || st.size > 4096)
      return { refused: `${file} is not root's own record of the kit; ${UPDATE_THE_KIT}` }
    const buf = Buffer.alloc(4097)
    const n = readSync(fd, buf, 0, 4097, 0)
    let j: { v?: unknown; version?: unknown; content_sha256?: unknown }
    try {
      j = JSON.parse(buf.subarray(0, n).toString('utf8'))
    } catch {
      return { refused: `${file} is not a record of the kit; ${UPDATE_THE_KIT}` }
    }
    if (
      j === null ||
      typeof j !== 'object' ||
      j.v !== 1 ||
      typeof j.version !== 'string' ||
      !/^[A-Za-z0-9._+-]{1,64}$/.test(j.version) ||
      j.version.startsWith('.') ||
      typeof j.content_sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(j.content_sha256)
    )
      return { refused: `${file} is not a record of the kit; ${UPDATE_THE_KIT}` }
    const managed = managedProblem(r.managed, r.root) ?? marketplaceProblem(r.vendor, r.root)
    if (managed) return { refused: `${managed}; ${UPDATE_THE_KIT}` }
    return { mode: 'rooted', vendor: r.vendor, version: j.version, sha: j.content_sha256, root: r.root }
  } finally {
    closeSync(fd)
  }
}
