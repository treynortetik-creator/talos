// A path's real location, worked out by walking it (2026-11-12).
//
// On macOS the realpath of a file can report another of its hard-linked names: a file with several names has no one answer,
// and the Mac's /usr/bin/python3, for one, is one file with 77 other names (git, make among them). A check that trusts a
// file's realpath (a fence, a name rule, the folder its rules are rooted at, the file a write lands on) needs the name the file
// was found by, so files are resolved here instead.
//
// A folder has exactly one name (APFS and ext4 have no hard-linked folders), so a FOLDER's realpath is sound. So the path is
// walked one name at a time, as the kernel walks it and as Python's realpath does: each name lstat'ed, a link read and followed,
// and a `..` taken from the part already resolved (which has no link left in it). realpath is never given a `..` either: it can
// cancel `link/..` as text, where the kernel climbs from where the link leads. Only the folder the walk ends in is then asked
// for its realpath, for the disk's own spelling of it (a case-folding volume), so a prefix check against a protected folder
// still matches; a file's own name too, when realpath gives back that same name in that same folder.
// test/real-file.test.ts fails on any new realpath of what may be a file anywhere else in apps/bridge/src.
import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'

/** Links followed at most: the kernel's own limit (MAXSYMLINKS), past which it says ELOOP. */
const MAX_LINKS = process.platform === 'darwin' ? 32 : 40

const fsError = (code: string, what: string, p: string) =>
  Object.assign(new Error(`${code}: ${what}, realpath '${p}'`), { code, path: p, syscall: 'realpath' })

/**
 * `p` (a file or a folder; relative to the working folder) with every link resolved, as realpathSync gives it, but never from an
 * open file's name. Throws as realpathSync does (ENOENT, ENOTDIR, EACCES, ELOOP). Every name is spelled as on the disk, except
 * a file's own name when the disk's spelling cannot be had safely (see the end): then as it was reached. Unlike realpath,
 * a folder that can be searched but not read (mode 0111) on the way to a file is EACCES (its spelling cannot be read); a file
 * that cannot be read is fine. A caller that must still know where such a path leads takes walkLinks.
 */
export function realFileSync(p: string): string {
  const { done, isFolder } = walk(p)
  if (isFolder) return realFolder(done)
  const folder = realFolder(dirname(done))
  const name = basename(done)
  // A file's realpath may come back under another of its names (above); it is kept only as the disk's spelling of THIS name in
  // THIS folder. On a case-sensitive volume that could still be a second name in the same folder differing only in case: the
  // same file, in the same folder, which every check here goes by.
  try {
    const r = realpathSync(done)
    if (dirname(r) === folder && fold(basename(r)) === fold(name)) return r
  } catch {}
  // not had from realpath (another name came back, or the file cannot be opened): the folder's one entry of this name, when
  // exactly one is spelled like it; else the name as reached
  try {
    const names = readdirSync(folder)
    if (names.includes(name)) return join(folder, name)
    const like = names.filter((n) => fold(n) === fold(name))
    if (like.length === 1) return join(folder, like[0] as string)
  } catch {}
  return join(folder, name)
}

/**
 * `p` with every link followed, as the kernel follows it, each name spelled as it was reached (not necessarily as on the disk).
 * Asks nothing that needs a folder to be readable, so it answers where realFileSync is EACCES. Throws ENOENT, ENOTDIR, EACCES
 * (a folder that cannot be searched) or ELOOP. For a check that must know where a path leads even then (guards/rules.ts).
 */
export function walkLinks(p: string): string {
  return walk(p).done
}

/**
 * A folder's realpath: the disk's spelling of a folder with one name. Checked to be a folder still: if `p` was swapped for a
 * file with several names since the walk saw it, realpath could answer with one of the file's other names.
 */
function realFolder(p: string): string {
  const r = realpathSync(p)
  if (!lstatSync(r).isDirectory()) throw fsError('ENOTDIR', 'not a directory', p)
  return r
}

/** The walk: one name at a time, links followed, `..` taken from the part already resolved. */
function walk(p: string): { done: string; isFolder: boolean } {
  if (p === '') throw fsError('ENOENT', 'no such file or directory', p)
  const rest = (isAbsolute(p) ? p : process.cwd() + sep + p).split(sep).reverse()
  let done: string = sep
  let isFolder = true
  let links = 0
  while (rest.length > 0) {
    const name = rest.pop() as string
    // only a folder has names under it, its parent, itself (`.`) and a trailing separator included
    if (!isFolder) throw fsError('ENOTDIR', 'not a directory', p)
    if (name === '' || name === '.') continue
    // `done` has no link in it: its parent as text is its parent on the disk
    if (name === '..') {
      done = dirname(done)
      continue
    }
    const next = join(done, name)
    const st = lstatSync(next)
    if (!st.isSymbolicLink()) {
      done = next
      isFolder = st.isDirectory()
      continue
    }
    if (++links > MAX_LINKS) throw fsError('ELOOP', 'too many symbolic links encountered', p)
    const target = readlinkSync(next)
    if (isAbsolute(target)) done = sep
    for (const part of target.split(sep).reverse()) rest.push(part)
  }
  return { done, isFolder }
}

/** A name as a case-folding volume compares it: one Unicode form, one case. */
const fold = (s: string) => s.normalize('NFC').toLowerCase()

/** realFileSync, or null where it would throw. */
export function realFileOrNull(p: string): string | null {
  try {
    return realFileSync(p)
  } catch {
    return null
  }
}
