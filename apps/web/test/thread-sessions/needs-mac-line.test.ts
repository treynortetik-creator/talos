// D48: the worker is already stopped when it reports needs_mac, so the line must not say a question is "waiting".
import { describe, expect, it } from 'vitest'
import { WORKER_ERROR_TEXT, workerLine } from '../../src/features/thread-sessions/store.ts'

describe('needs_mac line', () => {
  it('says it stopped, that only the Mac can answer, and where to answer', () => {
    const line = WORKER_ERROR_TEXT.needs_mac
    expect(line).toMatch(/stopped/i)
    expect(line).toMatch(/only the Mac can answer/)
    expect(line).toMatch(/Talos Terminal/)
    expect(line).toMatch(/Thread sessions/)
    expect(line).not.toMatch(/is waiting/i)
  })
  it('is what a failed worker with that error shows', () => {
    const w = { thread_id: 'a', state: 'failed', error: 'needs_mac' } as Parameters<typeof workerLine>[0]
    expect(workerLine(w)).toBe(WORKER_ERROR_TEXT.needs_mac)
  })
})

describe('a session refused for being wider than main', () => {
  it('says it was not started and what to do, not "Needs attention"', () => {
    const w = { thread_id: 'a', state: 'failed', error: 'mode_escalation_denied' } as Parameters<typeof workerLine>[0]
    expect(workerLine(w)).toMatch(/not started/)
    expect(workerLine(w)).toMatch(/more access than the main session/)
  })
})

describe('a failure this version does not know', () => {
  it('reads as a stop with no reason it can name, and where to look', () => {
    const w = { thread_id: 'a', state: 'failed', error: 'unknown' } as Parameters<typeof workerLine>[0]
    expect(workerLine(w)).toBe(WORKER_ERROR_TEXT.unknown)
    expect(workerLine(w)).toMatch(/stopped/)
    expect(workerLine(w)).toMatch(/Talos Terminal/)
  })
})
