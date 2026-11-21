// How a bridge keeps its online relay (Railway) on the newest release, and the three files that say so. Both sides parse these:
// the bridge (apps/bridge/src/relay) and the Mac app (the fixtures in fixtures/relay-redeploy are what its tests parse too).
//
// `<home>/relay-connect.json` (RelayConnectFile): how this install may redeploy its relay.
//   via "token": the owner pasted a Railway token into `talos-app relay connect`; the bridge calls Railway itself. The token lives in
//                the key store, never in this file. `kind` says which header it goes in (project: Project-Access-Token, account:
//                Authorization: Bearer).
//   via "app":   the Mac app set the relay up and holds the Railway login (it refreshes it; the bridge never sees it). The app writes
//                this file itself, with no token and no `kind`.
// No file here ever holds a token, a secret or a password.
//
// `<home>/relay-redeploy-request.json` and `relay-redeploy-result.json` (via "app" only): the bridge asks, the app does it.
//   - The bridge writes ONE request at a time (0600, replaced atomically, a new one replaces the old) and never more often than
//     once an hour on its own; an owner's `talos-app relay update` may replace it sooner.
//   - The app ignores a request older than 10 minutes, keeps ONE in flight and takes the newest `id`, performs Railway's
//     `serviceInstanceRedeploy`, and writes the result file: the same `id` and the `release` it was asked for, `ok`, and on a failure a
//     `code` from a closed list plus a short plain `error` text.
//   - The bridge ignores a result whose `id` OR `release` differs from its request, confirms the new release by the relay's
//     /healthz, and gives up on a request with no result after 10 minutes.
//   - Order: when an app update and a relay update are both due, the relay goes first; the app does not start its own install while a
//     relay request is in flight.
// Times are whole milliseconds since 1970 (UTC).
import { z } from 'zod'
import { SEMVER } from './semver.ts'

export const RELAY_CONNECT_FILE = 'relay-connect.json'
export const RELAY_REDEPLOY_REQUEST_FILE = 'relay-redeploy-request.json'
export const RELAY_REDEPLOY_RESULT_FILE = 'relay-redeploy-result.json'
/** A request older than this is not acted on, and one with no result after this is given up on (both sides). */
export const RELAY_REDEPLOY_WINDOW_MS = 10 * 60_000

/** Railway's ids are UUIDs; any plain id of this shape is taken (a header or a query value never carries more). */
const RailwayId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/)
const Hostname = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
const PlainName = z.string().min(1).max(100)
const Millis = z.number().int().nonnegative()
const Version = z.string().regex(SEMVER)

export const RelayConnectFile = z
  .object({
    v: z.literal(1),
    via: z.enum(['token', 'app']),
    /** via "token" only: which Railway header the stored token goes in. */
    kind: z.enum(['project', 'account']).optional(),
    project_id: RailwayId,
    environment_id: RailwayId,
    service_id: RailwayId,
    workspace_id: RailwayId.optional(),
    /** The relay's public host, as a bare hostname. */
    domain: Hostname.optional(),
    service_name: PlainName.optional(),
    environment_name: PlainName.optional(),
    /** Redeploy the relay when a new release appears (`talos-app relay auto on|off`). */
    auto_update: z.boolean(),
    connected_at: Millis.optional(),
  })
  .refine((f) => f.via !== 'token' || f.kind !== undefined, {
    message: 'a token connection says its kind',
    path: ['kind'],
  })
export type RelayConnectFileT = z.infer<typeof RelayConnectFile>

export const RelayRedeployRequest = z.object({
  v: z.literal(1),
  /** Random, one per request. */
  id: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
  /** The release the relay should end up on (X.Y.Z). */
  release: Version,
  requested_at: Millis,
})
export type RelayRedeployRequestT = z.infer<typeof RelayRedeployRequest>

/** Why a redeploy failed, as a short closed list; a code this build does not know reads as `other`. */
export const RelayRedeployErrorCode = z.enum(['not_signed_in', 'no_card', 'railway_down', 'not_found', 'other'])
export type RelayRedeployErrorCodeT = z.infer<typeof RelayRedeployErrorCode>

export const RelayRedeployResult = z.object({
  v: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
  /** The release the request asked for. */
  release: Version,
  ok: z.boolean(),
  code: RelayRedeployErrorCode.catch('other').optional(),
  /** Short plain text; cut to 200 characters. */
  error: z
    .string()
    .transform((s) => s.slice(0, 200))
    .optional(),
  done_at: Millis,
})
export type RelayRedeployResultT = z.infer<typeof RelayRedeployResult>
