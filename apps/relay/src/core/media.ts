// Media: encrypted at rest on the volume, MIME sniffed from magic bytes, served with the sandbox headers (spec 5.4).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AppCspT, type AttachmentRefT, newId, sha256Hex, storedMime } from '@talos-app/protocol'
import type { Clock, CryptoService, MediaStore } from '../services.ts'
import { kindForMime, sniffMime } from './sniff.ts'
import type { MediaRow, Store } from './store.ts'

export type SaveArgs = {
  id?: string
  bytes: Uint8Array
  claimedMime?: string
  /** The owner's declared real type for a text file (already checked against the allowlist); kept when the bytes are text. */
  declaredType?: string | null
  name: string
  durationMs?: number | undefined
  origin: 'app' | 'bridge'
  /** The CSP the owner approved for an MCP app page (AP2). Only the bridge's PUT sets it; a re-upload without it clears it. */
  appCsp?: AppCspT | undefined
}

export class FileMediaStore implements MediaStore {
  private dir: string
  constructor(
    dataDir: string,
    private store: Store,
    private crypto: CryptoService,
    private clock: Clock,
  ) {
    this.dir = join(dataDir, 'media')
    mkdirSync(this.dir, { recursive: true })
  }

  private path(id: string) {
    return join(this.dir, `${id}.bin`)
  }

  /** Stores bytes under `id` (or a new one). The stored MIME is the sniffed one, never the claimed one. */
  save(args: SaveArgs): { ref: AttachmentRefT; row: MediaRow } {
    const id = args.id ?? newId('md')
    const mime = storedMime(args.declaredType ?? null, sniffMime(args.bytes, args.claimedMime))
    if (args.appCsp && mime !== 'text/html') throw new Error('an app CSP goes only with an HTML page')
    const sha256 = sha256Hex(args.bytes)
    const name = cleanName(args.name)
    const blob = this.crypto.encrypt(args.bytes, `media:${id}`)
    const tmp = `${this.path(id)}.tmp`
    writeFileSync(tmp, blob)
    renameSync(tmp, this.path(id))
    const kind = kindForMime(mime)
    this.store.putMediaRow({
      media_id: id,
      mime,
      name,
      size: args.bytes.length,
      sha256,
      kind,
      origin: args.origin,
      duration_ms: args.durationMs ?? null,
      app_csp: args.appCsp ?? null,
    })
    const row = this.store.getMediaRow(id) as MediaRow
    const ref: AttachmentRefT = {
      media_id: id,
      kind,
      role: 'attachment',
      mime,
      name,
      size: args.bytes.length,
      sha256,
      ...(args.durationMs ? { duration_ms: args.durationMs } : {}),
    }
    return { ref, row }
  }

  async put(args: { bytes: Uint8Array; mime: string; name: string; durationMs?: number }): Promise<AttachmentRefT> {
    return this.save({
      bytes: args.bytes,
      claimedMime: args.mime,
      name: args.name,
      durationMs: args.durationMs,
      origin: 'bridge',
    }).ref
  }

  read(id: string): { bytes: Uint8Array; row: MediaRow } | null {
    const row = this.store.getMediaRow(id)
    if (!row || row.evicted) return null
    try {
      const bytes = this.crypto.decrypt(readFileSync(this.path(id)), `media:${id}`)
      return { bytes, row }
    } catch {
      return null
    }
  }

  async get(id: string) {
    const r = this.read(id)
    return r ? { bytes: r.bytes, mime: r.row.mime, name: r.row.name, sha256: r.row.sha256 } : null
  }

  async remove(id: string): Promise<void> {
    rmSync(this.path(id), { force: true })
    this.store.db.prepare('update core_media set evicted = 1 where media_id = ?').run(id)
  }

  /** Called by the sweeper for rows it just marked evicted. */
  removeFiles(ids: string[]): void {
    for (const id of ids) rmSync(this.path(id), { force: true })
  }

  age(): number {
    return this.clock.now()
  }
}

/** A file name safe to put in a header: no path, no control characters, at most 200 chars. */
export function cleanName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = [...base]
    .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f && ch !== '"')
    .join('')
    .trim()
    .slice(0, 200)
  return cleaned || 'upload'
}

/** `Content-Disposition` value with an RFC 5987 filename. */
export function dispositionHeader(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** Parses one `Range: bytes=a-b` spec. null = ignore the header; 'unsatisfiable' = 416. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, a, b] = m as unknown as [string, string, string]
  if (a === '' && b === '') return null
  let start: number
  let end: number
  if (a === '') {
    const suffix = Number(b)
    if (suffix === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(a)
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}
