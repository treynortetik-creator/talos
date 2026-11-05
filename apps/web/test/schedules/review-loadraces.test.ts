// Re-review of PR #97 at 54c2cb9, finding H2 (the app half; apps/bridge/test/schedules/review-loadraces.test.ts is the bridge
// half). FAILS at 54c2cb9: a Chronos that did not answer gets the install screen, or "no jobs", never "didn't answer".
import { describe, expect, it } from 'vitest'
import { emptyKind } from '../../src/features/schedules/logic.ts'
import { VARIANTS } from './variants.ts'

const noAnswer = (state: 'not_installed' | 'error') => {
  const s = VARIANTS.empty()
  return {
    ...s,
    health: {
      ...s.health,
      state,
      issues: [
        {
          code: 'adapter_timeout',
          severity: 'warn',
          text: "The scheduler didn't answer in time (the Mac may be busy).",
          fix: null,
          schedule_id: null,
          since: s.as_of,
        },
      ],
    },
  } as ReturnType<typeof VARIANTS.empty>
}

describe('a scheduler that did not answer', () => {
  it('H2: what the bridge sends at 54c2cb9 never shows the install screen', () => {
    expect(emptyKind(noAnswer('not_installed'), null)).not.toBe('not_installed')
  })
  it('H2: the fixed bridge state (error, no jobs) says the Mac did not answer, not "no jobs"', () => {
    expect(emptyKind(noAnswer('error'), null)).toBe('no_answer')
  })
})
