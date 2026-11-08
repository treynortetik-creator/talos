// Tripwire for the two files whose contents decide who is trusted: devices.json and the security fields of config.json.
// The bridge remembers a hash of each in <home>/tripwire.json. A write the app makes itself (the CLI or the bridge) goes
// through `recordedWrite`, which tells the bridge first and records the new hash after. A change nobody recorded was made
// from outside the app, and the bridge posts one line in the Inbox thread. It then takes the new state as the baseline, so
// it speaks once per change; it does not undo anything.
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { jcs } from '@talos-app/protocol'
import { writeJsonAtomic } from './fsutil.ts'

export type WatchedFile = 'config' | 'devices'
const NAME: Record<WatchedFile, string> = { config: 'config.json', devices: 'devices.json' }
const MARKER_FRESH_MS = 30_000
const EVERY_MS = 30_000

/** What the bridge remembers about one file: the hash, the last hashes it passed through, and one hash per top-level field. */
type Meta = Record<string, { n: string; r: boolean }>
type Entry = { h: string; hist: string[]; fields: Record<string, string>; meta?: Meta }
type Baseline = Partial<Record<WatchedFile, Entry>>
const HISTORY = 16

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable'
  }
}

/**
 * The fields that matter in a watched file, each hashed on its own, and the hash of all of them. An edit to anything else
 * (rev, thread names) changes nothing here. The field names are what an alert may say; the values never are.
 */
export function securityState(
  home: string,
  which: WatchedFile,
): { h: string; fields: Record<string, string>; meta?: Meta } {
  const raw = readJson(join(home, NAME[which])) as Record<string, unknown> | string
  let fields: Record<string, string>
  let meta: Meta | undefined
  if (typeof raw === 'string' || raw === null || typeof raw !== 'object') fields = { '(file)': sha(String(raw)) }
  else if (which === 'devices') {
    const list = Array.isArray(raw.devices) ? (raw.devices as Record<string, unknown>[]) : []
    fields = {}
    meta = {}
    for (const d of list) {
      fields[`devices:${String(d.id)}`] = sha(jcs({ key: d.pubkey_jwk ?? null, revoked: d.revoked_at ?? null }))
      // labels and the revoked flag are kept to word a notice; they are not part of the hash, and no key is kept
      meta[String(d.id)] = { n: label(d.name), r: Boolean(d.revoked_at) }
    }
  } else {
    const work = (raw.work ?? {}) as Record<string, unknown>
    fields = {
      trust_mode: sha(jcs(raw.trust_mode ?? null)),
      // `mirror` left the schema with the mirror feature; it stays hashed so the baseline stored before the upgrade still matches
      mirror: sha(jcs(raw.mirror ?? null)),
      permission_relay: sha(jcs(raw.permission_relay ?? null)),
      dedicated: sha(jcs(raw.dedicated ?? null)),
      work: sha(jcs(work.enabled ?? null)),
    }
  }
  const keys = Object.keys(fields).sort()
  return { h: sha(jcs(keys.map((k) => [k, fields[k]]))), fields, ...(meta ? { meta } : {}) }
}

/** A device label is text the device chose: one short printable line, no quote that could end the notice's own quoting. */
function label(name: unknown): string {
  const t = String(name ?? '')
    .replace(/[^\p{L}\p{N} ._()-]/gu, '')
    .trim()
    .slice(0, 40)
  return t || '(no name)'
}

const baselineFile = (home: string) => join(home, 'tripwire.json')
const markerFile = (home: string) => join(home, 'tripwire.writing')

const isEntry = (e: unknown): e is Entry => {
  const x = e as Entry | null
  return (
    !!x &&
    typeof x === 'object' &&
    typeof x.h === 'string' &&
    x.h.length > 0 &&
    Array.isArray(x.hist) &&
    typeof x.fields === 'object' &&
    x.fields !== null
  )
}

/** The baseline on disk. A missing, unreadable or empty file, or a key that is not whole, reads as no entry. */
function readBaseline(home: string): Baseline {
  const b = readJson(baselineFile(home))
  const out: Baseline = {}
  if (b && typeof b === 'object') {
    for (const which of ['config', 'devices'] as const) {
      const e = (b as Record<string, unknown>)[which]
      if (isEntry(e)) out[which] = e
    }
  }
  return out
}

/**
 * Runs a write the app makes itself. The marker goes first, so a check that runs in the middle waits; the new state is
 * recorded after (with the hashes it came through, so the bridge can tell a recorded change from a rewritten baseline),
 * so a check that runs later sees nothing unusual. `file` is the path being written.
 */
export function recordedWrite<T>(file: string, which: WatchedFile, write: () => T): T {
  const home = dirname(file)
  try {
    writeFileSync(markerFile(home), String(Date.now()), { mode: 0o600 })
  } catch {
    return write() // no home folder to record in (a test path); the write itself decides what to do
  }
  try {
    return write()
  } finally {
    try {
      const before = readBaseline(home)
      const prior = before[which]
      const now = securityState(home, which)
      const hist = prior && prior.h !== now.h ? [...prior.hist, prior.h].slice(-HISTORY) : (prior?.hist ?? [])
      writeJsonAtomic(
        baselineFile(home),
        { ...before, [which]: { h: now.h, hist, fields: now.fields, ...(now.meta ? { meta: now.meta } : {}) } },
        0o600,
      )
    } finally {
      rmSync(markerFile(home), { force: true })
    }
  }
}

const entryOf = (cur: ReturnType<typeof securityState>, hist: string[]): Entry => ({
  h: cur.h,
  hist,
  fields: cur.fields,
  ...(cur.meta ? { meta: cur.meta } : {}),
})

const WHAT_TO_DO = "If that wasn't you, revoke it in Settings → Devices."

/** One notice per device added, removed, revoked or given a new key. Label and id only, never a key. */
function deviceNotices(was: Entry, now: Entry): string[] {
  const out: string[] = []
  const ids = [...new Set([...Object.keys(was.fields), ...Object.keys(now.fields)])].sort()
  for (const k of ids) {
    if (was.fields[k] === now.fields[k]) continue
    const id = k.replace(/^devices:/, '')
    const nm = now.meta?.[id] ?? was.meta?.[id]
    const who = `'${nm?.n ?? '(unknown)'}' (${id})`
    if (was.fields[k] === undefined) out.push(`A device was added: ${who}. ${WHAT_TO_DO}`)
    else if (now.fields[k] === undefined) out.push(`A device was removed: ${who}. ${WHAT_TO_DO}`)
    else if (!was.meta?.[id]?.r && now.meta?.[id]?.r) out.push(`A device was revoked: ${who}.`)
    else out.push(`A device's key was changed: ${who}. ${WHAT_TO_DO}`)
  }
  return out
}

const RESET = 'tripwire state was reset outside the app'

/** The top-level fields that differ, by name only. For devices, how many entries were added, removed or changed. */
function describeChange(which: WatchedFile, was: Record<string, string>, now: Record<string, string>): string {
  const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()
  const diff = keys.filter((k) => was[k] !== now[k])
  if (diff.includes('(file)')) return 'the file is missing or unreadable'
  if (which === 'devices') {
    const added = diff.filter((k) => was[k] === undefined).length
    const removed = diff.filter((k) => now[k] === undefined).length
    const changed = diff.length - added - removed
    const parts = [
      added ? `${added} added` : '',
      removed ? `${removed} removed` : '',
      changed ? `${changed} changed (key or revoked)` : '',
    ].filter(Boolean)
    return `field devices: ${parts.join(', ')}`
  }
  return `fields: ${diff.join(', ')}`
}

type Timers = {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: unknown): void
}

export class Tripwire {
  private timer: unknown = null
  /** What this bridge last knew, for its whole life: a baseline rewritten on disk is compared against it. */
  private mem: Baseline | undefined
  /** How many checks in a row have found a marker. A real write lasts milliseconds, so a marker that stays is not one. */
  private markerRuns = 0

  constructor(
    private readonly d: {
      home: string
      now: () => number
      /** One line in the Inbox thread. */
      alert: (text: string) => Promise<void>
      clock?: Timers
    },
  ) {}

  /** Only a marker dated in the last 30 seconds (and not in the future) means the app is writing right now. */
  private appIsWriting(): boolean {
    const raw = readJson(markerFile(this.d.home))
    const t = typeof raw === 'number' ? raw : Number.NaN
    const age = this.d.now() - t
    const fresh = Number.isFinite(t) && age >= 0 && age < MARKER_FRESH_MS
    this.markerRuns = fresh ? this.markerRuns + 1 : 0
    return fresh && this.markerRuns === 1
  }

  async check(): Promise<void> {
    const { home } = this.d
    if (this.appIsWriting()) return // the app is writing right now; look again next time
    const disk = readBaseline(home)
    const known = this.mem ?? disk
    const alerts: string[] = []
    const next: Baseline = {}
    let rewrite = false
    for (const which of ['config', 'devices'] as const) {
      const cur = securityState(home, which)
      const was = known[which]
      const onDisk = disk[which]
      if (!was) {
        next[which] = entryOf(cur, []) // first sight: take the baseline, say nothing
        rewrite = true
        continue
      }
      if (!onDisk) {
        alerts.push(`${RESET} (the record of ${NAME[which]} is gone or damaged).`)
        rewrite = true
      }
      if (was.h !== cur.h) {
        // a change the CLI or bridge recorded left a baseline that agrees with the file and lists what it came from
        if (onDisk && onDisk.h === cur.h && onDisk.hist.includes(was.h)) {
          next[which] = onDisk
          // the app wrote this itself, but a script on this Mac can call the same store: every device change is told
          if (which === 'devices') alerts.push(...deviceNotices(was, onDisk))
        } else {
          alerts.push(
            `${NAME[which]} was changed outside Talos (${describeChange(which, was.fields, cur.fields)}). If you did not do that, check your devices and settings now: run talos-app devices in Terminal, and look at the trust setting.`,
          )
          next[which] = entryOf(cur, [...was.hist, was.h].slice(-HISTORY))
          rewrite = true
        }
      } else if (onDisk && onDisk.h !== was.h) {
        alerts.push(`${RESET} (the record of ${NAME[which]} was rewritten).`)
        next[which] = entryOf(cur, was.hist)
        rewrite = true
      } else {
        next[which] = onDisk ?? entryOf(cur, was.hist)
      }
    }
    this.mem = next
    if (rewrite) writeJsonAtomic(baselineFile(home), next, 0o600)
    for (const text of alerts) await this.d.alert(text)
  }

  start(): void {
    const clock = this.d.clock
    if (!clock) return
    const tick = () => {
      void this.check().catch(() => {})
      this.timer = clock.setTimeout(tick, EVERY_MS)
      ;(this.timer as { unref?: () => void } | null)?.unref?.()
    }
    tick()
  }

  stop(): void {
    if (this.timer) this.d.clock?.clearTimeout(this.timer)
    this.timer = null
  }
}
