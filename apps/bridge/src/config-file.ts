// config.json: load, validate, patch and write atomically (spec 1.2, 3.4). The Mac file is authoritative; every write
// bumps `rev` and the caller emits `config.sync`.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  AgentConfig,
  type AgentConfigT,
  applyMergePatch,
  checkConfigPatch,
  clearArchivedSessions,
  DRIVING_MAX_MS,
  HIGH_RISK_SETTING_PATHS,
  isInheritedName,
  jcs,
  phoneValueIssue,
  resolveThreadsPatch,
  sessionFieldsIssue,
  subThreadPatchIssue,
  threadOptsIssue,
  threadPatchIssue,
  validateAgentConfig,
} from '@talos-app/protocol'
import { saveConfigVersion } from './config-history.ts'
import { mtimeMs, readJsonFile, writeJsonAtomic } from './fsutil.ts'
import {
  clearedPaths,
  isCleared,
  lossesOf,
  pathsWithin,
  quarantineArchivedSessions,
  restoreLosses,
  stripRetired,
} from './keep-unknown.ts'
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

/** What `parseConfig` needs from a schema; tests hand in an older, smaller one to play a build that knows fewer keys. */
export type ConfigSchema = { safeParse(v: unknown): ReturnType<typeof AgentConfig.safeParse> }

export function parseConfig(
  value: unknown,
  schema: ConfigSchema = AgentConfig,
): { ok: true; config: AgentConfigT } | { ok: false; message: string } {
  const r = schema.safeParse(value)
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
  private readonly schema: ConfigSchema
  private readonly macSubThreads: () => boolean
  private readonly macOwnFolder: () => boolean

  constructor(
    private readonly path: string,
    opts: {
      roots?: WorkerRoots
      log?: Pick<Logger, 'warn'>
      schema?: ConfigSchema
      /** Does the Mac app check a sub-thread's folder before every start (workers.json)? Absent = no: no thread gets a parent. */
      subthreadsSupported?: () => boolean
      /** Does it also start a dedicated sub-thread in its own folder outside the parent's? Absent = no (the old inside-only rule). */
      subthreadsOwnFolder?: () => boolean
    } = {},
  ) {
    this.roots = opts.roots ?? defaultWorkerRoots(path)
    this.macSubThreads = opts.subthreadsSupported ?? (() => false)
    this.macOwnFolder = opts.subthreadsOwnFolder ?? (() => false)
    this.log = opts.log
    this.schema = opts.schema ?? AgentConfig
  }

  /** Loads (throws a readable error when missing or invalid). */
  load(): AgentConfigT {
    const raw = readJsonFile(this.path)
    if (raw === undefined) throw new Error(`cannot read ${this.path}; run: talos-app init --relay-url <url>`)
    const r = parseConfig(raw, this.schema)
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
    const r = raw === undefined ? undefined : parseConfig(raw, this.schema)
    this.seenMtime = m
    if (!r?.ok) return false // keep the last good config; the owner is probably mid-edit
    if (jcs(r.config) === before) return false
    const prevRev = this.current ? this.current.rev : -1
    this.current = clearArchivedSessions(r.config)
    if (this.current.rev <= prevRev || this.current !== r.config)
      this.write({ ...this.current, rev: Math.max(this.current.rev, prevRev + 1) })
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
    const r = raw === undefined ? undefined : parseConfig(raw, this.schema)
    this.seenMtime = m
    if (r?.ok) this.current = r.config
  }

  markSynced(config: AgentConfigT) {
    this.syncedKey = jcs(config)
  }
  needsSync(): boolean {
    return jcs(this.config) !== this.syncedKey
  }

  /** The Mac app reports that it checks a sub-thread's folder before every start; only then may a thread get a parent. */
  subthreadsSupported(): boolean {
    try {
      return this.macSubThreads()
    } catch {
      return false
    }
  }

  /** The supervisor starts a dedicated sub-thread in its own existing folder outside its parent's. */
  subthreadsOwnFolder(): boolean {
    try {
      return this.macOwnFolder()
    } catch {
      return false
    }
  }

  /** What the sub-thread rule is judged with. */
  subThreadOpts(): { macSupports: boolean; ownFolder: boolean } {
    return { macSupports: this.subthreadsSupported(), ownFolder: this.subthreadsOwnFolder() }
  }

  /** Writes `next` with rev bumped. */
  update(mutate: (c: AgentConfigT) => AgentConfigT, opts: { setsTrustMode?: boolean } = {}): AgentConfigT {
    const base = this.config
    const next = mutate(structuredClone(base))
    const checked = parseConfig({ ...next, rev: base.rev + 1 }, this.schema)
    if (!checked.ok) throw new Error(checked.message)
    const inherited = newInheritedThread(base, checked.config)
    if (inherited) throw new Error(inheritedMessage(inherited))
    // the same Mac-only rule as a patch, so a tool that writes through update() cannot skip it
    const macOnly = threadOptsIssue(base, checked.config)
    if (macOnly) throw new Error(macOnly)
    const sub = subThreadPatchIssue(base, checked.config, this.subThreadOpts())
    if (sub) throw new Error(sub)
    // archiving a thread (the agent's archive_thread) also turns its own session off (docs/OPTION-C.md 9.2)
    this.write(clearArchivedSessions(checked.config), opts.setsTrustMode === true)
    return this.current
  }

  /**
   * `config.patch` from the app: allowlist, optimistic concurrency, schema + structure validation. `agent`: the bridge writing a
   * change the agent made (a card or the owner's ask), already checked against the agent's own rules in the settings table, so the
   * phone's off-only rule (the memory browser) does not apply to it.
   */
  applyPatch(
    baseRev: number,
    patch: Record<string, unknown>,
    now: number = Date.now(),
    opts: { agent?: boolean } = {},
  ): PatchResult {
    // A hand edit not yet picked up must not be judged against the copy in memory: Settings echoes the values it last saw, and a
    // stale `ops_read: true` would otherwise put back what the owner just took away.
    this.reloadIfChanged()
    const check = checkConfigPatch(patch)
    if (!check.ok) return { ok: false, code: 'config_field_forbidden', message: `field not allowed: ${check.path}` }
    // Settings the phone may only turn off (the memory browser kill switch, docs/V2-FEATURES.md V5.1): `on` comes from the Mac.
    const offOnly = opts.agent ? null : phoneValueIssue(patch)
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
    // Mac-only thread options (ops_read): never turned on from an app patch or an agent card; off and echoes are fine
    const macOnly = threadOptsIssue(cur, merged)
    if (macOnly) return { ok: false, code: 'config_field_forbidden', message: macOnly }
    const checked = parseConfig({ ...merged, rev: cur.rev + 1, version: 1 }, this.schema)
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
    // sub-threads (docs/THREADS.md "Sub-threads"): one level, folder and MCP list inside the parent's, Mac support first
    const sub = subThreadPatchIssue(cur, next, this.subThreadOpts())
    if (sub) return { ok: false, code: 'bad_frame', message: sub }
    // Trust mode is the one setting `write` keeps from the file rather than from memory. A patch that names it is the
    // owner's signed change (the relay already asked for the passkey on `true`), so its value is written as it stands, in the
    // same shape `talos-app trust off` leaves: on is `true`, off is no key at all.
    try {
      if ('trust_mode' in patch) {
        const { trust_mode: _t, ...rest } = next
        this.write(
          (next.trust_mode === true ? { ...rest, trust_mode: true } : rest) as AgentConfigT,
          true,
          clearedPaths(patch),
        )
      } else this.write(next, false, clearedPaths(patch))
    } catch (e) {
      // the file on disk cannot be read, so nothing was written (see `write`)
      return { ok: false, code: 'bad_frame', message: (e as Error).message }
    }
    return { ok: true, config: this.current }
  }

  /**
   * `trust_mode` is written only by `talos-app trust` (the Mac's shell) or by a patch that names it (`applyPatch`), never
   * from a stale copy in memory: a write made between that edit and the next reload must not put the old value back, or
   * `trust off` would silently undo itself.
   */
  private write(c: AgentConfigT, fromMemory = false, cleared: ReturnType<typeof clearedPaths> = []) {
    const raw = readJsonFile(this.path)
    let onDisk: unknown = c // what goes into the file; `this.current` stays what this build reads
    if (existsSync(this.path)) {
      // A file this build cannot read (invalid JSON, or a newer value, too many threads, an owner typo) is not replaced with
      // the copy in memory: that would erase what the owner has there. The caller gets the error; the file is left alone.
      const readable = raw === undefined ? undefined : parseConfig(raw, this.schema)
      if (!readable?.ok) {
        const why = readable ? readable.message : 'it is not valid JSON'
        this.log?.warn('config.json not written: the file on disk cannot be read, so it was left as it is', {
          path: this.path,
          why,
        })
        throw new Error(
          `config.json was not written: the file on disk cannot be read (${why}); fix or restore it first`,
        )
      }
      if (!fromMemory) {
        const { trust_mode: _t, ...rest } = c
        c = (
          (raw as { trust_mode?: unknown }).trust_mode === true ? { ...rest, trust_mode: true } : rest
        ) as AgentConfigT
      }
      // What this build's schema cannot read (a key an older build does not know, a value that failed its parse) stays in the
      // file as the owner left it, at every depth. A patch that names trust_mode decides it itself.
      onDisk = restoreLosses(c, lossesOf(raw, readable.config), {
        skip: (l) =>
          (fromMemory && l.path.length === 1 && l.path[0] === 'trust_mode') ||
          // a value this write cleared on purpose does not come back, even when it reads as the default it fell back to
          isCleared(cleared, l.path),
        onRestore: (p, restored) => {
          // a high-risk value can come back inside a parent that was restored whole
          const inside = pathsWithin(
            p.filter((x) => x !== '*'),
            restored,
          )
          for (const path of inside)
            if (HIGH_RISK_SETTING_PATHS.includes(path) || path.endsWith('session_opts.mcp_allow'))
              this.log?.warn('config.json: kept a value this build cannot read in a high-risk setting', { path })
        },
      })
    }
    onDisk = stripRetired(quarantineArchivedSessions(onDisk))
    // the file as it is now becomes a version first; this never throws and never stops the save
    saveConfigVersion({ configPath: this.path, dir: join(dirname(this.path), 'config-history'), log: this.log })
    recordedWrite(this.path, 'config', () => writeJsonAtomic(this.path, onDisk, 0o600))
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
