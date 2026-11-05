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
