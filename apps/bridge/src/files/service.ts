// The Files pane's side on the Mac (docs/SECURITY.md "Files pane"): a read-only look at ONE thread's folder, the thread's own
// `session_opts.cwd` or the agent folder (the wiring's `rootFor` decides; the app only names the thread).
//
// The fence, for every list and read:
//   - the thread's folder itself has no hidden name anywhere in its real path (a folder of ~/.config would hand out every
//     tool's tokens), and is not inside a refused root;
//   - the asked path is relative, with no empty, '.' or '..' part, no control character, and no hidden name (a dot-name, so
//     .env* and .git, or node_modules) anywhere in it; nor does it name a refused root as written, before the disk is asked;
//   - its REAL path (links resolved) must be inside the folder's real path, with no hidden name in the part below the folder,
//     outside every refused root (the bridge's own home, Claude's config, the secret stores, ~/Library), and outside what a
//     lead's marker protects. A link that stays inside is followed; one that leaves, or lands on a hidden name, is refused,
//     and left out of listings;
//   - a file is read through ONE handle opened with no link followed in any component (safe-open.ts), so a folder swapped for
//     a link after the check fails the open; the handle must be a regular file with ONE name (a hard link to a file outside
//     the folder, or to .env inside it, passes every path check, so a file with more than one name is not shown);
//   - reads go through the thread pool (a file iCloud still has to download, or a stalled network disk, never freezes the
//     bridge), at most MAX_BUSY at once, and an answer past the time limit stops the work (no upload after a timeout);
//   - a text read is capped per answer and in all; a listing is cut to fit one frame; an image is uploaded only under its cap.
// Every refusal is the same sentence, for a missing path and a refused one alike, whatever the disk said: no oracle.
//
// ACCEPTED LIMIT (as for the folder picker and safe-open.ts): a listing reads the folder by name. A writer in the folder who
// swaps a folder for a link to another place, and back, between the realpath checks before and after can have a few NAMES and
// sizes of that place listed (never its contents: a read opens through the fenced handle). That needs write access inside
// the thread's folder, which the thread's own session has anyway.
import { createHash } from 'node:crypto'
import { closeSync, constants, promises as fsp, fstat, read, realpathSync, type Stats } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import {
  type AttachmentRefT,
  FILES_IMAGE_MAX,
  FILES_LIST_MAX,
  FILES_NAME_MAX,
  FILES_TEXT_CHUNK,
  FILES_TEXT_MAX,
  FILES_TIME_MS,
  FILES_WORDING,
  type FilesEntryT,
  type FrameOf,
  filesNameHidden,
  filesPathParts,
} from '@talos-app/protocol'
import { foldPath } from '../folders/service.ts'
import { LEAD_MARKER } from '../lead/init.ts'
import { openResolvedNoFollow, readRegularFile } from '../safe-open.ts'
import { ReadError } from '../v2-seams.ts'

export type FilesDeps = {
  /** The folder of a thread, or null for a thread the Mac does not know. */
  rootFor(threadId: string): string | null
  /** Never shown, even inside a thread's folder (the bridge's own home, Claude's config, the secret stores, ~/Library). */
  refused: readonly string[]
  media: { uploadBytes(bytes: Uint8Array, name: string, mime: string, role: 'attachment'): Promise<AttachmentRefT> }
  listMax?: number
  textChunk?: number
  textMax?: number
  imageMax?: number
  timeMs?: number
  /** Entries looked at in one folder before the listing stops and says it is partial (default SCAN_MAX). */
  scanMax?: number
  /** The time limits' timers (default: the global ones). Tests pass their own, to fire a limit without waiting for it. */
  timers?: FilesTimers
  /** The clock for how long an upload is reused (default: Date.now), and how many are remembered (default 64). For tests. */
  now?: () => number
  uploadsKept?: number
}

export type FilesTimers = {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
const realTimers: FilesTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

type Envelope = 'v' | 'id' | 'ts' | 'type' | 'relay' | 'request_id'
export type FilesListingBody = Omit<FrameOf<'files.listing'>, Envelope>
export type FilesFileBody = Omit<FrameOf<'files.file'>, Envelope>

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
}
/** The most JSON one answer carries, well under a frame (MAX_FRAME_BYTES = 256 KiB) with room for the rest of it. */
const ANSWER_JSON_MAX = 200 * 1024
/** Requests worked on at once; more are told the folder is slow. Each holds at most one handle and one chunk. */
const MAX_BUSY = 4
/** Work still out after its answer was given (a disk call that has not come back); past this, new requests wait. */
const MAX_LINGERING = 8
/** An image upload that takes longer than this is given up on, so the work behind a read always ends. */
const UPLOAD_MS = 30_000
/** How long a finished image upload is reused for the same bytes, and how many are remembered. */
const UPLOAD_KEEP_MS = 60 * 60_000
const UPLOADS_KEPT = 64
/** Entries looked at in one folder; past this the listing stops and says it is partial (and does not count the rest). */
const SCAN_MAX = 5000
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const within = (p: string, root: string) => p === root || p.startsWith(`${root}/`)
/** A name never shown or opened: hidden, by the rule both sides share, in any case the disk may answer to. */
const hiddenName = (name: string) => filesNameHidden(name) || filesNameHidden(name.toLowerCase())
const byKindThenName = (a: FilesEntryT, b: FilesEntryT) => {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  const x = a.name.toLowerCase()
  const y = b.name.toLowerCase()
  return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}
const code = (e: unknown) => (e as { code?: string } | null)?.code
const readP = promisify(read)
const fstatP = promisify(fstat)
const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v))

/**
 * `now`: the answer is no longer wanted, so stop. `release()`: what is left of this work holds nothing (no handle, no bytes),
 * so it is not counted as lingering once its answer is given.
 */
type Stop = { now: boolean; release?: () => void }

export class FilesService {
  readonly available = true
  private readonly refused: string[]
  private busy = 0
  private lingering = 0
  private readonly uploads = new Map<string, { p: Promise<AttachmentRefT>; at: number }>()

  constructor(private readonly d: FilesDeps) {
    // each refused root both as written and as the disk resolves it, folded
    this.refused = [
      ...new Set(
        d.refused.flatMap((r) => {
          try {
            return [foldPath(r), foldPath(realpathSync(r))]
          } catch {
            return [foldPath(r)]
          }
        }),
      ),
    ]
  }

  private refuse(): never {
    throw new ReadError('bad_frame', FILES_WORDING.refused)
  }

  /**
   * An image's upload, once per content. An upload can outlast the answer's time limit (the answer then says the folder is
   * slow), and it goes on; a later try for the same bytes waits on that same upload, or takes its finished answer, so the
   * preview shows and nothing is uploaded twice. Keyed by the bytes' sha256 and the name (the type follows from the name's
   * extension, so it adds nothing to the key); a failed upload is forgotten, and an answer is kept an hour at most (the relay
   * keeps the attachment far longer). `shared`: this try joined an upload already out or done, and holds none of its bytes.
   */
  private upload(bytes: Uint8Array, name: string, mime: string): { p: Promise<AttachmentRefT>; shared: boolean } {
    const key = `${createHash('sha256').update(bytes).digest('hex')}\0${name}`
    const now = (this.d.now ?? Date.now)()
    // the expired go first, so they neither answer nor take a place under the cap
    for (const [k, v] of this.uploads) if (now - v.at >= UPLOAD_KEEP_MS) this.uploads.delete(k)
    const had = this.uploads.get(key)
    if (had) return { p: had.p, shared: true }
    const p = this.d.media.uploadBytes(bytes, name, mime, 'attachment')
    // a new key goes to the end of the Map's order: the cap drops the oldest upload, never this one
    this.uploads.set(key, { p, at: now })
    p.catch(() => {
      if (this.uploads.get(key)?.p === p) this.uploads.delete(key)
    })
    while (this.uploads.size > (this.d.uploadsKept ?? UPLOADS_KEPT))
      this.uploads.delete(this.uploads.keys().next().value as string)
    return { p, shared: false }
  }

  /**
   * Runs `work` within the time limit and the caps; past the limit the answer is that the folder is slow, and `stop` is set. A
   * request gives its slot back when it is answered; work that goes on past its answer (a disk call that has not come back) is
   * counted apart, and while too much of it is still out new requests are told the folder is slow. Work that calls
   * `stop.release()` holds nothing from then on and is not counted.
   */
  private async timed<T>(work: (stop: Stop) => Promise<T>): Promise<T> {
    if (this.busy >= MAX_BUSY || this.lingering >= MAX_LINGERING) throw new ReadError('internal', FILES_WORDING.slow)
    this.busy++
    const state = { settled: false, lingering: false, released: false }
    const stop: Stop = {
      now: false,
      release: () => {
        state.released = true
        if (state.lingering) {
          state.lingering = false
          this.lingering--
        }
      },
    }
    const timers = this.d.timers ?? realTimers
    let timer: unknown
    const late = new Promise<never>((_, reject) => {
      timer = timers.setTimeout(() => {
        stop.now = true
        reject(new ReadError('internal', FILES_WORDING.slow))
      }, this.d.timeMs ?? FILES_TIME_MS)
    })
    const doing = work(stop)
    const done = () => {
      state.settled = true
      if (state.lingering) {
        state.lingering = false
        this.lingering--
      }
    }
    doing.then(done, done)
    try {
      return await Promise.race([doing, late])
    } finally {
      timers.clearTimeout(timer)
      stop.now = true
      this.busy--
      if (!state.settled && !state.released) {
        state.lingering = true
        this.lingering++
      }
    }
  }

  /**
   * The roots every `.talos-lead` marker at or above `dir` protects, folded (the lead fence's rule: all of them, not the nearest).
   * A marker is read only as a small regular file, never blocking (a named pipe in its place is not waited on); one that is
   * there but cannot be read or understood refuses everything, as it does for a lead's `attach`.
   */
  private async leadRoots(dir: string): Promise<string[]> {
    const roots: string[] = []
    for (let d = dir; ; d = dirname(d)) {
      const at = join(d, LEAD_MARKER)
      let there = true
      try {
        await fsp.lstat(at)
      } catch (e) {
        if (code(e) !== 'ENOENT' && code(e) !== 'ENOTDIR') this.refuse()
        there = false
      }
      if (there) {
        const buf = readRegularFile(at, 64 * 1024)
        if (!buf) this.refuse()
        let protect: unknown
        try {
          protect = (JSON.parse(buf.toString('utf8')) as { protect?: unknown } | null)?.protect
        } catch {
          this.refuse()
        }
        if (
          !Array.isArray(protect) ||
          protect.length === 0 ||
          !protect.every((r) => typeof r === 'string' && isAbsolute(r))
        )
          this.refuse()
        for (const r of protect as string[]) {
          roots.push(foldPath(r))
          try {
            roots.push(foldPath(realpathSync(r)))
          } catch {
            // not there now: the path as written still counts
          }
        }
      }
      if (d === dirname(d)) break
    }
    return roots
  }

  private isRefused(path: string): boolean {
    const p = foldPath(path)
    return this.refused.some((x) => within(p, x))
  }

  /** The thread's folder, as the disk spells it. */
  private async rootOf(threadId: string): Promise<string> {
    const r = this.d.rootFor(threadId)
    const gone = () => new ReadError('bad_frame', FILES_WORDING.noFolder)
    if (!r) throw gone()
    let real: string
    try {
      real = await fsp.realpath(r)
      if (!(await fsp.stat(real)).isDirectory()) throw gone()
    } catch (e) {
      if (code(e) === 'EACCES' || code(e) === 'EPERM') throw new ReadError('bad_frame', FILES_WORDING.noAccess)
      throw gone()
    }
    // a folder that is itself hidden, or inside a hidden or refused place (~/.config would hand out every tool's tokens), shows
    // nothing, and says why: the whole folder, not a file in it
    if (real.split('/').some(hiddenName) || this.isRefused(real))
      throw new ReadError('bad_frame', FILES_WORDING.hiddenRoot)
    return real
  }

  /** Throws unless `real` (a resolved path) is inside `root`, has no hidden name below it, and nothing (`lead`: marker roots) refuses it. */
  private inside(root: string, real: string, lead: readonly string[]): void {
    const p = foldPath(real)
    if (!within(p, foldPath(root))) this.refuse()
    if (real.slice(root.length).split('/').filter(Boolean).some(hiddenName)) this.refuse()
    if (this.isRefused(real)) this.refuse()
    if (lead.some((r) => within(p, r))) this.refuse()
  }

  /**
   * The thread's folder and `name` directly in it, fenced as the pane fences a listing of that folder: not hidden, refused
   * or lead-protected (for AGENTS.md, src/files/agents-md.ts). `name` need not exist; nothing is opened here.
   */
  async fencedName(threadId: string, name: string): Promise<{ root: string; path: string }> {
    const root = await this.rootOf(threadId)
    if (name.includes('/') || hiddenName(name)) this.refuse()
    const path = join(root, name)
    this.inside(root, path, await this.leadRoots(root))
    return { root, path }
  }

  /**
   * A folder inside the thread's folder for an upload (src/files/put.ts), fenced as a listing of it is: its real path (a plain
   * folder), and whether a name in it is one the fence lets through (not hidden, refused or lead-protected). Opens nothing.
   */
  async fencedDir(threadId: string, path: string): Promise<{ dir: string; allows(name: string): boolean }> {
    const root = await this.rootOf(threadId)
    const { real } = await this.resolve(root, path)
    try {
      if (!(await fsp.lstat(real)).isDirectory()) this.refuse()
    } catch (e) {
      if (e instanceof ReadError) throw e
      this.refuse()
    }
    const lead = await this.leadRoots(real)
    return {
      dir: real,
      allows: (name) => {
        if (name.includes('/') || hiddenName(name)) return false
        try {
          this.inside(root, join(real, name), lead)
          return true
        } catch {
          return false
        }
      },
    }
  }

  /** The real path of `path` inside the thread's folder, or a refusal. */
  private async resolve(root: string, path: unknown): Promise<{ parts: string[]; real: string }> {
    if (typeof path !== 'string' || CONTROL.test(path) || path.includes('�')) return this.refuse()
    const parts = filesPathParts(path)
    if (!parts || parts.some(hiddenName)) return this.refuse()
    // a refused place as written is refused before the disk is asked anything about it (no "no access" for what is there)
    if (this.isRefused(join(root, ...parts))) this.refuse()
    let real: string
    try {
      real = await fsp.realpath(join(root, ...parts))
    } catch {
      // missing, not allowed, a loop: all the one refusal, so a path's answer never says what is behind it
      return this.refuse()
    }
    // the lead markers at or above the folder that holds it (below the thread's folder too: a lead inside it keeps its roots)
    this.inside(root, real, await this.leadRoots(dirname(real)))
    return { parts, real }
  }

  async list(f: Pick<FrameOf<'files.list'>, 'thread_id' | 'path'>): Promise<FilesListingBody> {
    return this.timed(async (stop) => {
      const root = await this.rootOf(f.thread_id)
      const { parts, real } = await this.resolve(root, f.path)
      // the markers at or above the listed folder, once for the whole listing (a marker in it protects some of its entries)
      const lead = await this.leadRoots(real)
      const entries: FilesEntryT[] = []
      let seen = 0
      let partial = false
      try {
        if (!(await fsp.stat(real)).isDirectory()) this.refuse()
        const dir = await fsp.opendir(real)
        for await (const e of dir) {
          if (stop.now) return this.refuse()
          if (++seen > (this.d.scanMax ?? SCAN_MAX)) {
            partial = true // a very large folder: what was looked at is shown, and the answer says there is more
            break
          }
          const name = e.name
          if (name.length === 0 || name.length > FILES_NAME_MAX || CONTROL.test(name) || name.includes('�')) continue
          if (name.includes('/') || hiddenName(name)) continue
          const at = join(real, name)
          let st: Stats | null
          if (e.isSymbolicLink()) {
            // a link: where it really goes must pass the fence before anything about that place is looked at
            let target: string
            try {
              target = await fsp.realpath(at)
              this.inside(root, target, lead)
            } catch {
              continue // dangling, or it leaves, or it lands on a hidden or refused name
            }
            st = await fsp.stat(target).catch(() => null)
          } else {
            // not a link when the folder was read: lstat, so one swapped in since is not followed
            try {
              this.inside(root, at, lead)
            } catch {
              continue
            }
            st = await fsp.lstat(at).catch(() => null)
          }
          if (st?.isDirectory()) entries.push({ name, kind: 'dir' })
          else if (st?.isFile() && st.nlink === 1) entries.push({ name, kind: 'file', size: st.size })
        }
        // the folder may have been swapped for another place while it was read: look again before any name goes out
        const again = await fsp.realpath(join(root, ...parts))
        if (foldPath(again) !== foldPath(real)) this.refuse()
        this.inside(root, again, lead)
      } catch {
        return this.refuse()
      }
      entries.sort(byKindThenName)
      const max = this.d.listMax ?? FILES_LIST_MAX
      // cut to the cap, and to what fits in one frame
      const shown: FilesEntryT[] = []
      let bytes = jsonBytes({ thread_id: f.thread_id, root, path: f.path })
      for (const e of entries.slice(0, max)) {
        bytes += jsonBytes(e) + 1
        if (bytes > ANSWER_JSON_MAX) break
        shown.push(e)
      }
      // `more` counts only what would have been shown (never a hidden name); past SCAN_MAX nothing is counted, `partial` says so
      return {
        thread_id: f.thread_id,
        root,
        path: f.path,
        entries: shown,
        more: entries.length - shown.length,
        ...(partial ? { partial: true } : {}),
      }
    })
  }

  async read(f: Pick<FrameOf<'files.read'>, 'thread_id' | 'path' | 'offset'>): Promise<FilesFileBody> {
    return this.timed(async (stop) => {
      const root = await this.rootOf(f.thread_id)
      const { real } = await this.resolve(root, f.path)
      if (stop.now) this.refuse()
      let fd: number
      try {
        // no link followed in any part of the path, and a named pipe never blocks
        fd = openResolvedNoFollow(real, constants.O_NONBLOCK)
      } catch {
        return this.refuse()
      }
      let open = true
      const close = () => {
        if (open) closeSync(fd)
        open = false
      }
      try {
        const st = await fstatP(fd)
        // belt and braces: a folder or a pipe would also fail the read below, into the same refusal
        if (!st.isFile()) this.refuse()
        // a second name for the same file (a hard link) passes every path check: to a file outside, or to .env inside
        if (st.nlink !== 1) this.refuse()
        const base = { thread_id: f.thread_id, path: f.path, size: st.size, mtime: st.mtime.toISOString() }
        const mime = IMAGE_MIME[extname(real).toLowerCase()]
        if (mime) {
          if (st.size > (this.d.imageMax ?? FILES_IMAGE_MAX))
            return { ...base, kind: 'image', truncated: false, message: FILES_WORDING.tooBig }
          // the bytes live only in here: a try that joins another's upload keeps none of them while it waits
          const up = await (async () => {
            const bytes = await readAt(fd, 0, st.size, stop)
            if (stop.now) this.refuse() // too late: nothing is uploaded for an answer nobody waits for
            return this.upload(bytes, basename(real), mime)
          })()
          if (up.shared) {
            // it only waits on another try's upload now: the file is shut and its bytes are not held, so it is not lingering
            close()
            stop.release?.()
          }
          const media = await withinMs(up.p, UPLOAD_MS, this.d.timers ?? realTimers)
          return { ...base, kind: 'image', truncated: false, media }
        }
        if ((await readAt(fd, 0, Math.min(8192, st.size), stop)).includes(0))
          return { ...base, kind: 'binary', truncated: false, message: FILES_WORDING.binary }
        const end = Math.min(st.size, this.d.textMax ?? FILES_TEXT_MAX)
        const offset = Math.min(f.offset, end)
        const len = Math.min(this.d.textChunk ?? FILES_TEXT_CHUNK, end - offset)
        // one byte past the chunk tells whether the cut falls inside a character; it is then moved back to that character's start
        const buf = await readAt(fd, offset, len + 1, stop)
        let cut = cutAt(buf, len, offset + len >= end)
        let text = buf.subarray(0, cut).toString('utf8')
        // the answer must fit in one frame as JSON, where a control character takes six bytes: halve the chunk until it does
        while (cut > 1 && jsonBytes(text) > ANSWER_JSON_MAX) {
          cut = cutAt(buf, Math.floor(cut / 2), false)
          text = buf.subarray(0, cut).toString('utf8')
        }
        const next = offset + cut < end ? offset + cut : null
        return {
          ...base,
          kind: 'text',
          text,
          offset,
          next_offset: next,
          truncated: next === null && st.size > end,
        }
      } catch (e) {
        if (e instanceof ReadError) throw e
        return this.refuse()
      } finally {
        close()
      }
    })
  }
}

/** `p`, or a refusal past `ms`: the work behind an answer always ends (the upload itself may finish later, unwatched). */
function withinMs<T>(p: Promise<T>, ms: number, timers: FilesTimers): Promise<T> {
  let timer: unknown
  const late = new Promise<never>((_, reject) => {
    timer = timers.setTimeout(() => reject(new ReadError('internal', FILES_WORDING.slow)), ms)
  })
  return Promise.race([p, late]).finally(() => timers.clearTimeout(timer))
}

/** Where to cut `buf` at most `len` bytes in: at `len` when that is the end, else back to the start of the character there. */
function cutAt(buf: Buffer, len: number, atEnd: boolean): number {
  let cut = len
  if (!atEnd) while (cut > 0 && ((buf[cut] ?? 0) & 0xc0) === 0x80) cut--
  return cut === 0 && len > 0 ? len : cut // a chunk smaller than one character: send it whole rather than loop
}

/** Up to `len` bytes of the open file from `pos`, on the thread pool; stops early once the answer is no longer wanted. */
async function readAt(fd: number, pos: number, len: number, stop: Stop): Promise<Buffer> {
  const buf = Buffer.alloc(len)
  let got = 0
  while (got < len && !stop.now) {
    const { bytesRead } = await readP(fd, buf, got, len - got, pos + got)
    if (bytesRead === 0) break
    got += bytesRead
  }
  return buf.subarray(0, got)
}
