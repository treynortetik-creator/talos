// The bridge's hello features (features-cap.ts): never more than an older relay reads unless the relay said it reads more,
// and the retired ones left out only for a relay that reads the marker.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  bridgeHasFeature,
  FEATURES_IMPLIED_FEATURE,
  FEATURES_MAX,
  FEATURES_MAX_V1,
  HelloBridgeFrame,
  helloFeatures,
  helloNeedsResend,
  IMPLIED_BRIDGE_FEATURES,
  NATIVE_ACT_FEATURE,
  PROBLEMS_FEATURE,
  WIDE_FEATURES_FEATURE,
} from '../src/index.ts'

const names = (n: number) => Array.from({ length: n }, (_, i) => `f${String(i).padStart(2, '0')}/1`)
/** Today's 20: the retired two among them, as the bridge lists them. */
const today = [...names(18).slice(0, 3), NATIVE_ACT_FEATURE, ...names(18).slice(3), PROBLEMS_FEATURE]
const STEP1 = [WIDE_FEATURES_FEATURE] // the relay of 5367f571
const STEP2 = [WIDE_FEATURES_FEATURE, FEATURES_IMPLIED_FEATURE]

/** The relay's bridge hello before the widening: features at most 20, the whole hello refused over it. */
const OldHello = HelloBridgeFrame.extend({
  client: HelloBridgeFrame.shape.client.extend({ features: z.array(z.string().max(40)).max(20).optional() }),
})
const hello = (features: string[]) => ({
  v: 1,
  type: 'hello',
  id: '01JBF3V7Q8K2M4N6P8R0S2T41M',
  ts: '2026-11-12T00:00:00.000Z',
  role: 'bridge',
  key_id: '0123456789abcdef',
  sig: 'A'.repeat(86),
  client: { name: 'bridge', version: '1', features },
  agent_config_rev: 0,
})

describe('helloFeatures', () => {
  it('an old relay (max 20) takes the hello while the bridge sends 20 or fewer, and refuses a 21st', () => {
    expect(OldHello.safeParse(hello(helloFeatures(today, null))).success).toBe(true)
    expect(OldHello.safeParse(hello(helloFeatures(names(30), null))).success).toBe(true) // cut to 20
    expect(helloFeatures(names(30), null)).toEqual(names(20)) // the first ones: most important first
    expect(OldHello.safeParse(hello(names(21))).success).toBe(false) // why the cut exists
    expect(HelloBridgeFrame.safeParse(hello(names(21))).success).toBe(true)
  })

  it(`sends up to ${FEATURES_MAX} only to a relay that listed ${WIDE_FEATURES_FEATURE}`, () => {
    expect(helloFeatures(names(30), STEP1)).toEqual(names(30))
    expect(helloFeatures(names(70), STEP1)).toHaveLength(FEATURES_MAX)
    expect(helloFeatures(names(30), ['bridge-standby/1'])).toHaveLength(FEATURES_MAX_V1)
  })

  it('leaves the retired ones out only for a relay that reads the marker, and the marker stands for them', () => {
    expect(helloFeatures(today, STEP1)).toEqual(today) // the relay of step 1 still checks them by name
    const two = helloFeatures(today, STEP2)
    expect(two[0]).toBe(FEATURES_IMPLIED_FEATURE)
    for (const f of IMPLIED_BRIDGE_FEATURES) {
      expect(two).not.toContain(f)
      expect(bridgeHasFeature(two, f)).toBe(true)
    }
    expect(two).toHaveLength(today.length - IMPLIED_BRIDGE_FEATURES.length + 1)
    expect(bridgeHasFeature([FEATURES_IMPLIED_FEATURE], 'f00/1')).toBe(false) // it implies only the retired ones
  })
})

describe('helloNeedsResend', () => {
  it('not for a first hello that already carries everything, by name', () => {
    expect(helloNeedsResend(today, helloFeatures(today, null), STEP2)).toBe(false)
    expect(helloNeedsResend(today, helloFeatures(today, null), STEP1)).toBe(false)
  })
  it('when the first hello was cut and the relay takes more', () => {
    expect(helloNeedsResend(names(30), helloFeatures(names(30), null), STEP1)).toBe(true)
    expect(helloNeedsResend(names(30), helloFeatures(names(30), null), [])).toBe(false) // an old relay: 20 is all it reads
  })
  it('when the hello leaned on the marker and this relay does not read it (a rollback)', () => {
    expect(helloNeedsResend(today, helloFeatures(today, STEP2), STEP1)).toBe(true)
    expect(helloNeedsResend(today, helloFeatures(today, STEP2), STEP2)).toBe(false)
  })
})
