// The `ready` frame: what a socket is told on connecting (policy, presence, features and, for an app, the owner's state).
// Handler of the Hub class (hub.ts), which forwards to it.
import {
  BRIDGE_STANDBY_FEATURE,
  CONFIG_PROPOSE_FEATURE,
  CUSTOM_THEMES_FEATURE,
  FEATURES_IMPLIED_FEATURE,
  FEATURES_MAX_V1,
  HEARTBEAT_FEATURE,
  MAX_FRAME_BYTES,
  NEEDS_YOU_FEATURE,
  newUlid,
  type PresenceT,
  QUIET_LINES_FEATURE,
  SCHEDULES_FEATURE,
  SCHEDULES_FEATURE_V2,
  stripDeviceHidden,
  type ThreadT,
  WIDE_FEATURES_FEATURE,
  withLegacyMirror,
} from '@talos-app/protocol'
import type { DEFAULT_AGENT_CONFIG } from './default-config.ts'
import { relayFeatureList } from './features.ts'
import { type HubDeps, PING_MS } from './hub-types.ts'
import { mkFrame } from './util.ts'

/** What `ready` uses of Hub, and nothing else. Hub builds it in its constructor. */
export type ReadyCtx = {
  d: HubDeps
  readyExtras: Array<() => Record<string, unknown>>
  presence(): PresenceT
  cfg(): Parameters<typeof withLegacyMirror>[0] | typeof DEFAULT_AGENT_CONFIG
  threads(): ThreadT[]
}

export const readyFrames = {
  ready(this: ReadyCtx, forApp: boolean): Record<string, unknown> {
    const base = mkFrame(this.d.clock, 'ready', {
      session_id: `sess_${newUlid().slice(-12)}`,
      policy: { max_frame_bytes: MAX_FRAME_BYTES, ping_ms: PING_MS },
      server_seq: this.d.store.maxSeq(),
      presence: this.presence(),
      features: [
        ...new Set([
          SCHEDULES_FEATURE,
          SCHEDULES_FEATURE_V2,
          HEARTBEAT_FEATURE,
          CONFIG_PROPOSE_FEATURE,
          CUSTOM_THEMES_FEATURE,
          NEEDS_YOU_FEATURE, // knows kind:'dialog'; the web build it ships draws it
          QUIET_LINES_FEATURE, // takes a bridge's `quiet.lines` frame and sends it to the apps that listed it
          BRIDGE_STANDBY_FEATURE, // turns a standby hello away while another bridge is connected
          WIDE_FEATURES_FEATURE, // takes a bridge hello with up to FEATURES_MAX features
          FEATURES_IMPLIED_FEATURE, // reads a bridge's features-implied/1 as its retired features
          ...relayFeatureList(),
        ]),
      ].slice(0, FEATURES_MAX_V1), // an older bridge refuses a longer `ready`
    })
    if (!forApp) return base
    const cfg = this.cfg()
    return {
      ...base,
      agent_config: withLegacyMirror(stripDeviceHidden(cfg)), // R1-1: an older app requires a top-level mirror; drop after the next release
      threads: this.threads(),
      open_cards: this.d.store.openCards(this.d.clock.now()),
      unread: this.d.store.unreadByThread(),
      read_upto: this.d.store.readByThread(),
      not_delivered: this.d.store.notDelivered(),
      statuses: this.d.store.allStatuses(),
      ...Object.assign({}, ...this.readyExtras.map((f) => f())),
    }
  },
}
