// v2 feature seams for the UI (docs/V2-FEATURES.md V1, V3, V5; WP-V0). FROZEN after WP-V0 (V2/V5 may extend, not change).
//   `lib/fakeV2.ts` implements both clients in memory and is wired into fakeClient. WP-V2 / WP-V5 add the socket
//   versions and make `TalosClient.search` / `.memory` required.
// Every call sends one signed owner frame and rejects with `TalosClientError` on `error{code}`
// (`mac_offline`, `search_unavailable`, `bad_query`, `memory_off`, `memory_not_found`).
import {
  type AttachmentRefT,
  DRIVING_FEATURE,
  HEALTH_FEATURE,
  type MemoryEntryT,
  type MemoryHitT,
  type MemoryLinkT,
  type MemoryRootInfoT,
  type MessageT,
  type PresenceT,
  type SearchFiltersT,
  type SearchHitT,
  SHARE_FEATURE,
} from '@talos-app/protocol'
import { useTalos } from './client.ts'

export type SearchSortT = 'relevance' | 'newest'
export type SearchIndexStateT = 'ready' | 'indexing' | 'dirty'

export interface SearchClient {
  /** `search.query` -> `search.results`. */
  search(args: {
    q: string
    filters: SearchFiltersT
    sort: SearchSortT
    cursor: string | null
    limit: number
  }): Promise<{ hits: SearchHitT[]; nextCursor: string | null; totalEstimate: number; index: SearchIndexStateT }>
  /** `history.request` with `around_id` / `before_id` / `after_id` (V3.2): the past-conversation view. */
  context(
    threadId: string,
    args: { aroundId?: string; beforeId?: string; afterId?: string },
  ): Promise<{ messages: MessageT[]; hasMore: boolean; hasNewer: boolean }>
}

export interface MemoryClient {
  /** `memory.tree`; `rootId: null` lists the roots, `path: ''` is the top of a root. */
  tree(
    rootId: string | null,
    path: string,
    cursor: string | null,
  ): Promise<{ roots?: MemoryRootInfoT[]; entries: MemoryEntryT[]; nextCursor: string | null }>
  /** `memory.read`: one chunk from a UTF-8 byte offset; `nextOffset: null` = end. */
  read(
    rootId: string,
    path: string,
    offset: number,
  ): Promise<{
    text: string
    mime: string
    size: number
    mtime: string
    sha256: string
    nextOffset: number | null
    links?: MemoryLinkT[]
  }>
  /** `memory.search`; `rootIds: []` = all roots. */
  search(
    q: string,
    rootIds: string[],
    cursor: string | null,
    limit: number,
  ): Promise<{ hits: MemoryHitT[]; nextCursor: string | null; index: SearchIndexStateT }>
}

/** What the Mac answered to one `speak.request`. `working` means ask again; an unknown state from a newer Mac reads as `working`. */
export type SpeakAnswer =
  | { state: 'ready'; media: AttachmentRefT; chars?: number; totalChars?: number; truncated?: boolean }
  | { state: 'working'; waitS?: number; chars?: number; totalChars?: number; truncated?: boolean }
  | { state: 'failed'; reason: string; message: string }

export interface SpeakClient {
  /**
   * `speak.request` -> `speak.result`: asks the Mac to read one of its stored agent messages aloud. `fresh` is true on the first
   * ask of a tap (a remembered failure is forgotten, so Retry really retries) and false on the follow-up asks. Rejects with
   * `TalosClientError` (`mac_offline`, `rate_limited`, `device_not_pinned`, ...).
   */
  request(args: { messageId: string; threadId: string; fresh: boolean }): Promise<SpeakAnswer>
}

export type FeatureState = 'on' | 'needs_mac' | 'off'

/** Features the relay itself provides: usable with the Mac offline. */
export const RELAY_FEATURES: readonly string[] = [HEALTH_FEATURE, SHARE_FEATURE]

/**
 * Relay features ('health/1', 'share/1'): 'on' when the relay lists them, whatever the bridge does.
 * Bridge features ('search/1', 'memory/1', 'driving/1'): 'on' when the bridge is online and lists them, 'needs_mac' when
 * it is offline but the last-known list (with `features_at`) has them, else 'off'.
 */
export function featureState(
  presence: Pick<PresenceT, 'bridge_online' | 'features' | 'features_at'>,
  relayFeatures: readonly string[],
  name: string,
): FeatureState {
  if (RELAY_FEATURES.includes(name)) return relayFeatures.includes(name) ? 'on' : 'off'
  const listed = presence.features?.includes(name) ?? false
  if (!listed) return 'off'
  if (presence.bridge_online) return 'on'
  return presence.features_at ? 'needs_mac' : 'off'
}

export function useFeature(name: string): FeatureState {
  const presence = useTalos((s) => s.presence)
  const relay = useTalos((s) => s.relayFeatures)
  return featureState(presence, relay, name)
}

export { DRIVING_FEATURE }
