// The shape every integration implements (spec 7.2, 7.3, 7.7). Seam: frozen after WP0 (WP8 may edit).
import type { IntegrationIdT, NormalizedEventT, SetupSpecT, ThreadIdT } from '@talos-app/protocol'

/** What a verifier sees. `rawBody` is the exact bytes received (every signature signs the raw body). */
export type VerifyRequest = {
  /** Lower-cased header names. */
  headers: Record<string, string>
  rawBody: Uint8Array
  url: string
  /** Unix milliseconds. Injected so tests use a fake clock. */
  now: number
}

export type VerifyConnection = {
  /** Current secret first; an older secret stays valid for 24 h after rotation. */
  secrets: string[]
  extra: Record<string, string>
}

export type VerifyResult = { ok: true; deliveryKey?: string } | { ok: false; reason: string }

/** The connection an event belongs to, as the normalizer needs it. */
export type NormalizeConnection = {
  /** `cn_` + 22 base62 (ConnId). */
  id: string
  integration: IntegrationIdT
  /** A configured thread id (default `inbox`; work integrations default to the work thread). */
  thread: ThreadIdT
  work: boolean
  extra: Record<string, string>
}

/** A raw inbound delivery after verification. `json` is the parsed body when it parsed, otherwise undefined. */
export type RawDelivery = {
  headers: Record<string, string>
  rawBody: Uint8Array
  json?: unknown
  /** Unix milliseconds. */
  receivedAt: number
}

export type HandshakeResponse = { status: number; contentType: string; body: string }

export type PollContext = {
  /** Opaque per-connection cursor persisted by the relay between polls. */
  cursor: string | null
  secrets: Record<string, string>
  extra: Record<string, string>
  now: number
  fetch: typeof fetch
  /** Test seam: resolves a feed hostname to its addresses. Production fetches check addresses at connect time instead. */
  resolve?: (host: string) => Promise<string[]>
}
export type PollResult = {
  deliveries: RawDelivery[]
  cursor: string | null
  /** Seconds until the next poll (e.g. GitHub's X-Poll-Interval). The relay adds jitter. */
  nextInS: number
  /** True when more existed than one poll fetched (the Inbox shows "Some mail was skipped"). */
  truncated?: boolean
}

export interface IntegrationModule {
  id: IntegrationIdT
  /** Drives the 5-screen wizard (7.7) and `GET /api/integrations/catalog`. */
  setup: SetupSpecT
  /** Constant-time compares only. */
  verify(req: VerifyRequest, conn: VerifyConnection): VerifyResult | Promise<VerifyResult>
  /** One delivery can yield many events (a Gmail batch). `summary` is deterministic plain text, no LLM. */
  normalize(raw: RawDelivery, conn: NormalizeConnection): NormalizedEventT[] | Promise<NormalizedEventT[]>
  /** Runs right after verification and before anything is stored; false = drop with a 200 (Slack, work sources). */
  prefilter?(raw: RawDelivery, conn: NormalizeConnection): boolean
  /** Provider handshakes that must answer before the owner clicks Verify (Slack url_verification, Zoom, Google sync). */
  handshake?(raw: RawDelivery, conn: VerifyConnection): HandshakeResponse | null
  /** Pollers (Jira, GitHub notifications, RSS) run in the relay on a jittered schedule. */
  poll?(ctx: PollContext): Promise<PollResult>
}
