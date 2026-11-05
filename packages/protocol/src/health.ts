// Health alarms (docs/V2-FEATURES.md V2). The relay watchdog owns every Mac-side alert (once per outage, quiet window
// respected); ntfy is an optional second path. The hourly external check (V2.4) is dropped for now (owner, 2026-10-29;
// v1.1): no /api/health, no HEALTH_TOKEN, no external_check field.
import { z } from 'zod'
import { IsoTs } from './ids.ts'

export const HEALTH_FEATURE = 'health/1'

/** Below this the Mac's disk counts as nearly full: Health turns red and the watchdog pushes once. */
export const DISK_LOW_BYTES = 2 * 1024 ** 3
/** Back above this the episode is over and the next fill-up pushes again (the gap stops it flapping around the line). */
export const DISK_RECOVERED_BYTES = 4 * 1024 ** 3

/** `no_alert_path` = 0 push subscriptions AND ntfy off. */
export const RelayProblem = z.enum(['storage_full', 'no_alert_path'])
/** After 5 min / MOD_QUIET_MIN. */
export const MacProblem = z.enum(['bridge_offline', 'mod_quiet'])

export const ModHealth = z.object({
  state: z.enum(['alive', 'quiet', 'absent']), // alive = a sync within MOD_LIVE_WINDOW_MS (30 s, session.ts)
  last_seen: IsoTs.nullable(),
  expected: z.boolean(), // the mod synced at least once in the last 7 days (bridge kv `mod_seen_at`)
})

/** bridge -> relay, every 60 s and within 2 s of a change. No content: no thread names, paths or text. */
export const HealthBeat = z.object({
  bridge: z.object({ version: z.string().max(40), started_at: IsoTs }),
  mod: ModHealth,
  tts: z.boolean(),
  stt: z.boolean(),
  sqlite: z.object({ fts5: z.boolean() }), // probe result (V3.1); false = search/memory not advertised
  /** Free bytes on the volume the bridge keeps its data on: a number only, never a path. Absent from an older bridge. */
  disk_free_bytes: z.number().int().nonnegative().optional(),
  /**
   * Whether this session declared `claude/channel/permission` to Claude Code when it started. Claude Code only sends tool
   * prompts to a server that did, so a `permission_relay` setting turned on later does nothing until a restart. One
   * boolean; absent from an older bridge, or before the bridge knows.
   */
  permission_relay_declared: z.boolean().optional().catch(undefined),
  search: z.object({ state: z.enum(['off', 'indexing', 'ready', 'dirty']), docs: z.number().int() }).optional(),
  memory: z
    .object({ state: z.enum(['off', 'indexing', 'ready']), files: z.number().int(), truncated: z.boolean() })
    .optional(),
})

/**
 * The relay's own limits, read-only in Settings -> Health and used in the app's wording. Numbers only. Optional on
 * HealthStatus: an older relay omits the whole object, and the app falls back to its old wording.
 */
export const RelayLimits = z.object({
  /** How many days an undelivered message waits on the relay (BUFFER_DAYS). */
  buffer_days: z.number().int().positive().optional(),
  /** The biggest upload in MB (MEDIA_MAX_MB). */
  upload_max_mb: z.number().positive().optional(),
  /** Live-voice minutes per day and per call (VOICE_DAILY_MAX_MIN, VOICE_SESSION_MAX_MIN); 0 daily = no live-voice minutes at all. */
  voice_daily_max_min: z.number().int().nonnegative().optional(),
  voice_session_max_min: z.number().int().positive().optional(),
})

/** GET /api/status (session; Settings -> Health). */
export const HealthStatus = z.object({
  at: IsoTs,
  relay_ok: z.boolean(), // = relay_problems is empty
  relay_problems: z.array(RelayProblem),
  relay: z.object({ version: z.string(), up_since: IsoTs }),
  mac_problems: z.array(MacProblem), // informational for the workflow; the watchdog alerts on these
  bridge: z.object({
    online: z.boolean(),
    last_seen: IsoTs.nullable(),
    down_since: IsoTs.nullable(),
    /**
     * The relay turned the bridge's last hello away (wrong or removed key, or its IP blocked) and no good hello has come
     * since. Only present while the bridge is offline. Optional: an older relay never sends it. Deliberately not a
     * `MacProblem`: that enum is strict, and an older web client would reject the whole status for one new value.
     */
    auth_refused_at: IsoTs.nullable().optional(),
  }),
  mod: ModHealth.extend({ state: z.enum(['alive', 'quiet', 'absent', 'unknown']) }), // unknown = bridge offline
  push: z.object({
    subscriptions: z.number().int(),
    last_ok_at: IsoTs.nullable(),
    last_error_at: IsoTs.nullable(),
  }),
  ntfy: z.boolean(), // ALERT_NTFY_URL is set (never the URL)
  /** Absent from an older relay. Do not add enum values to the strict lists above: an older app would drop the status. */
  limits: RelayLimits.optional().catch(undefined),
  beat: HealthBeat.omit({ bridge: true }).partial().optional(),
})

/** `relay_ok` is exactly "no relay-side problem"; Mac states are the watchdog's (rev 2 finding 1). */
export function relayOk(status: Pick<z.infer<typeof HealthStatus>, 'relay_problems'>): boolean {
  return status.relay_problems.length === 0
}

export type RelayProblemT = z.infer<typeof RelayProblem>
export type MacProblemT = z.infer<typeof MacProblem>
export type ModHealthT = z.infer<typeof ModHealth>
export type RelayLimitsT = z.infer<typeof RelayLimits>
export type HealthBeatT = z.infer<typeof HealthBeat>
export type HealthStatusT = z.infer<typeof HealthStatus>
