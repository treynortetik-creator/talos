// A stopped relay leaves no timer of its own running, voice switched on included (the hourly usage sweep is armed 60 s
// after start and used to stay armed after stop()).
import { type Clock, realClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeVoiceProvider } from '../../src/voice/fake-provider.ts'
import { setVoiceProvider } from '../../src/voice/index.ts'
import { startTestRelay } from '../core/harness.ts'

afterEach(() => setVoiceProvider(null))

/** The real clock, counting the timers that have neither fired nor been cleared. */
function countingClock(): { clock: Clock; live: Set<unknown> } {
  const live = new Set<unknown>()
  const clock: Clock = {
    ...realClock,
    setTimeout: (fn, ms) => {
      const h = realClock.setTimeout(() => {
        live.delete(h)
        fn()
      }, ms)
      live.add(h)
      return h
    },
    clearTimeout: (h) => {
      live.delete(h)
      realClock.clearTimeout(h)
    },
  }
  return { clock, live }
}

describe('stopping the relay', () => {
  for (const voice of [false, true]) {
    it(`leaves no timer running (voice ${voice ? 'on' : 'off'})`, async () => {
      if (voice) setVoiceProvider(new FakeVoiceProvider())
      const { clock, live } = countingClock()
      const t = await startTestRelay({ clock })
      expect(live.size, 'something is armed while the relay runs').toBeGreaterThan(0)
      await t.stopKeepData()
      expect(live.size).toBe(0)
    })
  }
})
