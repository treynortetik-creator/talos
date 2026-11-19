// Feature flags the relay hands the app (docs/V2-FEATURES.md V1, review finding 7).
//   - Relay features (`ready.features`): what THIS relay implements, filled from its own code. A module adds its flag in
//     its register() (`registerRelayFeature(HEALTH_FEATURE)` in WP-V1, `SHARE_FEATURE` in WP-V4), so Settings -> Health
//     and share tokens stay reachable while the Mac is down.
//   - Bridge features (`presence.features`): the bridge's `hello.client.features`. While the bridge is offline presence
//     keeps the LAST-KNOWN list with `features_at`, persisted, so the app shows "Needs your Mac" instead of hiding Search
//     and Memory. A bridge hello may carry up to FEATURES_MAX entries, all kept here for has(); what goes to an app is
//     at most FEATURES_MAX_V1 (an older app refuses a longer list) unless the app's hello listed WIDE_FEATURES_FEATURE.
import {
  bridgeHasFeature,
  FEATURES_MAX,
  FEATURES_MAX_V1,
  MainState,
  type MainStateT,
  PEER_FEATURE,
  PROBLEMS_FEATURE,
  PROBLEMS_INSTALL_FEATURE,
} from '@talos-app/protocol'
import type { Store } from './store.ts'

/**
 * True while a stored frame must wait for a newer Mac: any problem report until its hello lists `problems/1`, and a report from
 * another install (a source and fields an older Mac refuses) until it lists `problems-install/1`. A linked-agent message
 * (`peer.message`) waits the same way for `peer/1`: an older Mac drops a frame type it does not know and says nothing.
 */
export function problemHeld(frame: { type: string }, bridgeHas: (feature: string) => boolean): boolean {
  if (frame.type === 'peer.message') return !bridgeHas(PEER_FEATURE)
  if (frame.type !== 'problem.item') return false
  if (!bridgeHas(PROBLEMS_FEATURE)) return true
  return (
    (frame as { problem?: { source?: unknown } }).problem?.source === 'install' && !bridgeHas(PROBLEMS_INSTALL_FEATURE)
  )
}

const relayFeatures = new Set<string>()

export function registerRelayFeature(feature: string): void {
  relayFeatures.add(feature)
}
export function relayFeatureList(): string[] {
  return [...relayFeatures].slice(0, FEATURES_MAX_V1)
}
/** Tests only. */
export function resetRelayFeatures(): void {
  relayFeatures.clear()
}

const KEY = 'bridge_features'

/** Last-known bridge features, kept in store state so a redeploy keeps them. */
export class BridgeFeatures {
  private list: string[] = []
  private at: string | null = null

  constructor(private store: Pick<Store, 'getState' | 'setState'>) {
    try {
      const v = JSON.parse(store.getState(KEY) ?? 'null') as { features?: unknown; at?: unknown } | null
      if (v && Array.isArray(v.features) && typeof v.at === 'string') {
        this.list = v.features
          .filter((x): x is string => typeof x === 'string' && x.length <= 40)
          .slice(0, FEATURES_MAX)
        this.at = v.at
      }
    } catch {
      // unreadable state: start empty
    }
  }

  /** On every bridge hello. */
  onHello(features: readonly string[], nowIso: string): void {
    this.list = features.filter((x) => typeof x === 'string' && x.length <= 40).slice(0, FEATURES_MAX)
    this.at = nowIso
    this.store.setState(KEY, JSON.stringify({ features: this.list, at: this.at }))
  }

  /** True once a bridge has said hello at least once (an empty list from an old build still counts as an answer). */
  known(): boolean {
    return this.at !== null
  }

  /** By name, or through FEATURES_IMPLIED_FEATURE for a retired one (packages/protocol/src/features-cap.ts). */
  has(feature: string): boolean {
    return bridgeHasFeature(this.list, feature)
  }

  /**
   * The presence fields: the live list while online, the last-known one (with when) while offline. At most
   * FEATURES_MAX_V1 entries, the first ones the bridge sent: every app reads that many. `wide`: the whole list.
   */
  presence(wide = false): { features?: string[]; features_at?: string } {
    if (!this.at || this.list.length === 0) return {}
    return { features: wide ? this.list : this.list.slice(0, FEATURES_MAX_V1), features_at: this.at }
  }

  /**
   * `frame` (a `presence` or a `ready`) as an app gets it whose hello listed WIDE_FEATURES_FEATURE: with the whole list.
   * The same object when there is nothing more to give.
   */
  widen(frame: Record<string, unknown>): Record<string, unknown> {
    if (this.list.length <= FEATURES_MAX_V1 || !this.at) return frame
    if (frame.type === 'presence') return { ...frame, ...this.presence(true) }
    const p = frame.presence
    if (frame.type === 'ready' && p && typeof p === 'object')
      return { ...frame, presence: { ...p, ...this.presence(true) } }
    return frame
  }

  /** `widen` as text, for a frame already serialised as `text`: that same text when there is nothing to add. */
  widenText(frame: Record<string, unknown>, text: string): string {
    const w = this.widen(frame)
    return w === frame ? text : JSON.stringify(w)
  }
}

const SUPERSEDED_KEY = 'bridge_superseded'

/**
 * A bridge was replaced by a newer one with the same key and no hello has found the slot empty since (`presence.superseded`).
 * Kept in store state so a redeploy keeps it.
 */
export function isBridgeSuperseded(store: Pick<Store, 'getState'>): boolean {
  return store.getState(SUPERSEDED_KEY) === '1'
}

/** Returns whether the mark changed. */
export function setBridgeSuperseded(store: Pick<Store, 'getState' | 'setState'>, on: boolean): boolean {
  if (isBridgeSuperseded(store) === on) return false
  store.setState(SUPERSEDED_KEY, on ? '1' : '0')
  return true
}

const MAIN_KEY = 'bridge_main'

/**
 * Main's state from the bridge's last health beat (`presence.main`, the app's "sign in on your PC" banner). Kept with the
 * beat it came in; shown only while that bridge is online (the hub checks). A beat without one clears it.
 */
export function bridgeMainPresence(store: Pick<Store, 'getState'>): { main?: MainStateT } {
  const m = MainState.safeParse(store.getState(MAIN_KEY))
  return m.success ? { main: m.data } : {}
}

/** Notes the beat's state; returns whether it changed (so the hub tells the apps at once, not at the next presence). */
export function noteBridgeMain(store: Pick<Store, 'getState' | 'setState'>, main: MainStateT | undefined): boolean {
  const next = main ?? ''
  if ((store.getState(MAIN_KEY) ?? '') === next) return false
  store.setState(MAIN_KEY, next)
  return true
}
