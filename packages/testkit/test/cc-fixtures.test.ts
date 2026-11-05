// The permission-request fixtures follow the channels reference rules one by one; each says which hidden reasons the
// protocol must find. This pins protocol behaviour to the documented engine behaviour, not to the author's guesses.
import {
  composePermissionCard,
  PermissionRequestParams,
  permissionCardAllowsPrimary,
  permissionHiddenReasons,
} from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { permissionFixtures } from '../src/index.ts'

describe('permission request fixtures (channels reference)', () => {
  it('cover the documented cases', () => {
    const names = permissionFixtures.map((f) => f.name)
    for (const n of [
      'plain_bash',
      'no_description',
      'elided',
      'unserializable',
      'redacted',
      'legacy_cut',
      'repeated_id',
    ])
      expect(names).toContain(n)
  })
  for (const f of permissionFixtures) {
    it(`${f.name}: ${f.rule}`, () => {
      expect(PermissionRequestParams.safeParse(f.params).success).toBe(true)
      expect(permissionHiddenReasons(f.params).sort()).toEqual([...f.hidden].sort())
      const card = composePermissionCard({
        request: f.params,
        card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4D0',
        thread_id: 'general',
        now: Date.parse('2026-10-29T12:00:00.000Z'),
        repeated: f.repeated ?? false,
        client_version: '2.1.312',
      })
      expect(permissionCardAllowsPrimary(card)).toBe(f.allow)
    })
  }
})
