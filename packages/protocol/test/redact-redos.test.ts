// redact() runs on the relay's bug webhook, so a hostile 20,000-character report must not cost seconds: one adversarial input per
// rule that can backtrack, each under 300 ms.
import { describe, expect, it } from 'vitest'
import { redact } from '../src/redact.ts'

const N = 20_000
// the limit is for an ordinary machine; a slow one (scripts/gate.sh sets TALOS_TEST_TIME_FACTOR) gets proportionally more. Read the
// same way as packages/testkit/src/time-factor.ts, which protocol cannot import (testkit depends on protocol).
const factor = (() => {
  const n = Number(process.env.TALOS_TEST_TIME_FACTOR)
  return Number.isFinite(n) && n >= 1 ? n : 1
})()
const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n)
const inputs: Record<string, (n: number) => string> = {
  'dots after a secret word': (n) => rep('token.', n),
  'a secret word repeated': (n) => rep('token', n),
  digits: (n) => rep('1', n),
  'dotted letters': (n) => rep('a.', n),
  'password dotted': (n) => rep('password.', n),
  'dashes and dots': (n) => rep('-.', n),
  'URL with many @': (n) => `a://:${rep('x@', n)}`,
  'URL with many colons': (n) => `a://${rep('b:', n)}`,
  'cookie with stray quotes': (n) => `Cookie: ${rep('a"b', n)}`,
  'authorization with quotes': (n) => `Authorization: Basic ${rep('"x\'', n)}`,
  'unclosed quoted secret': (n) => `token="${rep('a', n)}`,
  'many quoted secrets': (n) => rep('token="token="', n),
  'query names': (n) => `?${rep('client_', n)}`,
  'query secret words': (n) => `?${rep('token_', n)}=1`,
  'aws line': (n) => `AKIAABCDEFGHIJKLMNOP ${rep('a/', n)}`,
  'password flag': (n) => `--password ${rep('-', n)}`,
  'bearer run': (n) => `Bearer ${rep('a,', n)}`,
  'query dotted name with sig': (n) => `?${rep('a.b_sig.', n)}`,
  'query name with client_key': (n) => `?${rep('a_client_key.', n)}`,
  'query many ampersands': (n) => rep('&a.b_sig.', n),
  'query dashes': (n) => `?${rep('a-', n)}`,
  'dashes only': (n) => rep('-', n),
  'password name, dotted': (n) => rep('a.password', n),
  'aws line, runs then =': (n) => `AKIAIOSFODNN7EXAMPLE ${rep(`${'a'.repeat(45)} =`, n)}`,
  'aws line, one long run': (n) => `AKIAIOSFODNN7EXAMPLE ${rep('a', n)}`,
  'URL, digits then ?': (n) => `a://u:${rep('1?', n)}`,
  'long name before a keyword': (n) => `${rep('X', n)}_TOKEN=`,
  'unclosed quote, many words': (n) => `token="${rep('w ', n)}`,
}

describe('redact stays fast on adversarial input', () => {
  // twice the size too: a regex that is only a little super-linear passes at 20,000 and fails at 40,000
  for (const size of [N, 2 * N]) {
    for (const [name, build] of Object.entries(inputs)) {
      it(`${name} (${size} chars) in under ${300 * factor} ms`, () => {
        const text = build(size)
        const t0 = performance.now()
        redact(text)
        expect(performance.now() - t0).toBeLessThan(300 * factor)
      })
    }
  }
})
