import type { IntegrationModule } from '@talos-app/integrations'
import type { IntegrationIdT, NormalizedEventT } from '@talos-app/protocol'
import type { RelayServices } from '../services.ts'
import { openEvent } from './event-seal.ts'

export type ConnRow = {
  id: string
  integration: IntegrationIdT
  name: string
  thread: string
  status: 'active' | 'paused' | 'error'
  paused_reason: string | null
  filters: Record<string, boolean>
  advanced: AdvancedFilter[]
  extra: Record<string, string>
  created_at: number
  last_event_at: number | null
}

export type AdvancedFilter = {
  field: string
  op: 'equals' | 'contains' | 'matches' | 'in'
  value: string | string[]
  effect: 'keep' | 'drop'
}

export type RuntimeOptions = {
  /** Replaces catalog entries (tests inject a fake work module). */
  modules?: Partial<Record<IntegrationIdT, IntegrationModule>>
  fetch?: typeof fetch
  /** 0..1, for poll jitter. */
  random?: () => number
  /** false = the hook route writes the durable row and answers 200 but nothing processes it until `drain()` / `tick()`. */
  autoProcess?: boolean
  /** Hook body read: longest gap between two chunks, and longest total. Tests shorten them. */
  bodyIdleMs?: number
  bodyTotalMs?: number
}

/** What a body read came to: the bytes, null (over the cap), 'busy' (too many reads in flight) or 'slow' (the sender stalled). */
export type BodyRead = Uint8Array | null | 'busy' | 'slow'

/** What the pieces of the hooks module share. Built once per RelayServices. */
export interface HooksRuntime {
  services: RelayServices
  opts: RuntimeOptions
  module(id: IntegrationIdT): IntegrationModule
  now(): number
  /** Epoch ms -> ISO. */
  iso(ms: number): string
}

export type EventRow = {
  event_id: string
  conn_id: string
  integration: IntegrationIdT
  thread: string
  priority: 'high' | 'normal' | 'low'
  work: number
  ts: string
  /** Plain event text: empty once sealed, present only on rows from before sealing existed. */
  event_json: string
  event_enc?: Buffer | null
  state: 'new' | 'read' | 'done' | 'snoozed'
  snooze_until: string | null
  agent_summary: string | null
  card_id: string | null
  raw_id: string | null
  collected: number
  digested_at: number | null
  bridge_frame_id: string | null
  apps_sent_at: number | null
  sent_at: number | null
  delivered_at: number | null
  passthrough: number
  created_at: number
}

export function eventOf(
  rt: HooksRuntime,
  row: Pick<EventRow, 'event_id' | 'event_json' | 'event_enc'>,
): NormalizedEventT {
  return openEvent(rt.services, row)
}

export const DAY_MS = 86_400_000
export const HOUR_MS = 3_600_000
/** How long a replaced signing secret keeps verifying: after a rotation, and after a re-pasted vendor secret. */
export const OLD_SECRET_GRACE_MS = 24 * HOUR_MS
export const MAX_BODY_BYTES = 1_000_000
export const DEDUP_TTL_MS = 7 * DAY_MS
export const GITHUB_DEDUP_TTL_MS = 90 * DAY_MS
/** Creds keys that hold the previous vendor signing secret after a re-paste, and when it stops being accepted. */
export const PREV_SECRET = '_prev_verify_secret'
export const PREV_SECRET_UNTIL = '_prev_verify_secret_until'
export const POLL_PAUSE_AFTER = 10
export const MAX_CONNECTIONS = 50
/** Verified, accepted deliveries per connection per hour. Past it the sender gets 429 and retries (never 2xx-and-drop). */
export const DELIVERIES_PER_HOUR = 600
/** Unverified requests (bad signature / secret) a client may make per connection per minute before they are answered 429. */
export const FAILED_VERIFY_PER_MIN = 20
/** Share of VOLUME_SOFT_CAP_MB the raw payload store may use before new deliveries are shed with 429. */
export const RAW_SOFT_CAP_SHARE = 0.25
