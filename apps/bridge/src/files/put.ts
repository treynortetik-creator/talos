// Upload into a thread's folder (frames-files-put.ts): the owner's signed device names a folder inside the thread's folder,
// a file name and the media it uploaded; the Mac fetches that media (size and sha256 checked against the signed ref) and
// creates the file. The write fence:
// - the folder goes through the Files pane's fence (FilesService.fencedDir): inside the thread's folder by its real path,
//   not hidden, refused or lead-protected, a plain folder;
// - the name is one plain name (no separator, control character or broken text, at most 255 bytes), never hidden, never an
//   instruction file Claude Code reads (AGENTS.md, CLAUDE.md: those are edited in thread settings) or `.claude`;
// - the file is created, never opened: exclusive, with no link followed anywhere in its path (safe-open.ts), so nothing that
//   is there is ever overwritten or reached through a link. A taken name becomes "name (2).ext", up to FILES_PUT_CLASH_MAX;
// - at most FILES_PUT_MAX_BYTES a file and FILES_PUT_DAY_BYTES a device a UTC day; two at once. Nothing is ever deleted.
// A dropped file is content the agent will read: the same exposure as an attachment in a message.
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, rmSync, writeSync } from 'node:fs'
import { extname, join } from 'node:path'
import {
  type AttachmentRefT,
  FILES_NAME_MAX,
  FILES_PUT_CLASH_MAX,
  FILES_PUT_DAY_BYTES,
  FILES_PUT_MAX_BYTES,
  FILES_PUT_REFUSED_NAMES,
  FILES_PUT_WORDING,
  FILES_WORDING,
  type FrameOf,
  filesNameHidden,
} from '@talos-app/protocol'
import { openResolvedNoFollow } from '../safe-open.ts'
import { ReadError } from '../v2-seams.ts'

type Envelope = 'v' | 'id' | 'ts' | 'type' | 'relay' | 'request_id'
export type FilesPutResultBody = Omit<FrameOf<'files.put_result'>, Envelope>

export type FilesPutDeps = {
  /** The Files pane's fence for a folder to put a file in (FilesService.fencedDir). */
  fencedDir(threadId: string, dir: string): Promise<{ dir: string; allows(name: string): boolean }>
  /** The media's bytes, size and sha256 checked against the ref; throws when they cannot be fetched or do not match. */
  fetch(ref: AttachmentRefT): Promise<Uint8Array>
  now?: () => number
  /** A device's bytes a UTC day (default FILES_PUT_DAY_BYTES); tests use a small one. */
  dayBytes?: number
}

/** Uploads worked on at once (each holds up to 50 MB); more are told the folder is busy. */
const MAX_AT_ONCE = 2
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const code = (e: unknown) => (e as { code?: string } | null)?.code

/**
 * The name as a disk that ignores case may compare it: NFKC (fullwidth and compatibility forms to their plain ones), then
 * upper- and lower-cased, which folds the letters toLowerCase alone leaves, like U+017F long s (to s) and U+212A Kelvin (to k).
 * So `AGENTſ.md`, which APFS opens as AGENTS.md, is an instruction file here too.
 */
export const foldName = (name: string) => name.normalize('NFKC').toUpperCase().toLowerCase()
const forms = (name: string) => [name, name.toLowerCase(), foldName(name)]

/** One plain name a file may take here, or null: never hidden, never an instruction file, nothing that is not a name. */
export function plainUploadName(name: unknown): string | null {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..') return null
  if (name.includes('/') || name.includes('\\') || CONTROL.test(name) || name.includes('\uFFFD')) return null
  if (Buffer.byteLength(name) > FILES_NAME_MAX || name !== name.trim()) return null
  if (forms(name).some((n) => filesNameHidden(n) || n.includes('/'))) return null
  return name
}

const isInstructions = (name: string) => forms(name).some((n) => FILES_PUT_REFUSED_NAMES.includes(n))
/** The names a created file must not turn out to be, whatever the disk folds: the instruction files and node_modules. */
const NEVER = [...FILES_PUT_REFUSED_NAMES, 'node_modules']

/** "plan.md", "plan (2).md", ...: the n-th name to try (n = 1 is the name itself). */
export function clashName(name: string, n: number): string {
  if (n === 1) return name
  const ext = extname(name)
  const base = ext && ext !== name ? name.slice(0, -ext.length) : name
  return `${base} (${n})${ext === name ? '' : ext}`
}

export class FilesPutService {
  readonly available = true
  private busy = 0
  private readonly spent = new Map<string, { day: string; bytes: number }>()

  constructor(private readonly d: FilesPutDeps) {}

  private fenceOf(threadId: string, dir: string) {
    return this.d.fencedDir(threadId, dir).catch((e: unknown) => {
      throw e instanceof ReadError && e.message !== FILES_WORDING.refused
        ? e // no access, no folder, a hidden root: the Files pane's own words
        : new ReadError('bad_frame', FILES_PUT_WORDING.folder)
    })
  }

  async put(
    f: Pick<FrameOf<'files.put'>, 'thread_id' | 'dir' | 'name' | 'media'> & { device_id: string },
  ): Promise<FilesPutResultBody> {
    const name = plainUploadName(f.name)
    if (!name) throw new ReadError('bad_frame', FILES_PUT_WORDING.badName)
    if (isInstructions(name)) throw new ReadError('bad_frame', FILES_PUT_WORDING.instructions)
    if (f.media.size > FILES_PUT_MAX_BYTES) throw new ReadError('too_large', FILES_PUT_WORDING.tooLarge)
    if (this.busy >= MAX_AT_ONCE) throw new ReadError('internal', FILES_WORDING.slow)
    // the bytes are reserved up front (two at once cannot both slip under the day's budget) and given back on a failure
    const day = new Date((this.d.now ?? Date.now)()).toISOString().slice(0, 10)
    const had = this.spent.get(f.device_id)
    const used = had?.day === day ? had.bytes : 0
    if (used + f.media.size > (this.d.dayBytes ?? FILES_PUT_DAY_BYTES))
      throw new ReadError('rate_limited', FILES_PUT_WORDING.budget)
    this.spent.set(f.device_id, { day, bytes: used + f.media.size })
    this.busy++
    try {
      // a first look before the download, so a wrong folder is said at once and not after 50 MB
      const first = await this.fenceOf(f.thread_id, f.dir)
      if (!first.allows(name)) throw new ReadError('bad_frame', FILES_PUT_WORDING.protectedName)
      let bytes: Uint8Array
      try {
        bytes = await this.d.fetch(f.media)
      } catch {
        throw new ReadError('internal', FILES_PUT_WORDING.download)
      }
      // the fence after the fetch too: a marker or a folder changed during the download counts
      const target = await this.fenceOf(f.thread_id, f.dir)
      if (!target.allows(name)) throw new ReadError('bad_frame', FILES_PUT_WORDING.protectedName)
      const got = createExclusive(target.dir, name, bytes, target.allows)
      return { thread_id: f.thread_id, dir: f.dir, name: got, size: bytes.length }
    } catch (e) {
      const now = this.spent.get(f.device_id)
      if (now?.day === day) this.spent.set(f.device_id, { day, bytes: Math.max(0, now.bytes - f.media.size) })
      throw e
    } finally {
      this.busy--
    }
  }
}

/** Creates `name` (or the first free "name (n).ext") in `dir` and writes `bytes` to it. Never opens a file that is there. */
function createExclusive(dir: string, name: string, bytes: Uint8Array, allows: (name: string) => boolean): string {
  // the folder as it is now: a cleanup only ever touches this same folder, never one swapped in for it (a link to elsewhere)
  const home = lstatSync(dir)
  const same = () => {
    try {
      const now = lstatSync(dir)
      return now.isDirectory() && now.ino === home.ino && now.dev === home.dev
    } catch {
      return false
    }
  }
  for (let n = 1; n <= FILES_PUT_CLASH_MAX; n++) {
    const candidate = clashName(name, n)
    if (Buffer.byteLength(candidate) > FILES_NAME_MAX) throw new ReadError('bad_frame', FILES_PUT_WORDING.badName)
    if (isInstructions(candidate) || !allows(candidate))
      throw new ReadError('bad_frame', FILES_PUT_WORDING.protectedName)
    const path = join(dir, candidate)
    const there = exists(path)
    let fd: number
    try {
      // read-write, not write-only: the handle check reads where it points (/dev/fd/N), which a write-only handle may not
      fd = openResolvedNoFollow(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL)
    } catch (e) {
      if (code(e) === 'EEXIST') continue // taken (on a disk that ignores case, in any case): the next name
      // the create may have happened before the handle check refused it: an empty file this call made is not left behind
      if (!there && same()) removeIfEmpty(path)
      throw new ReadError('internal', FILES_PUT_WORDING.failed)
    }
    try {
      // whatever the disk folds, the new file must not BE an instruction file or node_modules under another spelling
      const me = fstatSync(fd)
      for (const never of NEVER) {
        let st: ReturnType<typeof lstatSync> | undefined
        try {
          st = lstatSync(join(dir, never))
        } catch {
          continue
        }
        if (st.ino === me.ino && st.dev === me.dev) throw new ReadError('bad_frame', FILES_PUT_WORDING.instructions)
      }
      fchmodSync(fd, 0o644)
      for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off, bytes.length - off)
      fsyncSync(fd)
    } catch (e) {
      closeSync(fd)
      rmSync(path, { force: true }) // the file this call created
      throw e instanceof ReadError ? e : new ReadError('internal', FILES_PUT_WORDING.failed)
    }
    closeSync(fd)
    return candidate
  }
  throw new ReadError('bad_frame', FILES_PUT_WORDING.clash)
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function removeIfEmpty(path: string): void {
  try {
    const st = lstatSync(path)
    if (st.isFile() && st.size === 0) rmSync(path, { force: true })
  } catch {
    // not there: nothing to remove
  }
}
