import { describe, expect, it } from 'vitest'
import {
  buildAsk,
  FALLBACK_WINDOW_MS,
  QUESTION_MAX_CHARS,
  TAIL_TURNS,
  type Utterance,
} from '../../src/features/voice/question.ts'

const u = (who: 'owner' | 'agent', text: string, at: number): Utterance => ({ who, text, at })

describe('buildAsk', () => {
  it('uses what the owner said since the previous delegation', () => {
    const r = buildAsk({
      utterances: [
        u('owner', 'old topic', 100),
        u('agent', 'ok', 150),
        u('owner', 'what is on', 300),
        u('owner', 'my plate', 310),
      ],
      lastDelegationAt: 200,
      now: 400,
    })
    expect(r.question).toBe('what is on my plate')
    expect(r.transcriptTail.map((t) => t.who)).toEqual(['owner', 'agent', 'owner', 'owner'])
  })

  it('falls back to the last 60 s when nothing is newer than the previous delegation', () => {
    const now = 1_000_000
    const r = buildAsk({
      utterances: [u('owner', 'too old', now - FALLBACK_WINDOW_MS - 1), u('owner', 'recent', now - 5_000)],
      lastDelegationAt: now - 1_000,
      now,
    })
    expect(r.question).toBe('recent')
  })

  it('is empty when the owner said nothing', () => {
    expect(buildAsk({ utterances: [u('agent', 'hello', 1)], lastDelegationAt: null, now: 2 }).question).toBe('')
  })

  it('keeps the last 20 turns, trims each, and caps the question keeping its end', () => {
    const many = Array.from({ length: 30 }, (_, i) => u(i % 2 ? 'agent' : 'owner', `t${i}`, i))
    expect(buildAsk({ utterances: many, lastDelegationAt: null, now: 31 }).transcriptTail).toHaveLength(TAIL_TURNS)
    const long = buildAsk({ utterances: [u('owner', `${'a'.repeat(5000)}END`, 1)], lastDelegationAt: null, now: 2 })
    expect(long.question).toHaveLength(QUESTION_MAX_CHARS)
    expect(long.question.endsWith('END')).toBe(true)
    expect(
      buildAsk({ utterances: [u('agent', 'x'.repeat(2000), 1)], lastDelegationAt: null, now: 2 }).transcriptTail[0]
        ?.text,
    ).toHaveLength(1000)
  })
})
