import { PROBLEM_LIMITS, Problem } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import {
  type CaptureEnv,
  CaptureThrottle,
  ownerReport,
  problemFromError,
  skipReason,
} from '../../src/features/problems/capture.ts'

const CANARY = 'CANARY-thread-words-9921'
const ORIGIN = 'https://app.example.com'
const env = (over: Partial<CaptureEnv> = {}): CaptureEnv => ({
  origin: ORIGIN,
  versions: { app: '1.2.3', protocol: '1' },
  device: 'browser',
  routes: ['home', 'thread'],
  now: () => Date.parse('2026-11-02T10:00:00.000Z'),
  ...over,
})

function errorWithStack(name: string, message: string, stack: string): Error {
  const e = new Error(message)
  e.name = name
  e.stack = `${name}: ${message}\n${stack}`
  return e
}

const OWN = `    at render (${ORIGIN}/assets/index-abc123.js:10:20)\n    at flush (${ORIGIN}/assets/vendor-def456.js:5:6)`

describe('problemFromError', () => {
  it('builds a valid report from a real thrown error, own frames only, no user folders', () => {
    let caught: unknown
    try {
      JSON.parse(`{"text": "${CANARY}"`)
    } catch (e) {
      caught = e
    }
    const p = problemFromError(caught, env())
    expect(Problem.safeParse(p).success).toBe(true)
    expect(p).toMatchObject({ source: 'web', kind: 'auto', name: 'SyntaxError', device: 'browser' })
    expect(p.routes).toEqual(['home', 'thread'])
    expect(JSON.stringify(p)).not.toContain(CANARY)
    expect(JSON.stringify(p)).not.toMatch(/\/Users\/|\/home\//)
  })

  it('canary corpus: no engine-quoted input survives, whichever way the message quotes it', () => {
    const messages = [
      `Unexpected token 'h', "${CANARY}"... is not valid JSON`,
      `"${CANARY}" is not valid JSON`,
      `Cannot read properties of undefined (reading '${CANARY}')`,
      `${CANARY} is not a function`.replace(CANARY, `obj["${CANARY}"]`),
      `Failed to execute 'postMessage': ${CANARY}@example.com`,
      `bad \`${CANARY}\``,
    ]
    for (const m of messages) {
      const p = problemFromError(errorWithStack('Error', m, OWN), env())
      expect(JSON.stringify(p), m).not.toContain(CANARY)
    }
  })

  it('maps frames to a path inside our build, keeping function, line and column', () => {
    const p = problemFromError(errorWithStack('TypeError', 'x is not a function', OWN), env())
    expect(p.frames[0]).toEqual({ fn: 'render', file: 'assets/index-abc123.js', line: 10, col: 20 })
    expect(p.frames).toHaveLength(2)
  })

  it('drops frames from another origin and keeps ours', () => {
    const stack = `    at inject (chrome-extension://abcdef/content.js:1:1)\n${OWN}`
    const p = problemFromError(errorWithStack('Error', 'boom', stack), env())
    expect(JSON.stringify(p.frames)).not.toContain('chrome-extension')
    expect(p.frames).toHaveLength(2)
  })

  it('a thrown string is reported by its type only (it can hold anything)', () => {
    const p = problemFromError(`secret note ${CANARY}`, env())
    expect(p.name).toBe('non-error string')
    expect(p.message).toBe('')
    expect(JSON.stringify(p)).not.toContain(CANARY)
  })

  it('same bug, same fingerprint across runs; a different bug differs', () => {
    const a = problemFromError(errorWithStack('TypeError', 'item 4 is missing', OWN), env())
    const b = problemFromError(errorWithStack('TypeError', 'item 97 is missing', OWN), env())
    const c = problemFromError(errorWithStack('RangeError', 'another thing', OWN), env())
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.fingerprint).not.toBe(c.fingerprint)
    expect(a.id).not.toBe(b.id)
  })

  it('caps the stack at the protocol number and marks it truncated', () => {
    const many = Array.from({ length: 80 }, (_, i) => `    at f${i} (${ORIGIN}/assets/a.js:${i + 1}:1)`).join('\n')
    const p = problemFromError(errorWithStack('Error', 'deep', many), env())
    expect(p.frames.length).toBeLessThanOrEqual(PROBLEM_LIMITS.stackFrames)
    expect(JSON.stringify(p.frames).length).toBeLessThanOrEqual(PROBLEM_LIMITS.stackBytes)
  })
})

describe('skipReason', () => {
  it('skips chunk errors, aborts, foreign-origin stacks and known browser noise', () => {
    expect(skipReason(new Error('Failed to fetch dynamically imported module: /assets/x.js'), ORIGIN)).toBe('chunk')
    expect(skipReason(new Error('Importing a module script failed.'), ORIGIN)).toBe('chunk')
    const abort = new Error('The user aborted a request.')
    abort.name = 'AbortError'
    expect(skipReason(abort, ORIGIN)).toBe('abort')
    expect(skipReason(errorWithStack('Error', 'boom', '    at x (chrome-extension://abc/c.js:1:1)'), ORIGIN)).toBe(
      'foreign',
    )
    expect(skipReason(errorWithStack('Error', 'boom', '    at x (https://cdn.example.net/lib.js:1:1)'), ORIGIN)).toBe(
      'foreign',
    )
    expect(skipReason(new Error('ResizeObserver loop completed with undelivered notifications.'), ORIGIN)).toBe('noise')
    expect(skipReason(new Error('Script error.'), ORIGIN)).toBe('noise')
    for (const m of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) {
      const net = new TypeError(m)
      net.stack = `TypeError: ${m}\n${OWN}`
      expect(skipReason(net, ORIGIN)).toBe('network')
    }
  })

  it('keeps our own errors, and a mixed stack with at least one own frame', () => {
    expect(skipReason(errorWithStack('Error', 'boom', OWN), ORIGIN)).toBeNull()
    const mixed = `    at x (chrome-extension://abc/c.js:1:1)\n${OWN}`
    expect(skipReason(errorWithStack('Error', 'boom', mixed), ORIGIN)).toBeNull()
    expect(skipReason('a string', ORIGIN)).toBeNull()
  })
})

describe('ownerReport', () => {
  it('keeps the owner words, never merges two, and previews what the crash screen attaches', () => {
    const a = ownerReport('I tapped Send', env())
    const b = ownerReport('I tapped Send', env())
    expect(a.kind).toBe('owner')
    expect(a.steps).toBe('I tapped Send')
    expect(a.fingerprint).not.toBe(b.fingerprint)
    const crash = ownerReport('it crashed', env(), errorWithStack('TypeError', `bad "${CANARY}"`, OWN))
    expect(crash.name).toBe('TypeError')
    expect(JSON.stringify(crash)).not.toContain(CANARY)
    expect(crash.steps).toBe('it crashed')
  })
})

describe('CaptureThrottle', () => {
  it('lets one per fingerprint through per 10 minutes, then again after; holds the rest and counts them', () => {
    let t = 0
    const th = new CaptureThrottle(() => t)
    expect(th.allow('aaaa')).toBe(true)
    for (let i = 0; i < 99; i++) expect(th.allow('aaaa')).toBe(false)
    expect(th.held).toBe(99)
    t += PROBLEM_LIMITS.samePerWindowMs - 1
    expect(th.allow('aaaa')).toBe(false)
    t += 2
    expect(th.allow('aaaa')).toBe(true)
  })

  it('stops at 20 a session whatever the fingerprints', () => {
    const th = new CaptureThrottle(() => 0)
    let ok = 0
    for (let i = 0; i < 30; i++) if (th.allow(`fp${i}`)) ok++
    expect(ok).toBe(PROBLEM_LIMITS.perSession)
    expect(th.held).toBe(10)
  })

  it('a clock that jumps back does not release the window early', () => {
    let t = 1_000_000
    const th = new CaptureThrottle(() => t)
    expect(th.allow('x')).toBe(true)
    t -= 5 * 60_000 // the clock stepped back
    expect(th.allow('x')).toBe(false)
  })
})
