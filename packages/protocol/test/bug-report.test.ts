// The bug report wire shapes (src/bug-report.ts and `bug.context` in frames.ts): strict, capped, and the read is a signed owner frame.
import { describe, expect, it } from 'vitest'
import {
  BUG_REPORT_LIMITS,
  BugReportBody,
  BugReportPost,
  frameSchemas,
  OWNER_FRAME_TYPES,
  V2_READ_OWNER_FRAME_TYPES,
  V2_READ_RESPONSE_FOR,
} from '../src/index.ts'

const body = {
  what_went_wrong: 'It broke',
  versions: { app: '1', bridge: '1', relay: '1', claude_code: '2' },
  recent_errors: [],
  logs: '',
}
const ulid = '01HZX0000000000000000000AA'
const post = {
  v: 1,
  type: 'bug.report',
  device_id: 'd_abcdefghijklmnopqrst',
  id: ulid,
  ts: '2026-11-10T00:00:00.000Z',
  nonce: 'a'.repeat(24),
  report: body,
  image_type: 'image/png',
  image_b64: 'AAAA',
  osig: 'A'.repeat(86),
}

describe('BugReportBody', () => {
  it('needs the words and nothing else extra: unknown keys are refused', () => {
    expect(BugReportBody.safeParse(body).success).toBe(true)
    expect(BugReportBody.safeParse({ ...body, what_went_wrong: '' }).success).toBe(false)
    expect(BugReportBody.safeParse({ ...body, path: '/home/alex' }).success).toBe(false)
  })
  it('caps every field', () => {
    const long = (n: number) => 'x'.repeat(n + 1)
    expect(BugReportBody.safeParse({ ...body, what_went_wrong: long(BUG_REPORT_LIMITS.whatChars) }).success).toBe(false)
    expect(BugReportBody.safeParse({ ...body, logs: long(BUG_REPORT_LIMITS.logChars) }).success).toBe(false)
    expect(
      BugReportBody.safeParse({ ...body, recent_errors: Array(BUG_REPORT_LIMITS.errors + 1).fill('e') }).success,
    ).toBe(false)
    expect(
      BugReportBody.safeParse({
        ...body,
        messages: Array(BUG_REPORT_LIMITS.messages + 1).fill({ role: 'you', text: 'hi' }),
      }).success,
    ).toBe(false)
  })
})

describe('BugReportPost', () => {
  it('is one signed object; an unsigned one, a wrong type and an extra key are refused', () => {
    expect(BugReportPost.safeParse(post).success).toBe(true)
    expect(BugReportPost.safeParse({ ...post, osig: undefined }).success).toBe(false)
    expect(BugReportPost.safeParse({ ...post, image_type: 'text/html' }).success).toBe(false)
    expect(BugReportPost.safeParse({ ...post, extra: 1 }).success).toBe(false)
  })
})

describe('bug.context', () => {
  it('is a signed owner read answered by bug.context_result, with 1..200 lines', () => {
    expect(V2_READ_OWNER_FRAME_TYPES).toContain('bug.context')
    expect(OWNER_FRAME_TYPES).toContain('bug.context')
    expect(V2_READ_RESPONSE_FOR['bug.context']).toBe('bug.context_result')
    const env = { v: 1, id: ulid, ts: '2026-11-10T00:00:00.000Z', type: 'bug.context', request_id: ulid }
    const owner = { device_id: 'd_abcdefghijklmnopqrst', osig: 'A'.repeat(86) }
    const s = frameSchemas['bug.context']
    expect(s.safeParse({ ...env, lines: 200, ...owner }).success).toBe(true)
    expect(s.safeParse({ ...env, lines: 201, ...owner }).success).toBe(false)
    expect(s.safeParse({ ...env, lines: 0, ...owner }).success).toBe(false)
    expect(s.safeParse({ ...env, lines: 5 }).success).toBe(false) // unsigned
  })
})
