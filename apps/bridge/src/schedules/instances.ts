// Which bridge instances are gone (N11). The orphan sweep may close a session claim only when its owner is provably gone.
//
// Each bridge writes `<home>/instances/<instance>.json` when its schedule service starts and stamps `stopped_at` on a
// clean stop. A claim's owner is:
//   - gone:    a record says it stopped, or its pid is not running, or the pid now belongs to a different process;
//   - alive:   a record whose pid is running (and, when `ps` can tell, started at the recorded time);
//   - unknown: no readable record (another agent folder, an older bridge, a claim written before this existed), or a
//              record written on another host (its pid means nothing here).
// Only `gone` is closed. Unknown is left to Chronos's stale_claim_min.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, readJsonFile, removeFile, writeJsonAtomic } from '../fsutil.ts'
import { psInfo } from '../lifecycle.ts'
import { hostLabel } from './discovery.ts'

export type InstanceRecord = { instance: string; pid: number; started_at: string; host?: string; stopped_at?: string }
export type OwnerState = 'alive' | 'gone' | 'unknown'

const PRUNE_MS = 14 * 24 * 3600_000
const SAFE = /^[A-Za-z0-9_-]{1,80}$/

export type InstanceProbe = {
  /** Is this pid running? Default `process.kill(pid, 0)`; EPERM counts as running. */
  running?: (pid: number) => boolean
  /** `ps` start time of a pid, undefined when it cannot be told. */
  startedAt?: (pid: number) => string | undefined
  /** This machine's label; a record from another host is `unknown`. */
  host?: () => string
}

const defaultRunning = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class InstanceRegistry {
  constructor(
    private readonly dir: string,
    private readonly probe: InstanceProbe = {},
  ) {}

  private file(instance: string) {
    return join(this.dir, `${instance}.json`)
  }

  /** Records this process as the owner of `instance`. Never throws: a registry that cannot be written only makes this instance `unknown`. */
  register(instance: string, pid = process.pid): void {
    if (!SAFE.test(instance)) return
    try {
      ensureDir(this.dir)
      const started_at = (this.probe.startedAt ?? ((p) => psInfo(p)?.lstart))(pid) ?? ''
      const host = (this.probe.host ?? hostLabel)()
      writeJsonAtomic(this.file(instance), { instance, pid, started_at, host } satisfies InstanceRecord)
    } catch {
      // unwritable: this instance reads as unknown to others, which is the safe side
    }
  }

  /** A clean stop: whatever this instance still holds is no longer served. */
  markStopped(instance: string, now: number): void {
    if (!SAFE.test(instance)) return
    try {
      const rec = readJsonFile<InstanceRecord>(this.file(instance))
      if (rec) writeJsonAtomic(this.file(instance), { ...rec, stopped_at: new Date(now).toISOString() })
    } catch {
      // best effort
    }
  }

  stateOf(instance: string): OwnerState {
    if (!SAFE.test(instance)) return 'unknown'
    let rec: InstanceRecord | undefined
    try {
      rec = readJsonFile<InstanceRecord>(this.file(instance))
    } catch {
      return 'unknown'
    }
    if (!rec || rec.instance !== instance || typeof rec.pid !== 'number' || !Number.isInteger(rec.pid) || rec.pid <= 0)
      return 'unknown'
    // a record without a host predates this field: same machine is assumed
    if (typeof rec.host === 'string' && rec.host !== (this.probe.host ?? hostLabel)()) return 'unknown'
    if (typeof rec.stopped_at === 'string') return 'gone'
    if (!(this.probe.running ?? defaultRunning)(rec.pid)) return 'gone'
    const now = (this.probe.startedAt ?? ((p) => psInfo(p)?.lstart))(rec.pid)
    // the pid is running; a different start time means the number was recycled for another process
    if (rec.started_at && now && now !== rec.started_at) return 'gone'
    return 'alive'
  }

  /** Drops records of gone instances older than two weeks. */
  prune(now: number): void {
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith('.json')) continue
        const instance = f.slice(0, -5)
        const p = join(this.dir, f)
        if (now - statSync(p).mtimeMs > PRUNE_MS && this.stateOf(instance) === 'gone') removeFile(p)
      }
    } catch {
      // no directory yet
    }
  }
}
