// The two rules behind the moment after a send (sendGuard.ts), on made-up times: a press is judged by when it was made, and a
// press handled just after the page was frozen may have been made during the freeze.
import { describe, expect, it } from 'vitest'
import { madeBy, SEND_GUARD_MS, swallows } from '../../src/features/composer/sendGuard.ts'

describe('swallows', () => {
  it('nothing before the buttons were ever shown', () => {
    expect(swallows(10, -1, 0)).toBe(false)
  })
  it('a press made before the buttons were on screen, however late it is handled', () => {
    expect(swallows(990, 1000, 0)).toBe(true)
  })
  it('a press within the moment after the Send press, and not after it', () => {
    expect(swallows(1000 + SEND_GUARD_MS - 1, 1100, 1000)).toBe(true)
    expect(swallows(1000 + SEND_GUARD_MS, 1100, 1000)).toBe(false)
  })
})

describe('madeBy', () => {
  it('a press stamped on a running page was made when stamped', () => {
    expect(madeBy(500, 501, [], 480, true)).toBe(500)
  })
  it('a press stamped as it is handled, during or just after a freeze, may have been made when the freeze began', () => {
    expect(madeBy(1210, 1211, [[20, 1200]], 1200, true)).toBe(20)
    expect(madeBy(1350, 1351, [[20, 1200]], 1340, true)).toBe(1350)
  })
  it('a freeze the page has not noted yet counts from its last note of running', () => {
    expect(madeBy(1223, 1224, [], 20, true)).toBe(20)
    expect(madeBy(1223, 1224, [], 20, false)).toBe(1223)
  })
  it('a stamp well before its handling is when the press was made, freeze or not (Chromium, Firefox)', () => {
    expect(madeBy(900, 1210, [[100, 1200]], 1200, true)).toBe(900)
    expect(madeBy(900, 1210, [], 100, true)).toBe(900)
  })
})
