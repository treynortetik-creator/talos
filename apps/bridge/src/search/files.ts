// Text attachment contents in the `files` column (docs/V2-FEATURES.md V3.1, P1). The LIVE bridge only, 20 files per 5 s
// tick, never on the inbound queue. Only files in the bridge's own media folder are read: the sidecar `<media_id>.json`
// names a path, and a path that resolves outside that folder (an agent upload from elsewhere on the Mac) is skipped.
import { closeSync, constants, existsSync, fstatSync, readSync, realpathSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import type { AttachmentRefT, MessageT } from '@talos-app/protocol'
import type { HistoryStore } from '../history-store.ts'
import { openResolvedNoFollow, readRegularFile } from '../safe-open.ts'
import { clean } from './columns.ts'
import { KV_HWM } from './schema.ts'

export const FILES_PER_TICK = 20
export const FILE_TICK_MS = 5000
export const MAX_FILE_BYTES = 1024 * 1024
export const READ_BYTES = 200 * 1024
export const KV_FILES_HWM = 'search_files_hwm'
const DISCOVER_BATCH = 200
const EXTS = new Set(['.md', '.txt', '.csv', '.log', '.json', '.yaml', '.yml'])

export function isTextAttachment(a: Pick<AttachmentRefT, 'role' | 'kind' | 'mime' | 'name' | 'size'>): boolean {
  if (!a || typeof a !== 'object') return false
  if (a.role !== 'attachment' || a.kind === 'voice_note') return false
  if (a.size > MAX_FILE_BYTES) return false
  return a.mime.startsWith('text/') || a.mime === 'application/json' || EXTS.has(extname(a.name).toLowerCase())
}

export class FileIndexer {
  constructor(
    private readonly store: HistoryStore,
    private readonly mediaDir: string,
  ) {}

  /** Finds new text attachments (by message order) and indexes up to 20 pending ones. Returns true while more is pending. */
  tick(): boolean {
    this.discover()
    const db = this.store.db
    const rows = db
      .query("SELECT media_id, ord FROM fts_files WHERE state = 'pending' ORDER BY ord LIMIT ?")
      .all(FILES_PER_TICK) as Array<{ media_id: string; ord: number }>
    const mark = db.query('UPDATE fts_files SET state = ? WHERE media_id = ?')
    for (const r of rows) {
      const hwm = Number(this.store.kvGet(KV_HWM) ?? 0) || 0
      const row = db.query('SELECT 1 FROM msg_fts WHERE rowid = ?').get(r.ord)
      if (!row) {
        // the message itself is not indexed yet: wait, unless it is gone for good
        if (r.ord <= hwm) mark.run('skipped', r.media_id)
        continue
      }
      const text = this.read(r.media_id)
      if (text === null) {
        mark.run('skipped', r.media_id)
        continue
      }
      db.transaction(() => {
        db.query(
          "UPDATE msg_fts SET files = CASE WHEN files = '' THEN ? ELSE files || char(10) || ? END WHERE rowid = ?",
        ).run(text, text, r.ord)
        mark.run('done', r.media_id)
      })()
    }
    const left = db.query("SELECT 1 FROM fts_files WHERE state = 'pending' LIMIT 1").get()
    return left !== null
  }

  private discover() {
    const db = this.store.db
    const from = Number(this.store.kvGet(KV_FILES_HWM) ?? 0) || 0
    const rows = db
      .query('SELECT ord, json FROM messages WHERE ord > ? ORDER BY ord LIMIT ?')
      .all(from, DISCOVER_BATCH) as Array<{ ord: number; json: string }>
    if (!rows.length) return
    const ins = db.query("INSERT OR IGNORE INTO fts_files (media_id, ord, state) VALUES (?, ?, 'pending')")
    db.transaction(() => {
      for (const r of rows) {
        let msg: MessageT
        try {
          msg = JSON.parse(r.json) as MessageT
        } catch {
          continue
        }
        for (const a of msg.attachments ?? []) if (isTextAttachment(a)) ins.run(a.media_id, r.ord)
      }
    })()
    this.store.kvSet(KV_FILES_HWM, String((rows[rows.length - 1] as { ord: number }).ord))
  }

  /** The first 200 KB as text, or null when the file is missing, outside the media folder, too big or binary. */
  private read(mediaId: string): string | null {
    try {
      if (!/^md_[0-9A-HJKMNP-TV-Z]{26}$/.test(mediaId)) return null
      const meta = join(this.mediaDir, `${mediaId}.json`)
      // read through the safe handle: a named pipe as the sidecar must not freeze the tick
      const raw = readRegularFile(meta, 64 * 1024)
      if (!raw) return null
      const { path } = JSON.parse(raw.toString('utf8')) as { path?: string }
      if (!path || !existsSync(path)) return null
      const real = realpathSync(path)
      const root = realpathSync(this.mediaDir) + sep
      if (!real.startsWith(root)) return null
      // O_NONBLOCK: a named pipe in the media folder must not freeze the bridge waiting for a writer (the fstat refuses it)
      const fd = openResolvedNoFollow(real, constants.O_NONBLOCK)
      try {
        const st = fstatSync(fd)
        // one name only: a hard link would carry a file from outside the media folder in under a media name
        if (!st.isFile() || st.nlink !== 1 || st.size > MAX_FILE_BYTES) return null
        const buf = Buffer.alloc(Math.min(st.size, READ_BYTES))
        const n = readSync(fd, buf, 0, buf.length, 0)
        const head = buf.subarray(0, n)
        if (head.subarray(0, 4096).includes(0)) return null // binary
        return clean(head.toString('utf8'))
      } finally {
        closeSync(fd)
      }
    } catch {
      return null
    }
  }
}
