// Feature flags the relay hands the app (docs/V2-FEATURES.md V1, review finding 7).
//   - Relay features (`ready.features`): what THIS relay implements, filled from its own code. A module adds its flag in
//     its register() (`registerRelayFeature(HEALTH_FEATURE)` in WP-V1, `SHARE_FEATURE` in WP-V4), so Settings -> Health
//     and share tokens stay reachable while the Mac is down.
//   - Bridge features (`presence.features`): the bridge's `hello.client.features`. While the bridge is offline presence
//     keeps the LAST-KNOWN list with `features_at`, persisted, so the app shows "Needs your Mac" instead of hiding Search
//     and Memory. Both lists are capped at 20 entries by the protocol.
import type { Store } from './store.ts'

const relayFeatures = new Set<string>()

export function registerRelayFeature(feature: string): void {
  relayFeatures.add(feature)
}
export function relayFeatureList(): string[] {
  return [...relayFeatures].slice(0, 20)
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
        this.list = v.features.filter((x): x is string => typeof x === 'string' && x.length <= 40).slice(0, 20)
        this.at = v.at
      }
    } catch {
      // unreadable state: start empty
    }
  }

  /** On every bridge hello. */
  onHello(features: readonly string[], nowIso: string): void {
    this.list = features.filter((x) => typeof x === 'string' && x.length <= 40).slice(0, 20)
    this.at = nowIso
    this.store.setState(KEY, JSON.stringify({ features: this.list, at: this.at }))
  }

  /** True once a bridge has said hello at least once (an empty list from an old build still counts as an answer). */
  known(): boolean {
    return this.at !== null
  }

  has(feature: string): boolean {
    return this.list.includes(feature)
  }

  /** The presence fields: the live list while online, the last-known one (with when) while offline. */
  presence(): { features?: string[]; features_at?: string } {
    if (!this.at || this.list.length === 0) return {}
    return { features: this.list, features_at: this.at }
  }
}
