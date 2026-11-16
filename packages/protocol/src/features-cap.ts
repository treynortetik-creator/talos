// Which features a bridge lists in its hello, given what the relay it talks to said in its last `ready`.
//   - At most FEATURES_MAX_V1 (20) unless that relay listed WIDE_FEATURES_FEATURE: an older relay refuses a longer hello.
//   - Features every live relay has known for a while, and that only the relay reads (no app, no bridge), are retired:
//     left out, and FEATURES_IMPLIED_FEATURE listed instead, but only to a relay that listed FEATURES_IMPLIED_FEATURE in its
//     `ready` (it then reads the marker as all of IMPLIED_BRIDGE_FEATURES). An older relay still gets them by name.
// Apps read every other bridge feature (presence.features), and the owner's phone build updates slowly, so none of those
// is retired.
import { FEATURES_MAX, FEATURES_MAX_V1, WIDE_FEATURES_FEATURE } from './models.ts'
import { PROBLEMS_FEATURE } from './problems.ts'
import { NATIVE_ACT_FEATURE } from './push-rich.ts'

/** In `ready.features`: this relay reads a bridge hello's FEATURES_IMPLIED_FEATURE as all of IMPLIED_BRIDGE_FEATURES. */
export const FEATURES_IMPLIED_FEATURE = 'features-implied/1'
/** Bridge features only the relay reads, which a bridge leaves out for FEATURES_IMPLIED_FEATURE. */
export const IMPLIED_BRIDGE_FEATURES: readonly string[] = [NATIVE_ACT_FEATURE, PROBLEMS_FEATURE]

/**
 * `all` is everything this bridge implements, most important first (what an older relay or app sees is the first 20).
 * `relay` is the last `ready.features` from this relay, or null before the first one: then the list is the one any relay
 * takes.
 */
export function helloFeatures(all: readonly string[], relay: readonly string[] | null): string[] {
  const implied = relay?.includes(FEATURES_IMPLIED_FEATURE) === true
  const list = implied
    ? [FEATURES_IMPLIED_FEATURE, ...all.filter((f) => !IMPLIED_BRIDGE_FEATURES.includes(f))]
    : [...all]
  return list.slice(0, relay?.includes(WIDE_FEATURES_FEATURE) ? FEATURES_MAX : FEATURES_MAX_V1)
}

/** True when `features` (a bridge hello's) has `feature`, by name or through FEATURES_IMPLIED_FEATURE. */
export function bridgeHasFeature(features: readonly string[], feature: string): boolean {
  if (features.includes(feature)) return true
  return IMPLIED_BRIDGE_FEATURES.includes(feature) && features.includes(FEATURES_IMPLIED_FEATURE)
}

/**
 * After `ready`: whether the hello that went out (`sent`) should be sent again as `helloFeatures(all, relay)`. Only when
 * it matters: the relay would have taken a feature `sent` left out, or `sent` leans on FEATURES_IMPLIED_FEATURE and this
 * relay does not read it (a relay rolled back since the last `ready`). A hello that merely names the retired ones is fine.
 */
export function helloNeedsResend(all: readonly string[], sent: readonly string[], relay: readonly string[]): boolean {
  if (sent.includes(FEATURES_IMPLIED_FEATURE) && !relay.includes(FEATURES_IMPLIED_FEATURE)) return true
  const want = helloFeatures(all, relay)
  return all.some((f) => bridgeHasFeature(want, f) && !bridgeHasFeature(sent, f))
}
