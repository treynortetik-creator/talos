// The bridge words a schedule conflict for its host ("changed on your Mac", "on your computer" on Linux, "on your PC" on
// Windows: apps/bridge/src/schedules/service-cards.ts). The web read only "your Mac", so off a Mac the conflict card
// never showed and the line fell through to "Couldn't save · Ask to retry" (e2e schedules.spec on Linux, 2026-11-14).
import type { CardT } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { collapseLine } from '../../src/features/cards/logic.ts'
import { isConflict } from '../../src/features/schedules/Proposal.tsx'

const card = (text: string) => ({ kind: 'schedule', state: 'failed', result: { ok: false, text } }) as unknown as CardT

describe('a schedule conflict, worded for any host', () => {
  for (const [host, place] of [
    ['mac', 'Mac'],
    ['linux', 'computer'],
    ['windows', 'PC'],
  ] as const) {
    const text = `The job changed on your ${place} after this card was drawn. Nothing was saved. Ask again.`
    it(`${host}: is a conflict, and the collapsed line says so in the host's words`, () => {
      expect(isConflict(card(text))).toBe(true)
      expect(collapseLine(card(text), { agent: 'Talos', nowMs: 0, host })).toBe(
        `⚠ The job changed on your ${place} before you approved. Nothing was saved.`,
      )
    })
  }
  it('another failure is not a conflict', () => {
    expect(isConflict(card('The scheduler no longer accepts this change as drawn.'))).toBe(false)
  })
})
