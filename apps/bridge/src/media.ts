// Files in and out (spec 4.4, 3.5). Downloads are verified against the signed sha256 before they touch disk under a
// name we choose; uploads go to PUT /bridge/media/:id with X-Talos-Sha256. Paths the agent may not upload are refused.
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, sep } from 'node:path'
import { type AttachmentRefT, newId, sha256Hex } from '@talos-app/protocol'
import type { BridgePaths } from './config.ts'
import { ensureDir, writeFileAtomic } from './fsutil.ts'
import { leadAttachRefusal } from './lead/marker-roots.ts'
import type { Logger } from './log.ts'
import type { RelayHttp } from './relay-http.ts'
import { openResolvedNoFollow, readRegularFile } from './safe-open.ts'
import { AUDIO_MIME, UPLOAD_COPY_PREFIX } from './tts.ts'

export const MAX_FILE_BYTES = 50 * 1024 * 1024
/** Old files going back up at once (each is read whole into memory). */
const MAX_CONCURRENT_REHYDRATES = 2

const MIME_BY_EXT: Record<string, string> = {
  ...Object.fromEntries(Object.entries(AUDIO_MIME).map(([k, v]) => [`.${k}`, v])),
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.vtt': 'text/vtt',
  '.srt': 'application/x-subrip',
  '.html': 'text/html',
  '.htm': 'text/html',
}
const EXT_BY_MIME: Record<string, string> = {
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/vtt': '.vtt',
  'application/x-subrip': '.srt',
  'application/json': '.json',
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const UNSAFE_NAME_CHARS = /[:/\\\u0000-\u001f\u007f-\u009f]/g

/**
 * The stored file name for an upload. A display title the agent gives is cleaned of characters unsafe in file names
 * (: / \ and control characters) and always ends in the real file's extension, so a download keeps opening as what it is.
 * Without a usable title the file's own name is kept.
 */
export function storedFileName(title: string | undefined, realPath: string, mime: string): string {
  const own = basename(realPath)
  const cleaned = (title ?? '').replace(UNSAFE_NAME_CHARS, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim()
  if (!cleaned) return own.slice(0, 200)
  const pathExt = extname(realPath).toLowerCase()
  const ext = /^\.[a-z0-9]{1,8}$/.test(pathExt) ? pathExt : (EXT_BY_MIME[mime] ?? '')
  if (!ext || cleaned.toLowerCase().endsWith(ext)) return cleaned.slice(0, 200)
  // cut the title, not the extension
  return cleaned.slice(0, 200 - ext.length).trimEnd() + ext
}

export const mimeFor = (path: string) => MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream'

export function kindFor(mime: string): AttachmentRefT['kind'] {
  if (mime === 'text/html') return 'html'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return 'file'
}

export class MediaError extends Error {}

/** $HOME first (a test or a service can point it elsewhere at run time), the account's home otherwise. */
const userHome = () => process.env.HOME || homedir()

export type Downloaded = { path: string; ref: AttachmentRefT }

export class MediaStore {
  constructor(
    private readonly p: BridgePaths,
    private readonly http: RelayHttp,
    private readonly log?: Logger,
    /** Writes the kept copy; injectable so a full disk can be tested. */
    private readonly writeCopy: (path: string, bytes: Uint8Array, mode: number) => void = writeFileAtomic,
  ) {
    ensureDir(p.media)
  }

  /** Where a stored media file lives (by id, so a name chosen by the sender never reaches the file system). */
  private localPath(mediaId: string, ext: string) {
    return join(this.p.media, `${mediaId}${ext}`)
  }

  /** Downloads an owner attachment and checks size and sha256 against the signed AttachmentRef. */
  async download(ref: AttachmentRefT): Promise<Downloaded> {
    const bytes = await this.http.getMedia(ref.media_id, Math.min(ref.size, MAX_FILE_BYTES))
    if (bytes.length !== ref.size) throw new MediaError(`size mismatch for ${ref.media_id}`)
    if (sha256Hex(bytes) !== ref.sha256) throw new MediaError(`sha256 mismatch for ${ref.media_id}`)
    const nameExt = extname(ref.name).toLowerCase()
    const ext = EXT_BY_MIME[ref.mime] ?? (/^\.[a-z0-9]{1,5}$/.test(nameExt) ? nameExt : '')
    const path = this.localPath(ref.media_id, ext)
    writeFileAtomic(path, bytes, 0o600)
    writeFileAtomic(join(this.p.media, `${ref.media_id}.json`), JSON.stringify({ path, ref }), 0o600)
    return { path, ref }
  }

  /** Paths that must not leave the Mac through `reply`/`attach` (keys, ledger, config, tokens). This guards the NAME, to
   * stop accidents; a copy or hard link of the same bytes under another name is not caught (see docs/SECURITY.md). */
  isSensitive(realPath: string): boolean {
    const home = existsSync(this.p.home) ? realpathSync(this.p.home) : this.p.home
    const inHome = realPath === home || realPath.startsWith(home + sep)
    const inMedia = realPath.startsWith(join(home, 'media') + sep) || realPath.startsWith(join(home, 'approved') + sep)
    if (inHome && !inMedia) return true
    // Fixed token files, kept off the wire after the Telegram mirror went: compared by real path, so a symlink is caught.
    for (const f of [
      join(userHome(), '.claude', 'channels', 'telegram', '.env'),
      join(userHome(), '.config', 'talos', 'notify.env'),
    ]) {
      try {
        if (existsSync(f) && realpathSync(f) === realPath) return true
      } catch {
        // an unreadable link is not this file
      }
    }
    const b = basename(realPath)
    return b === '.env' || b.startsWith('.env.') || b === 'bridge.env'
  }

  /**
   * Validates a path the agent gave us. A thread session (`worker`) may send a file from its OWN thread's inbox (`thread` is
   * its id), never another thread's, and nothing from the Talos home or a lead's protected roots.
   */
  checkUploadable(
    path: string,
    opts: { worker?: boolean; leadCwd?: string; thread?: string } = {},
  ): { realPath: string; size: number } {
    if (!isAbsolute(path)) throw new MediaError(`not an absolute path: ${path}`)
    if (!existsSync(path)) throw new MediaError(`no such file: ${path}`)
    const realPath = realpathSync(path)
    const st = statSync(realPath)
    if (!st.isFile()) throw new MediaError(`not a regular file: ${path}`)
    if (st.size > MAX_FILE_BYTES) throw new MediaError(`file is over 50 MB: ${path}`)
    // the threads' inboxes (outside the Talos home): a thread session sends its own and no other
    if (opts.worker && this.p.inbox) {
      const root = existsSync(this.p.inbox) ? realpathSync(this.p.inbox) : this.p.inbox
      if (realPath.startsWith(root + sep)) {
        if (opts.thread && realPath.startsWith(join(root, opts.thread) + sep)) return { realPath, size: st.size }
        throw new MediaError(`a thread session can only send files from its own inbox: ${basename(path)}`)
      }
    }
    if (this.isSensitive(realPath)) throw new MediaError(`refusing to upload a protected file: ${basename(path)}`)
    // media/ holds every thread's files in one flat folder: a thread's own session sends its own files, never one from here
    if (opts.worker) {
      const home = existsSync(this.p.home) ? realpathSync(this.p.home) : this.p.home
      if (realPath === home || realPath.startsWith(home + sep))
        throw new MediaError(`a thread session cannot send a file from the Talos folder: ${basename(path)}`)
      // a lead: nothing inside the protected roots its marker lists
      const why = leadAttachRefusal(opts.leadCwd, realPath)
      if (why) throw new MediaError(`${why}: ${basename(path)}`)
    }
    return { realPath, size: st.size }
  }

  /** Uploads a local file and returns its AttachmentRef. */
  async upload(
    path: string,
    opts: { role?: 'attachment' | 'voice_reply'; name?: string; mime?: string; kind?: AttachmentRefT['kind'] } = {},
  ): Promise<AttachmentRefT> {
    const { realPath } = this.checkUploadable(path)
    // Read through ONE handle opened with no link followed, not by name: a folder swapped for a link to the bridge home
    // after the check above would otherwise send a protected file (keys, ledger) off the Mac. The handle is fstat'ed
    // again because the check above was on a name. O_NONBLOCK: a named pipe must not hang the bridge.
    let fd: number
    try {
      fd = openResolvedNoFollow(realPath, constants.O_NONBLOCK)
    } catch {
      throw new MediaError(`cannot read ${basename(path)}`)
    }
    let bytes: Uint8Array
    let size: number
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) throw new MediaError(`not a regular file: ${path}`)
      if (st.size > MAX_FILE_BYTES) throw new MediaError(`file is over 50 MB: ${path}`)
      size = st.size
      bytes = new Uint8Array(readFileSync(fd))
    } catch (e) {
      if (e instanceof MediaError) throw e
      throw new MediaError(`cannot read ${basename(path)}`)
    } finally {
      closeSync(fd)
    }
    const sha = sha256Hex(bytes)
    const mime = opts.mime ?? mimeFor(realPath)
    const id = newId('md')
    const name = opts.name === undefined ? basename(realPath).slice(0, 200) : storedFileName(opts.name, realPath, mime)
    await this.http.putMedia(id, bytes, sha, mime, name)
    const ref: AttachmentRefT = {
      media_id: id,
      kind: opts.kind ?? kindFor(mime),
      role: opts.role ?? 'attachment',
      mime,
      name,
      size,
      sha256: sha,
    }
    // Keep our own copy: the agent's path is often a temp file that is gone long before the relay's 7-day buffer ends,
    // and `media.fetch` can only bring back what is still on the Mac. A file already in the media folder is its own copy.
    const mediaDir = existsSync(this.p.media) ? realpathSync(this.p.media) : this.p.media
    let keepPath = realPath
    if (!realPath.startsWith(mediaDir + sep)) {
      const ext = extname(name).toLowerCase()
      const copyPath = join(this.p.media, `${UPLOAD_COPY_PREFIX}${id}${/^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ''}`)
      try {
        this.writeCopy(copyPath, bytes, 0o600)
        keepPath = copyPath
      } catch (e) {
        // Best effort: the relay already has the bytes, so a full disk must not make a delivered file look like a failed
        // send (the agent would send it again). The sidecar keeps pointing at the original path.
        this.log?.warn('kept copy not written', { media_id: id, error: (e as Error).message })
      }
    }
    // the sidecar index lets `media.fetch` re-upload it after the relay's buffer expires
    writeFileAtomic(join(this.p.media, `${id}.json`), JSON.stringify({ path: keepPath, ref }), 0o600)
    return ref
  }

  private readonly rehydrating = new Map<string, Promise<boolean>>()
  private rehydrateActive = 0
  private readonly rehydrateWaiters: Array<() => void> = []

  /**
   * `media.fetch{media_id}`: re-upload a file we know about. False when we do not have it. A second ask for a file that is
   * already going up joins the first (a Retry tap must not start another 50 MB PUT), and at most
   * `MAX_CONCURRENT_REHYDRATES` run at once, so a thread of old attachments is read one or two at a time, not all together.
   */
  rehydrate(mediaId: string): Promise<boolean> {
    const running = this.rehydrating.get(mediaId)
    if (running) return running
    const p = (async () => {
      if (this.rehydrateActive >= MAX_CONCURRENT_REHYDRATES)
        await new Promise<void>((resolve) => this.rehydrateWaiters.push(resolve))
      else this.rehydrateActive++
      try {
        return await this.rehydrateNow(mediaId)
      } finally {
        const next = this.rehydrateWaiters.shift()
        if (next) next()
        else this.rehydrateActive--
      }
    })().finally(() => this.rehydrating.delete(mediaId))
    this.rehydrating.set(mediaId, p)
    return p
  }

  private async rehydrateNow(mediaId: string): Promise<boolean> {
    if (!/^md_[0-9A-HJKMNP-TV-Z]{26}$/.test(mediaId)) return false
    const meta = join(this.p.media, `${mediaId}.json`)
    // both reads go through the safe handle (no link followed, O_NONBLOCK): a named pipe swapped in for the uploaded file
    // or the sidecar must answer false, not freeze the bridge
    const rawMeta = readRegularFile(meta, 64 * 1024)
    if (!rawMeta) return false
    const { path, ref, headers } = JSON.parse(rawMeta.toString('utf8')) as {
      path: string
      ref: AttachmentRefT
      /** MCP apps: the `X-Talos-App-Csp` the page was first uploaded with; a re-upload without it would 404 at the relay. */
      headers?: Record<string, string>
    }
    const data = readRegularFile(path, MAX_FILE_BYTES)
    if (!data) return false
    const bytes = new Uint8Array(data)
    if (sha256Hex(bytes) !== ref.sha256) return false
    await this.http.putMedia(mediaId, bytes, ref.sha256, ref.mime, ref.name, headers ?? {})
    return true
  }

  /**
   * True when this Mac still holds the bytes of an upload it made (the sidecar is there and the file it names is not empty).
   * Kept audio is pruned after a week, so a cached answer must check before it is trusted.
   */
  hasKept(mediaId: string): boolean {
    if (!/^md_[0-9A-HJKMNP-TV-Z]{26}$/.test(mediaId)) return false
    const rawMeta = readRegularFile(join(this.p.media, `${mediaId}.json`), 64 * 1024)
    if (!rawMeta) return false
    try {
      const { path } = JSON.parse(rawMeta.toString('utf8')) as { path?: unknown }
      return typeof path === 'string' && statSync(path).size > 0
    } catch {
      return false
    }
  }

  /** Saves bytes we produced (e.g. TTS) and uploads them. */
  async uploadBytes(
    bytes: Uint8Array,
    name: string,
    mime: string,
    role: 'attachment' | 'voice_reply',
  ): Promise<AttachmentRefT> {
    const id = newId('md')
    const path = join(this.p.media, `${id}${extname(name)}`)
    writeFileSync(path, bytes, { mode: 0o600 })
    return this.upload(path, { role, name, mime })
  }
}
