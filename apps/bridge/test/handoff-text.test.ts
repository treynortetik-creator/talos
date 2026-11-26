import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { handoffTool } from '../src/tools/handoff.ts'
import { HANDOFF_DAILY_LIMIT } from '../src/worker/handoff.ts'

// The text the agent reads must state the real daily budget, taken from the constant and never typed out again.
describe('handoff tool text states the daily budget', () => {
  test('description and instructions name the constant', () => {
    expect(handoffTool.description).toContain(`${HANDOFF_DAILY_LIMIT} a day`)
    expect(handoffTool.instructions).toContain(`${HANDOFF_DAILY_LIMIT} a day`)
  })
  test('the number is not typed out in the tool source', () => {
    const src = readFileSync(new URL('../src/tools/handoff.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/\b\d+ a day/)
  })
})
