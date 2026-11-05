import { describe, expect, it } from 'bun:test'
import { INSTRUCTIONS } from '../src/bridge.ts'

describe('agent instructions: threads (CC C4)', () => {
  it('answers in the thread a message came from', () => {
    expect(INSTRUCTIONS).toMatch(/Threads are topics/)
    expect(INSTRUCTIONS).toMatch(/Reply in the thread a message came from/)
  })
  it('routes proactive messages by topic and never dumps into General', () => {
    expect(INSTRUCTIONS).toMatch(/list_threads/)
    expect(INSTRUCTIONS).toMatch(/create_thread/)
    expect(INSTRUCTIONS).toMatch(/never (dump|default)[^.]*General/i)
    expect(INSTRUCTIONS).toMatch(/archive_thread/)
  })
  it('delegates multi-step thread work to a background subagent and posts its result in that thread', () => {
    expect(INSTRUCTIONS).toMatch(/hand [^.]*to a background subagent and post its result in that thread/)
  })
})
