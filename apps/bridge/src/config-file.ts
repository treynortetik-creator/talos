// config.json: load, validate, patch and write atomically (spec 1.2, 3.4). The Mac file is authoritative; every write
// bumps `rev` and the caller emits `config.sync`.

import { dirname, join } from 'node:path'
import {
  AgentConfig,
  type AgentConfigT,
  applyMergePatch,
  checkConfigPatch,
  clearArchivedSessions,
  DRIVING_MAX_MS,
  isInheritedName,
  jcs,
  phoneValueIssue,
  resolveThreadsPatch,
  sessionFieldsIssue,
  threadPatchIssue,
  validateAgentConfig,
} from '@talos-app/protocol'
import { saveConfigVersion } from './config-history.ts'
import { mtimeMs, readJsonFile, writeJsonAtomic } from './fsutil.ts'
import type { Logger } from './log.ts'
import { recordedWrite } from './tripwire.ts'
import { defaultWorkerRoots, optionCPatchIssue, type WorkerRoots } from './worker/patch-check.ts'

export type PatchResult =
  | { ok: true; config: AgentConfigT }
  | {
      ok: false
      code: 'config_field_forbidden' | 'config_conflict' | 'bad_frame' | 'stepup_required' | 'thread_session_refused'
      message: string
    }

export function parseConfig(value: unknown): { ok: true; config: AgentConfigT } | { ok: false; message: string } {
  const r = AgentConfig.safeParse(value)
  if (!r.success)
    return { ok: false, message: `config.json invalid at ${r.error.issues[0]?.path.join('.') || '(root)'}` }
  const issues = validateAgentConfig(r.data)
  if (issues.length) return { ok: false, message: issues[0] as string }
  return { ok: true, config: r.data }
}

/** A thread in `next` that is not in `cur` and whose id every object already has (`constructor`). Stored ones are left alone. */
export function newInheritedThread(cur: AgentConfigT, next: AgentConfigT): string | undefined {
  const had = new Set(cur.threads.map((t) => t.id))
  return next.threads.find((t) => !had.has(t.id) && isInheritedName(t.id))?.id
}
const inheritedMessage = (id: string) =>
  `thread id "${id}" is a name every object already has; pick another id (the slug of the name gets _thread added)`

export class ConfigFile {
  private current!: AgentConfigT
  private seenMtime = -1
  /** Canonical form of the last config the relay was told about. */
  private syncedKey = ''

  private readonly roots: WorkerRoots
  private readonly log: Pick<Logger, 'warn'> | undefined

  constructor(
    private readonly path: string,
    opts: { roots?: WorkerRoots; log?: Pick<Logger, 'warn'> } = {},
  ) {
    this.roots = opts.roots ?? defaultWorkerRoots(path)
    this.log = opts.log
  }

  /** Loads (throws a readable error when missing or invalid). */
  load(): AgentConfigT {
    const raw = readJsonFile(this.path)
    if (raw === undefined) throw new Error(`cannot read ${this.path}; run: talos-app init --relay-url <url>`)
    const r = parseConfig(raw)
    if (!r.ok) throw new Error(r.message)
    this.current = r.config
    this.seenMtime = mtimeMs(this.path)
    return this.current
  }

  get config(): AgentConfigT {
    if (!this.current) this.load()
    return this.current
  }

  threadIds(): string[] {
    return this.config.threads.filter((t) => !t.archived).map((t) => t.id)
  }

  thread(id: string) {
    return this.config.threads.find((t) => t.id === id)
  }

  /** True (and reloaded) when another process or the owner edited the file. A hand edit that leaves `rev` alone bumps it. */
  reloadIfChanged(): boolean {
    const m = mtimeMs(this.path)
    if (m === this.seenMtime) return false
    const before = this.current ? jcs(this.current) : ''
    const raw = readJsonFile(this.path)
    const r = raw === undefined ? undefined : parseConfig(raw)
    this.seenMtime = m
    if (!r?.ok) return false // keep the last good config; the owner is probably mid-edit
    if (jcs(r.config) === before) return false
    const prevRev = this.current ? this.current.rev : -1
    this.current = r.config
    if (this.current.rev <= prevRev) this.write({ ...this.current, rev: prevRev + 1 })
    return true
  }

  /**
   * Picks up another process's write, READ ONLY (a worker-mode process: the live bridge owns rev bumps and config.sync).
   * An unreadable file keeps the last good config.
   */
  refresh(): void {
    const m = mtimeMs(this.path)
    if (m === this.seenMtime) return
    const raw = readJsonFile(this.path)
    const r = raw === undefined ? undefined : parseConfig(raw)
    this.seenMtime = m
    if (r?.ok) this.current = r.config
  }

  markSynced(config: AgentConfigT) {
    this.syncedKey = jcs(config)
  }
  needsSync(): boolean {
    return jcs(this.config) !== this.syncedKey
  }

  /** Writes `next` with rev bumped. */
  update(mutate: (c: AgentConfigT) => AgentConfigT, opts: { setsTrustMode?: boolean } = {}): AgentConfigT {
    const base = this.config
    const next = mutate(structuredClone(base))
    const checked = parseConfig({ ...next, rev: base.rev + 1 })
    if (!checked.ok) throw new Error(checked.message)
    const inherited = newInheritedThread(base, checked.config)
    if (inherited) throw new Error(inheritedMessage(inherited))
    // archiving a thread (the agent's archive_thread) also turns its own session off (docs/OPTION-C.md 9.2)
    this.write(clearArchivedSessions(checked.config), opts.setsTrustMode === true)
    return this.current
  }

  /** `config.patch` from the app: allowlist, optimistic concurrency, schema + structure validation. */
  applyPatch(baseRev: number, patch: Record<string, unknown>, now: number = Date.now()): PatchResult {
    const check = checkConfigPatch(patch)
    if (!check.ok) return { ok: false, code: 'config_field_forbidden', message: `field not allowed: ${check.path}` }
    // Settings the phone may only turn off (the memory browser kill switch, docs/V2-FEATURES.md V5.1): `on` comes from the Mac.
    const offOnly = phoneValueIssue(patch)
    if (offOnly) return { ok: false, code: 'config_field_forbidden', message: offOnly }
    const cur = this.config
    if (baseRev !== cur.rev) return { ok: false, code: 'config_conflict', message: `config is at rev ${cur.rev}` }
    // Inside an existing thread, keys the app left out keep their value (an older app can't wipe color/topic).
    const effective = Array.isArray(patch.threads)
      ? { ...patch, threads: resolveThreadsPatch(cur.threads, patch.threads) }
      : patch
    const merged = applyMergePatch(cur, effective) as Record<string, unknown>
    clampDriving(merged, now)
    // the schema is tolerant when reading (docs/OPTION-C.md "Compatibility"); what the owner writes is checked strictly
    const fields = sessionFieldsIssue(merged)
    if (fields) return { ok: false, code: 'thread_session_refused', message: fields }
    const checked = parseConfig({ ...merged, rev: cur.rev + 1, version: 1 })
    if (!checked.ok) return { ok: false, code: 'bad_frame', message: checked.message }
    const inherited = newInheritedThread(cur, checked.config)
    if (inherited) return { ok: false, code: 'bad_frame', message: inheritedMessage(inherited) }
    const issue = threadPatchIssue(checked.config)
    if (issue) return { ok: false, code: 'bad_frame', message: issue }
    // Option C (docs/OPTION-C.md 9.2), on exactly what gets written: archived threads go back to shared, then the
    // threads this change touches are judged and new thread folders are checked on disk
    const next = clearArchivedSessions(checked.config)
    const optionC = optionCPatchIssue(cur, next, this.roots)
    if (optionC) return { ok: false, code: 'thread_session_refused', message: optionC }
    this.write(next)
    return { ok: true, config: this.current }
  }

  /**
   * `trust_mode` is written only by `talos-app trust` (the Mac's shell), never from the copy in memory: a write made
   * between that edit and the next reload must not put the old value back, or `trust off` would silently undo itself.
   */
  private write(c: AgentConfigT, fromMemory = false) {
    if (!fromMemory) {
      const raw = readJsonFile(this.path) as { trust_mode?: unknown } | undefined
      if (raw !== undefined) {
        const { trust_mode: _t, ...rest } = c
        c = (raw.trust_mode === true ? { ...rest, trust_mode: true } : rest) as AgentConfigT
      }
    }
    // the file as it is now becomes a version first; this never throws and never stops the save
    saveConfigVersion({ configPath: this.path, dir: join(dirname(this.path), 'config-history'), log: this.log })
    recordedWrite(this.path, 'config', () => writeJsonAtomic(this.path, c, 0o600))
    this.current = c
    this.seenMtime = mtimeMs(this.path)
  }
}

/** Driving mode can't be left on for days (docs/V2-FEATURES.md V4.5): `driving_until` is clamped to now + 12 h. */
function clampDriving(merged: Record<string, unknown>, now: number) {
  const vn = merged.voice_notes as { driving_until?: unknown } | undefined
  if (!vn || typeof vn.driving_until !== 'string') return
  const t = Date.parse(vn.driving_until)
  if (Number.isFinite(t) && t > now + DRIVING_MAX_MS)
    merged.voice_notes = { ...vn, driving_until: new Date(now + DRIVING_MAX_MS).toISOString() }
}
