// The thread's instructions (AGENTS.md) in its settings: read and saved by the owner's signed device, for a thread with a
// folder of its own. Claude Code loads AGENTS.md beside CLAUDE.md in thread sessions (worker-policy.ts withInstructionFiles),
// so a save here changes how that thread's next sessions behave.
//
// - The folder is the thread's own (a dedicated thread whose folder is not the shared agent folder: a save there would be
//   Main's instructions too), fenced as the Files pane fences it (FilesService.fencedName).
// - AGENTS.md is read through one no-follow handle: a link, a hard link to another file or anything not a plain file is not
//   read or replaced. Over AGENTS_MD_MAX_BYTES it is shown as too large, never cut, and cannot be saved over from here.
// - A save is refused unless the file is still the one the editor loaded (`base_sha`), so a change made meanwhile, by the
//   agent or at the Mac, is never lost. It is written to a new file in the same folder and renamed over AGENTS.md, so a
//   reader never sees half of it. One save per thread at a time.
// - The Mac keeps, under <talos home>/threads/<id>/: agents-md.prev (the text before the last save), agents-md.saved (the
//   text of the last save made here), agents-md.folder (the folder those are for: another folder's records do not count) and
//   agents-md.told (the sha a session start last said had changed). The agent may
//   edit its own instructions: a change made outside Settings is never refused. Settings shows it as a diff against the
//   last save, and the next session start says so once in the thread, as a quiet line that never holds the start.
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { AGENTS_MD_DIFF_MAX, AGENTS_MD_MAX_BYTES, AGENTS_MD_WORDING, type FrameOf, lineDiff } from '@talos-app/protocol'
import { openResolvedNoFollow } from '../safe-open.ts'
import { ReadError } from '../v2-seams.ts'

export const AGENTS_MD = 'AGENTS.md'

type Envelope = 'v' | 'id' | 'ts' | 'type' | 'relay' | 'request_id'
export type AgentsMdFileBody = Omit<FrameOf<'agents_md.file'>, Envelope>

export type AgentsMdDeps = {
  /** The thread's own folder, or null when it has none (a shared thread, or a dedicated one in the agent folder). */
  ownFolder(threadId: string): string | null
  /** The thread's folder and AGENTS.md in it, fenced as the Files pane fences them; throws a ReadError refusal. */
  fenced(threadId: string): Promise<{ root: string; path: string }>
  /** Where the Mac keeps this thread's records: <talos home>/threads/<id>. */
  stateDir(threadId: string): string
}

type Current = { exists: false } | { exists: true; tooLarge: true } | { exists: true; tooLarge: false; bytes: Buffer }

/** The most JSON the text and the diff may take in one answer, well under a frame (MAX_FRAME_BYTES = 256 KiB). */
const ANSWER_JSON_MAX = 200 * 1024
const jsonBytes = (v: string) => Buffer.byteLength(JSON.stringify(v))
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const code = (e: unknown) => (e as { code?: string } | null)?.code

export class AgentsMdService {
  readonly available = true
  private readonly queue = new Map<string, Promise<unknown>>()

  constructor(private readonly d: AgentsMdDeps) {}

  async read(f: Pick<FrameOf<'agents_md.read'>, 'thread_id'>): Promise<AgentsMdFileBody> {
    const { root, path } = await this.folder(f.thread_id)
    return this.body(f.thread_id, root, current(path))
  }

  async write(f: Pick<FrameOf<'agents_md.write'>, 'thread_id' | 'text' | 'base_sha'>): Promise<AgentsMdFileBody> {
    const bytes = Buffer.from(f.text, 'utf8')
    if (bytes.length > AGENTS_MD_MAX_BYTES) throw new ReadError('too_large', AGENTS_MD_WORDING.tooLarge)
    const sha = sha256(bytes)
    return this.oneAtATime(f.thread_id, async () => {
      const { root, path } = await this.folder(f.thread_id)
      const now = current(path)
      if (now.exists && now.tooLarge) throw new ReadError('too_large', AGENTS_MD_WORDING.tooLarge)
      const nowSha = now.exists ? sha256(now.bytes) : null
      const done = { thread_id: f.thread_id, exists: true, sha, text: f.text, saved: true }
      // the same save again (its answer was lost on the way): it is there already, so it is saved, not a conflict
      if (nowSha === sha && f.base_sha !== sha) {
        this.record(f.thread_id, root, bytes, null)
        return done
      }
      if (nowSha !== f.base_sha) throw new ReadError('stale', AGENTS_MD_WORDING.conflict)
      writeInPlace(root, path, bytes, now.exists ? modeOf(path) : 0o644, () => {
        // asked once more just before the rename: an edit that landed since the check is not replaced
        const again = current(path)
        return (again.exists && !again.tooLarge ? sha256(again.bytes) : again.exists ? 'too-large' : null) === nowSha
      })
      this.record(f.thread_id, root, bytes, now.exists ? now.bytes : null)
      return done
    })
  }

  /**
   * At a thread session's start: true, once per change, when AGENTS.md is not what Settings last saved there. False when
   * Settings never saved it (in this folder), the thread has no folder of its own, or anything cannot be read: this never
   * holds a start.
   */
  async changedOutside(threadId: string): Promise<boolean> {
    try {
      if (!this.d.ownFolder(threadId)) return false
      const { root, path } = await this.d.fenced(threadId)
      const rec = this.records(threadId, root)
      if (!rec) return false
      const now = current(path)
      const nowSha = !now.exists ? 'none' : now.tooLarge ? 'too-large' : sha256(now.bytes)
      const told = join(this.d.stateDir(threadId), 'agents-md.told')
      if (nowSha === sha256(rec.saved)) {
        rmSync(told, { force: true }) // back to the saved text: a later change is a new one to tell
        return false
      }
      if (readOptional(told)?.toString('utf8').trim() === nowSha) return false
      replaceFile(told, Buffer.from(`${nowSha}\n`))
      return true
    } catch {
      return false
    }
  }

  /** The thread's folder and AGENTS.md path, or the refusal that says why there is none to edit. */
  private async folder(threadId: string): Promise<{ root: string; path: string }> {
    if (!this.d.ownFolder(threadId)) throw new ReadError('bad_frame', AGENTS_MD_WORDING.shared)
    return this.d.fenced(threadId)
  }

  /**
   * The Mac's records of a save made here, kept only when they are for this folder: a thread moved to another folder, or an
   * id used again, starts with none (no diff against another folder's text, no line for it).
   */
  private records(threadId: string, root: string): { saved: Buffer } | null {
    const dir = this.d.stateDir(threadId)
    if (readOptional(join(dir, 'agents-md.folder'))?.toString('utf8') !== root) return null
    const saved = readOptional(join(dir, 'agents-md.saved'))
    return saved === null ? null : { saved }
  }

  /** After a save: the text before it (`prev`, when there was one), the text saved, the folder, and nothing to tell. */
  private record(threadId: string, root: string, bytes: Buffer, prev: Buffer | null): void {
    const dir = this.d.stateDir(threadId)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      if (prev) replaceFile(join(dir, 'agents-md.prev'), prev)
      replaceFile(join(dir, 'agents-md.saved'), bytes)
      replaceFile(join(dir, 'agents-md.folder'), Buffer.from(root))
      replaceFile(join(dir, 'agents-md.told'), Buffer.from(`${sha256(bytes)}\n`))
    } catch {
      // saved, but not recorded: the next look may call this save a change made outside Settings, which is only a line
    }
  }

  private body(threadId: string, root: string, now: Current): AgentsMdFileBody {
    if (!now.exists) return { thread_id: threadId, exists: false, sha: null, ...this.outside(threadId, root, '', 0) }
    const large = { thread_id: threadId, exists: true, sha: null, too_large: true }
    if (now.tooLarge) return large
    let text: string
    try {
      // ignoreBOM keeps a leading byte-order mark as U+FEFF: the text's sha is then the file's, and a save keeps it
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(now.bytes)
    } catch {
      // not UTF-8: decoding would replace bytes, and a save would write that changed text back
      throw new ReadError('bad_frame', AGENTS_MD_WORDING.notText)
    }
    // the answer must fit one frame as JSON (a control character takes six bytes there)
    const used = jsonBytes(text)
    if (used > ANSWER_JSON_MAX) return large
    return {
      thread_id: threadId,
      exists: true,
      sha: sha256(now.bytes),
      text,
      ...this.outside(threadId, root, text, used),
    }
  }

  /** The change since the last save made here, when there was one and the file is not that any more; cut to fit the frame. */
  private outside(threadId: string, root: string, text: string, used: number): { outside_diff?: string } {
    const rec = this.records(threadId, root)
    if (!rec) return {}
    const diff = lineDiff(rec.saved.toString('utf8'), text)
    if (!diff) return {}
    // the room the text leaves in the answer: the diff is cut to it (by halves, so a bounded number of tries), else left out
    const CUT = '\n… (cut)'
    const room = ANSWER_JSON_MAX - used - jsonBytes(CUT)
    if (room < 64) return {}
    let body = diff.slice(0, AGENTS_MD_DIFF_MAX)
    while (body.length > 0 && jsonBytes(body) > room) body = body.slice(0, body.length >> 1)
    if (!body) return {}
    return { outside_diff: body.length < diff.length ? `${body}${CUT}` : body }
  }

  private oneAtATime<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const before = this.queue.get(threadId) ?? Promise.resolve()
    const run = before.then(work, work)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    this.queue.set(threadId, settled)
    void settled.then(() => {
      if (this.queue.get(threadId) === settled) this.queue.delete(threadId)
    })
    return run
  }
}

/** AGENTS.md as it is now, through one handle that follows no link anywhere in the path. */
function current(path: string): Current {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch (e) {
    if (code(e) === 'ENOENT') return { exists: false }
    throw new ReadError('bad_frame', AGENTS_MD_WORDING.refused)
  }
  if (st.isSymbolicLink()) throw new ReadError('bad_frame', AGENTS_MD_WORDING.link)
  if (!st.isFile()) throw new ReadError('bad_frame', AGENTS_MD_WORDING.refused)
  let fd: number
  try {
    fd = openResolvedNoFollow(path, constants.O_NONBLOCK)
  } catch (e) {
    if (code(e) === 'ENOENT') return { exists: false } // gone between the look and the open
    throw new ReadError('bad_frame', AGENTS_MD_WORDING.refused)
  }
  try {
    const h = fstatSync(fd)
    // a second name for this file elsewhere would let a save here write a file outside the folder
    if (!h.isFile() || h.nlink !== 1) throw new ReadError('bad_frame', AGENTS_MD_WORDING.refused)
    if (h.size > AGENTS_MD_MAX_BYTES) return { exists: true, tooLarge: true }
    const bytes = readFileSync(fd)
    if (bytes.length > AGENTS_MD_MAX_BYTES) return { exists: true, tooLarge: true }
    return { exists: true, tooLarge: false, bytes }
  } finally {
    closeSync(fd)
  }
}

function modeOf(path: string): number {
  try {
    return lstatSync(path).mode & 0o777
  } catch {
    return 0o644
  }
}

/**
 * Writes `bytes` to a new file beside AGENTS.md (created, never an existing one, no link followed anywhere in its path),
 * flushes it, then renames it over AGENTS.md. A failure leaves AGENTS.md as it was and removes the new file.
 */
function writeInPlace(root: string, path: string, bytes: Buffer, mode: number, stillSame: () => boolean): void {
  const tmp = join(root, `.AGENTS.md.talos-${randomBytes(6).toString('hex')}`)
  let fd: number | undefined
  try {
    // read-write, not write-only: the handle check reads where it points (/dev/fd/N), which a write-only handle may not
    fd = openResolvedNoFollow(tmp, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL)
    fchmodSync(fd, mode)
    for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off, bytes.length - off)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    if (!stillSame()) throw new ReadError('stale', AGENTS_MD_WORDING.conflict)
    renameSync(tmp, path)
  } catch (e) {
    if (fd !== undefined) closeSync(fd)
    rmSync(tmp, { force: true })
    if (e instanceof ReadError) throw e
    throw new ReadError('internal', AGENTS_MD_WORDING.saveFailed)
  }
}

/** One of the Mac's own records: a new file renamed over the old one. */
function replaceFile(path: string, bytes: Buffer): void {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' })
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

function readOptional(path: string): Buffer | null {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}
