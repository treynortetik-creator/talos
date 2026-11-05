// What the memory browser may show (docs/V2-FEATURES.md V5.1): the one place that decides. Everything out of scope is
// "not there": the callers answer `memory_not_found` for it and never say why. Nothing here writes.
//
// The open does the heavy lifting: no LINK in any path component is followed (safe-open.ts), and the kernel is asked where
// the handle really is, so a swapped-in link makes the open fail, and so does a real folder that was moved away again by the
// handle check. ACCEPTED LIMIT: a real folder renamed into place and left there, or flipped in AFTER the check, is not seen (the private marker
// can then be beaten by someone who can rename folders beside the root; see docs/SECURITY.md). What the open cannot also
// see: a real file moved into the root under an allowed name (name-based rules cannot tell), and a hard link (st_nlink).
// A read is decided on the thing that is OPENED, not the name that was asked for: the real path is resolved, the file is
// opened without following a final symlink, the open file is checked (regular, one link, under the size cap), the path
// is resolved again and must still be the same file inside the root, and the rules run on BOTH the requested path and the
// real one, folded for the Mac's case- and Unicode-insensitive file system.
import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  lstatSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { openResolvedNoFollow, openSeam } from '../safe-open.ts'
import { type MemoryConfig, type MemoryRootCfg, throughDenied, within } from './config.ts'
import { fold, MAX_EXPOSED_BYTES, PRIVATE_MARKER, pathDenied, segmentDenied } from './deny.ts'

export type ScopeFile = { path: string; size: number; mtimeMs: number }
/** An open, verified file. The caller MUST `close()` it. */
export type Opened = {
  root: ResolvedRoot
  path: string
  /** realpath of the file. */
  abs: string
  fd: number
  size: number
  mtimeMs: number
  dev: number
  ino: number
  close(): void
}

export class ResolvedRoot {
  readonly includes: Bun.Glob[]
  readonly excludes: Bun.Glob[]
  constructor(
    readonly cfg: MemoryRootCfg,
    /** realpath of the root folder. */
    readonly dir: string,
  ) {
    this.includes = cfg.include.map((g) => new Bun.Glob(fold(g)))
    this.excludes = cfg.exclude.map((g) => new Bun.Glob(fold(g)))
  }
  get id() {
    return this.cfg.id
  }
  /** Include and exclude globs against a root-relative POSIX path, folded the way the file system folds names. */
  matches(rel: string): boolean {
    const f = fold(rel)
    return this.includes.some((g) => g.match(f)) && !this.excludes.some((g) => g.match(f))
  }
}

const byteLen = (s: string) => Buffer.byteLength(s, 'utf8')

/** A path the protocol can carry: `MemoryPath` is at most 512 UTF-8 bytes and a name at most 255 characters. */
export const addressable = (rel: string) => byteLen(rel) <= 512 && rel.split('/').every((s) => s.length <= 255)

export class MemoryScope {
  readonly roots: ResolvedRoot[]
  private readonly agentDir: string
  constructor(cfg: MemoryConfig) {
    this.agentDir = cfg.agent_dir
    const roots: ResolvedRoot[] = []
    let agentReal = cfg.agent_dir
    try {
      agentReal = realpathSync(cfg.agent_dir)
    } catch {
      // no agent folder: no roots below
    }
    for (const r of cfg.roots) {
      try {
        const real = realpathSync(join(cfg.agent_dir, r.path))
        // config parsing checked this already, but the folder can be swapped for a link between that check and here; the
        // root must be re-proved inside agent_dir or every later check would be measured against the wrong folder
        if (!within(agentReal, real) || throughDenied(agentReal, real)) continue
        roots.push(new ResolvedRoot(r, real))
      } catch {
        // a root folder that vanished is just empty until it returns
      }
    }
    this.roots = roots
  }

  root(id: string): ResolvedRoot | undefined {
    return this.roots.find((r) => r.id === id)
  }

  /** Any entry named `.talos-private` counts, even a dangling symlink (lstat does not follow). */
  private marked(dir: string): boolean {
    try {
      lstatSync(join(dir, PRIVATE_MARKER))
      return true
    } catch {
      return false
    }
  }

  /** A marker in the root or in any folder above it up to agent_dir hides the whole root (the owner's "never" lever). */
  private rootHidden(root: ResolvedRoot): boolean {
    for (let d = root.dir; ; d = dirname(d)) {
      if (this.marked(d)) return true
      if (d === this.agentDir || !within(this.agentDir, d) || dirname(d) === d) return false
    }
  }

  /** The rules for one root-relative path (no file access): denylist on every segment, include and exclude globs. */
  private allowedRel(root: ResolvedRoot, rel: string): boolean {
    return rel !== '' && !pathDenied(rel) && root.matches(rel)
  }

  /**
   * Opens one file for reading if, and only if, it is in scope. Verified on the open file; see the header. `null` for
   * anything out of scope, whatever the reason.
   */
  open(rootId: string, rel: string): Opened | null {
    const root = this.root(rootId)
    if (!root || !this.allowedRel(root, rel) || this.rootHidden(root)) return null
    const segs = rel.split('/')
    // markers on the logical path
    let dir = root.dir
    for (const s of segs.slice(0, -1)) {
      dir = join(dir, s)
      if (this.marked(dir)) return null
    }
    const abs = join(root.dir, ...segs)
    const checkReal = (real: string): string | null => {
      if (!within(root.dir, real) || real === root.dir) return null
      const realRel = real
        .slice(root.dir.length + 1)
        .split(sep)
        .join('/')
      // the same rules on the file that is really there (a link into .git, an excluded note, a non-included file)
      if (!this.allowedRel(root, realRel)) return null
      for (let d = dirname(real); within(root.dir, d); d = dirname(d)) {
        if (this.marked(d)) return null
        if (d === root.dir) break
      }
      return real
    }
    let real: string | null
    try {
      real = checkReal(realpathSync(abs))
    } catch {
      return null
    }
    if (!real) return null
    let fd: number | undefined
    try {
      // No link in ANY component is followed (see safe-open.ts): a folder swapped for a symlink after the check above
      // makes the open fail. O_NONBLOCK: opening a named pipe (or a device) must not wait for a writer; the fstat below
      // then refuses it.
      fd = openResolvedNoFollow(real, constants.O_NONBLOCK)
      const st = fstatSync(fd)
      // a regular file, one name (a hard link carries content in under an innocent name), under the hard cap
      if (!st.isFile() || st.nlink !== 1 || st.size > MAX_EXPOSED_BYTES) return fail(fd)
      // the path must still lead to THIS file, inside the root
      const again = checkReal(realpathSync(abs))
      if (again !== real) return fail(fd)
      openSeam.betweenRechecks?.()
      const now = statSync(again)
      if (now.dev !== st.dev || now.ino !== st.ino) return fail(fd)
      const opened = fd
      return {
        root,
        path: rel,
        abs: real,
        fd: opened,
        size: st.size,
        mtimeMs: st.mtimeMs,
        dev: st.dev,
        ino: st.ino,
        close: () => {
          try {
            closeSync(opened)
          } catch {
            // already closed
          }
        },
      }
    } catch {
      if (fd !== undefined) fail(fd)
      return null
    }
  }

  /** `open` and close at once: is this file readable right now? */
  allowed(rootId: string, rel: string): boolean {
    const o = this.open(rootId, rel)
    if (!o) return false
    o.close()
    return true
  }

  /** A folder shown in a listing: no denied segment and no `.talos-private` from agent_dir down to it. */
  dirVisible(rootId: string, rel: string): boolean {
    const root = this.root(rootId)
    if (!root || pathDenied(rel) || this.rootHidden(root)) return false
    let dir = root.dir
    for (const s of rel.split('/').filter(Boolean)) {
      dir = join(dir, s)
      if (this.marked(dir)) return false
    }
    // the folder must really be where its name says, inside the root: a name that is now a link out of it is not shown
    try {
      const real = realpathSync(dir)
      if (real !== root.dir && (!within(root.dir, real) || this.marked(real))) return false
      if (
        real !== dir &&
        real
          .slice(root.dir.length + 1)
          .split(sep)
          .some(segmentDenied)
      )
        return false
    } catch {
      return false
    }
    return true
  }

  /** Every visible file of a root. Stops at `limit` files; `truncated` says it did. */
  walk(root: ResolvedRoot, limit: number): { files: ScopeFile[]; truncated: boolean } {
    const files: ScopeFile[] = []
    if (this.rootHidden(root)) return { files, truncated: false }
    const seenDirs = new Set<string>()
    let truncated = false
    const visit = (logicalRel: string, realDir: string) => {
      if (truncated || seenDirs.has(realDir)) return
      seenDirs.add(realDir)
      if (this.marked(realDir)) return
      let entries: Dirent[]
      try {
        entries = readdirSync(realDir, { withFileTypes: true })
      } catch {
        return
      }
      // a folder swapped for a link while it was being listed: drop what was read (best effort - the listing is names,
      // sizes and times only; every file is still opened through `open` before any content is served)
      try {
        if (realpathSync(realDir) !== realDir) return
      } catch {
        return
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const e of entries) {
        if (truncated) return
        if (segmentDenied(e.name)) continue
        const rel = logicalRel ? `${logicalRel}/${e.name}` : e.name
        const full = join(realDir, e.name)
        let real = full
        let isDir = e.isDirectory()
        let isFile = e.isFile()
        // anything reached through a link, or a name APFS may have folded, is judged by where it really is
        const viaLink =
          e.isSymbolicLink() ||
          logicalRel !==
            realDir
              .slice(root.dir.length + 1)
              .split(sep)
              .join('/')
        if (e.isSymbolicLink()) {
          try {
            real = realpathSync(full)
            const st = statSync(real)
            isDir = st.isDirectory()
            isFile = st.isFile()
          } catch {
            continue
          }
          if (!within(root.dir, real)) continue // a link out of the root is hidden
          if (
            real
              .slice(root.dir.length + 1)
              .split(sep)
              .some(segmentDenied)
          )
            continue // a link INTO .git, venv, ...
        }
        if (isDir) visit(rel, real)
        else if (isFile) {
          if (!addressable(rel) || !root.matches(rel)) continue
          if (viaLink) {
            const realRel = real
              .slice(root.dir.length + 1)
              .split(sep)
              .join('/')
            if (!this.allowedRel(root, realRel)) continue
          }
          let st: ReturnType<typeof statSync>
          try {
            st = statSync(real)
          } catch {
            continue
          }
          if (st.size > MAX_EXPOSED_BYTES || st.nlink !== 1) continue
          if (files.length >= limit) {
            truncated = true
            return
          }
          files.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs })
        }
      }
    }
    visit('', root.dir)
    return { files, truncated }
  }
}

function fail(fd: number): null {
  try {
    closeSync(fd)
  } catch {
    // already closed
  }
  return null
}

/** Reads at most `max` bytes from the open file. */
export function readCapped(o: Opened, max: number): Buffer {
  const want = Math.min(o.size, max)
  const buf = Buffer.alloc(want)
  let got = 0
  while (got < want) {
    const n = readSync(o.fd, buf, got, want - got, got)
    if (n <= 0) break
    got += n
  }
  return got === want ? buf : buf.subarray(0, got)
}

const STRICT = new TextDecoder('utf-8', { fatal: true })

/**
 * Text only: no NUL in the first 8 KiB and valid UTF-8 throughout. A file cut at the size cap may end mid-character, so
 * the cut is moved back to a character boundary first (returns the usable bytes) - null when it is not text.
 */
export function asText(buf: Buffer, truncated: boolean): Buffer | null {
  if (buf.subarray(0, 8192).includes(0)) return null
  let end = buf.length
  if (truncated) {
    // a cut at the size cap may land inside a character: drop the unfinished sequence, if any
    for (let i = end - 1; i >= Math.max(0, end - 4); i--) {
      const b = buf[i] as number
      if ((b & 0xc0) === 0x80) continue // continuation byte: keep looking for its lead
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
      if (i + need > end) end = i
      break
    }
  }
  const out = buf.subarray(0, end)
  try {
    STRICT.decode(out)
  } catch {
    return null
  }
  return out
}
