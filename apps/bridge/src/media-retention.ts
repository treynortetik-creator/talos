// Downloaded attachments (`md_*` in the media folder) kept only as long as the owner chose (config `media_keep_days`; null, the
// default, keeps them for good). Bug hunt core #19: nothing ever removed them, and a Mac ran out of disk.
//
// - A file still in use is never removed, whatever the setting: one named by a send not yet taken (the outbox), a card
//   waiting on the owner, an attachment retry, a thread route not yet read, an app page, or a sidecar of any of those.
// - Nothing is removed in the hour after the setting changes, so a mis-tap can be put back. When it changes, the owner is
//   told in the default thread what it will remove (a dry run: files, bytes, the oldest).
// - A removed file's sidecar stays, marked `removed`, so the app is told "removed after N days" instead of an error.
// - Every sweep that removes something writes one log line: count, bytes, oldest date.
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { MEDIA_KEEP_CHOICES } from '@talos-app/protocol'
import type { BridgeContext } from './context.ts'
import { postSystemNotice } from './context.ts'
import { writeFileAtomic } from './fsutil.ts'
import { say } from './owner-words.ts'
import { realFileSync } from './real-file.ts'

const DAY_MS = 86_400_000
/** How long after a change of the setting nothing is removed. */
export const MEDIA_HOLD_MS = 3_600_000
const SEEN_KEY = 'media_keep_seen'
const STATS_KEY = 'media_by_age'
const STATS_EVERY_MS = 10 * 60_000
/** How often a sweep runs once the hold is over (and once right when it ends). */
const SWEEP_EVERY_MS = 3_600_000
/**
 * After the first sweep that followed a change (the one the owner was told about), a single sweep that would remove more
 * than this many files AND this share of every download is refused: nothing legitimate removes that much at once on a
 * later hour, and a clock that jumped years ahead would.
 */
const SURGE_FILES = 100
const SURGE_SHARE = 0.2
const MEDIA_ID = /md_[0-9A-HJKMNP-TV-Z]{26}/g
const FILE = /^(md_[0-9A-HJKMNP-TV-Z]{26})(\.[A-Za-z0-9]{1,10})?$/

export type SweepResult = { files: number; bytes: number; oldest: number | null }
type Seen = { days: number | null; changed_at: number; swept?: boolean }

/** The media ids something still needs (see the header). Read fresh each time; never trusted from a cache. */
export function liveMediaIds(ctx: BridgeContext): Set<string> {
  const ids = new Set<string>()
  const scan = (text: unknown) => {
    if (typeof text === 'string') for (const m of text.matchAll(MEDIA_ID)) ids.add(m[0])
  }
  const db = ctx.store.db
  const rows = (sql: string): Array<Record<string, unknown>> => {
    try {
      return db.query(sql).all() as Array<Record<string, unknown>>
    } catch {
      return [] // a table this build's history does not have (a worker store not yet made)
    }
  }
  for (const r of rows('SELECT json FROM outbox')) scan(r.json)
  for (const r of rows("SELECT binding_json FROM cards WHERE state = 'pending'")) scan(r.binding_json)
  for (const r of rows('SELECT notification_json FROM worker_routes')) scan(r.notification_json)
  for (const prefix of ['attachment_retry:', 'app_page:'])
    for (const k of ctx.store.kvKeys(prefix)) {
      scan(k)
      scan(ctx.store.kvGet(k))
    }
  return ids
}

type Sidecar = { id: string; file: string; path?: string; removed?: { at: number; after_days: number } }

function sidecars(mediaDir: string): Sidecar[] {
  const out: Sidecar[] = []
  let names: string[]
  try {
    names = readdirSync(mediaDir)
  } catch {
    return out
  }
  for (const n of names) {
    const m = /^(md_[0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(n)
    if (!m) continue
    try {
      const j = JSON.parse(readFileSync(join(mediaDir, n), 'utf8')) as { path?: unknown; removed?: Sidecar['removed'] }
      out.push({
        id: m[1] as string,
        file: join(mediaDir, n),
        ...(typeof j.path === 'string' ? { path: j.path } : {}),
        ...(j.removed ? { removed: j.removed } : {}),
      })
    } catch {}
  }
  return out
}

type Candidate = { full: string; mtime: number; size: number }

// a file's real path, walked: its name decides which files are kept, so never another hard link's (real-file.ts)
const realOr = (p: string): string => {
  try {
    return realFileSync(p)
  } catch {
    return p
  }
}

/** How many downloads the folder holds, in use or not (the base of the surge check). */
function downloadCount(mediaDir: string): number {
  try {
    return readdirSync(mediaDir).filter((n) => FILE.test(n) && !n.endsWith('.json')).length
  } catch {
    return 0
  }
}

/** The downloaded files nothing needs, with their age and size, in one pass over the folder. */
function candidates(ctx: BridgeContext, mediaDir: string, cars: Sidecar[]): Candidate[] {
  let names: string[]
  try {
    names = readdirSync(mediaDir)
  } catch {
    return []
  }
  const live = liveMediaIds(ctx)
  // a file a live sidecar names (a re-sent download, an upload copy) is in use too
  const protectedFiles = new Set(
    cars.filter((c) => live.has(c.id) && c.path).map((c) => basename(realOr(c.path as string))),
  )
  const out: Candidate[] = []
  for (const n of names) {
    const m = FILE.exec(n)
    if (!m || n.endsWith('.json')) continue
    if (live.has(m[1] as string) || protectedFiles.has(n)) continue
    const full = join(mediaDir, n)
    try {
      const st = statSync(full)
      if (st.isFile()) out.push({ full, mtime: st.mtimeMs, size: st.size })
    } catch {}
  }
  return out
}

const tally = (list: Candidate[]): SweepResult => ({
  files: list.length,
  bytes: list.reduce((n, c) => n + c.size, 0),
  oldest: list.length ? Math.min(...list.map((c) => c.mtime)) : null,
})

/**
 * The downloaded files older than `days` that nothing needs: what a sweep with that setting removes. With `apply`, they are
 * removed and every sidecar that names one is marked `removed`.
 */
export function sweepMedia(
  ctx: BridgeContext,
  mediaDir: string,
  days: number,
  now: number,
  apply: boolean,
): SweepResult {
  const cars = sidecars(mediaDir)
  const old = candidates(ctx, mediaDir, cars).filter((c) => c.mtime < now - days * DAY_MS)
  if (!apply) return tally(old)
  const done: Candidate[] = []
  for (const c of old) {
    try {
      unlinkSync(c.full)
      done.push(c)
    } catch {} // raced with another process
  }
  // matched by the real path: a sidecar may name the file through a link to the media folder (upload() stores realpath)
  const gone = new Set(done.map((c) => realOr(c.full)))
  for (const car of cars) {
    if (!car.path || !gone.has(realOr(car.path)) || car.removed) continue
    try {
      const j = JSON.parse(readFileSync(car.file, 'utf8')) as Record<string, unknown>
      writeFileAtomic(car.file, JSON.stringify({ ...j, removed: { at: now, after_days: days } }), 0o600)
    } catch {}
  }
  return tally(done)
}

/** What each retention choice would remove now, in one pass (the health beat's media_by_age). */
export function mediaAgeStats(ctx: BridgeContext, mediaDir: string, now: number, choices: readonly number[]) {
  const list = candidates(ctx, mediaDir, sidecars(mediaDir))
  return choices.map((d) => {
    const t = tally(list.filter((c) => c.mtime < now - d * DAY_MS))
    return { days: d, files: t.files, bytes: t.bytes }
  })
}

const gb = (bytes: number) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : bytes >= 1e6
      ? `${Math.round(bytes / 1e6)} MB`
      : `${Math.max(1, Math.round(bytes / 1e3))} KB`
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** The setting's state, the hold and the sweep. One per live bridge; `tick` runs on every poll and is cheap when idle. */
/**
 * For the agent's change line when the owner asked it to shorten how long attachments are kept: what the hour's hold will
 * remove, and that setting it back before then keeps them (the hold restarts on every change; null removes nothing). Null when
 * nothing is old enough. `until` is the end of the hold, as the owner reads the time.
 */
export function shorteningNote(ctx: BridgeContext, days: number, now: number, until: string): string | null {
  const r = sweepMedia(ctx, ctx.paths.media, days, now, false)
  if (r.files === 0) return null
  return `In an hour (${until}), about ${r.files} file${r.files === 1 ? '' : 's'} (${gb(r.bytes)}, the oldest from ${day(r.oldest as number)}) will be removed and can't be downloaded again; undo before then and nothing is removed.`
}

export class MediaRetention {
  private statsAt = 0
  private sweptAt = 0

  constructor(
    private readonly ctx: BridgeContext,
    private readonly mediaDir: string,
  ) {}

  private seen(): Seen | undefined {
    try {
      const v = JSON.parse(this.ctx.store.kvGet(SEEN_KEY) ?? 'null') as Seen | null
      return v && (v.days === null || typeof v.days === 'number') && typeof v.changed_at === 'number' ? v : undefined
    } catch {
      return undefined
    }
  }

  tick(): void {
    const now = this.ctx.clock.now()
    const days = this.ctx.config.config.media_keep_days ?? null
    const seen = this.seen()
    if (!seen || seen.days !== days) {
      // first look, or a change: start the hour's hold, and say what it would remove (only when it would remove something)
      this.ctx.store.kvSet(SEEN_KEY, JSON.stringify({ days, changed_at: now } satisfies Seen))
      // a value already set on the first look (set while the bridge was down, or before this build) is told too
      if (days !== null) this.announce(days, now)
      this.statsAt = 0
      this.sweptAt = 0
      return
    }
    if (now - this.statsAt > STATS_EVERY_MS) this.refreshStats(now)
    if (days === null || now - seen.changed_at < MEDIA_HOLD_MS) return
    if (this.sweptAt !== 0 && now - this.sweptAt < SWEEP_EVERY_MS) return
    this.sweptAt = now
    if (seen.swept) {
      const would = sweepMedia(this.ctx, this.mediaDir, days, now, false)
      const all = downloadCount(this.mediaDir)
      if (would.files > SURGE_FILES && would.files > all * SURGE_SHARE) {
        this.ctx.log.warn('media retention held: too much at once', { files: would.files, of: all, keep_days: days })
        if (!this.ctx.store.kvGet('media_keep_surge_told')) {
          this.ctx.store.kvSet('media_keep_surge_told', String(now))
          void postSystemNotice(
            this.ctx,
            `Attachments were not removed: an hourly cleanup would have removed ${would.files} of ${all} files at once, which usually means ${say({ mac: "this Mac's", linux: "this computer's" })} clock jumped. Check the date and time, then set the storage time again to go on.`,
          ).catch(() => {})
        }
        return
      }
    } else {
      this.ctx.store.kvSet(SEEN_KEY, JSON.stringify({ ...seen, swept: true } satisfies Seen))
      this.ctx.store.kvDelete('media_keep_surge_told')
    }
    const r = sweepMedia(this.ctx, this.mediaDir, days, now, true)
    if (r.files > 0) {
      this.ctx.log.info('media retention removed', {
        files: r.files,
        bytes: r.bytes,
        oldest: r.oldest === null ? null : day(r.oldest),
        keep_days: days,
      })
      this.statsAt = 0
    }
  }

  private announce(days: number, now: number): void {
    const r = sweepMedia(this.ctx, this.mediaDir, days, now, false)
    const text =
      r.files === 0
        ? say({
            mac: `Attachments are now kept on this Mac for ${days} days. Nothing is old enough to be removed yet.`,
            linux: `Attachments are now kept on this computer for ${days} days. Nothing is old enough to be removed yet.`,
          })
        : say({
            mac: `Attachments are now kept on this Mac for ${days} days: in an hour, about ${r.files} file${r.files === 1 ? '' : 's'} (${gb(r.bytes)}, the oldest from ${day(r.oldest as number)}) will be removed from this Mac. They can't be downloaded again. Change the setting back within the hour to keep them.`,
            linux: `Attachments are now kept on this computer for ${days} days: in an hour, about ${r.files} file${r.files === 1 ? '' : 's'} (${gb(r.bytes)}, the oldest from ${day(r.oldest as number)}) will be removed from this computer. They can't be downloaded again. Change the setting back within the hour to keep them.`,
          })
    void postSystemNotice(this.ctx, text).catch((e) =>
      this.ctx.log.warn('media retention notice not posted', { error: (e as Error).message }),
    )
  }

  private refreshStats(now: number): void {
    this.statsAt = now
    this.ctx.store.kvSet(STATS_KEY, JSON.stringify(mediaAgeStats(this.ctx, this.mediaDir, now, MEDIA_KEEP_CHOICES)))
  }
}

/** The counts the health beat carries (media_by_age), as the last tick left them; undefined before the first. */
export function mediaByAge(ctx: BridgeContext): Array<{ days: number; files: number; bytes: number }> | undefined {
  try {
    const v = JSON.parse(ctx.store.kvGet(STATS_KEY) ?? 'null') as unknown
    return Array.isArray(v) ? (v as Array<{ days: number; files: number; bytes: number }>) : undefined
  } catch {
    return undefined
  }
}
