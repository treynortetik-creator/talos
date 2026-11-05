// docs/SECURITY.md must describe setup-code sign-in (native Mac and iPhone shells, WP-N0) the way the relay really behaves.
// Each claim below is pinned to a relay test, so the wording cannot drift from the code without one of the two going red.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const security = readFileSync(join(root, 'docs/SECURITY.md'), 'utf8').replace(/\s+/g, ' ')
const relayTest = (name: string) =>
  readFileSync(
    join(
      root,
      name.startsWith('v6fu')
        ? 'apps/bridge/test'
        : name.startsWith('auth-')
          ? 'apps/web/test'
          : 'apps/relay/test/auth',
      name,
    ),
    'utf8',
  )

// [what the doc must say, a phrase that proves it, the relay test title that backs it]
const claims: Array<[string, RegExp, string, string]> = [
  [
    'a setup code alone buys an unpinned session that reaches only pairing',
    /setup code for an unpinned session/i,
    'enroll-session.test.ts',
    'the minted session cannot reach any data route before pinning',
  ],
  [
    'the Mac still asks y/N, so a leaked code alone pins nothing',
    /leaked code alone cannot pin a device/i,
    'enroll-session.test.ts',
    'code -> session -> 403 device_not_pinned -> device/verify -> the Mac pins -> 200',
  ],
  [
    'signing in again on a pinned device needs its private key (proof of possession)',
    /proof of possession/i,
    'enroll-session.test.ts',
    'a signature from any other key is refused, counts as a failure, and the nonce is spent',
  ],
  [
    'one session per code: a second call replaces the first',
    /one session per code/i,
    'enroll-session.test.ts',
    'a second call with the same live code deletes the first session and mints a new one',
  ],
  [
    'five wrong codes from anyone burn every unused code, shells included',
    /five wrong codes from anyone burn every unused code, native apps included/i,
    'enroll-session.test.ts',
    'five bad codes in 10 minutes burn every outstanding code',
  ],
  [
    'a session from a burned code can never pin',
    /session made from a burned code can never pin/i,
    'n0-review.test.ts',
    'P5: a session minted from a code that is then burned',
  ],
  [
    'a device made this way has no passkey: its record holds no credential id',
    /its record holds no credential id/i,
    'n0-review.test.ts',
    'P6: the "setup-code" sentinel never lands in the device registry',
  ],
  [
    'a wrong device proof burns the code it was sent with',
    /wrong device proof burns the code it was sent with/i,
    'n0-recheck.test.ts',
    'five wrong proofs on a held code burn the owner other codes AND the leaked one',
  ],
  [
    'media.fetch is signed like a history read, so the relay cannot ask the Mac for a file on its own',
    /cannot ask the Mac for a file on its own/i,
    'v6fu-review.test.ts',
    'a signature over another media id, or from an unpinned key, uploads nothing',
  ],
  [
    'a shell with a leftover session trades the new code for a fresh session, so a new code is enough',
    /a new\s+code is enough/i,
    'auth-leftover-session.test.ts',
    'trades the new code for a fresh session BEFORE device/verify, and pairs',
  ],
  [
    'a failed read is never remembered as a used id',
    /never remembered as a used id/i,
    'v6fu-review.test.ts',
    'forged history.request and media.fetch frames add no seen_ids rows; a valid one adds exactly one',
  ],
]

describe('docs/SECURITY.md: setup-code sign-in', () => {
  for (const [claim, phrase, file, title] of claims) {
    it(`says: ${claim}`, () => {
      expect(security).toMatch(phrase)
    })
    it(`is backed by a relay test: ${title}`, () => {
      const src = relayTest(file)
      const at = src.indexOf(title)
      expect(at, 'the test title exists').toBeGreaterThan(-1)
      // It must be opened by a plain it( or test( : a skipped, todo or conditional test proves nothing.
      expect(src.slice(Math.max(0, at - 24), at)).toMatch(/\b(it|test)\(\s*['"`]$/)
    })
  }

  it('states the unsigned-row limit: a relay-written row can make the app sign a fetch for an id', () => {
    expect(security).toMatch(/Unsigned rows can steer which old files the app asks for/i)
  })

  it('names the step-up limit and labels it an inference, not a tested claim', () => {
    expect(security).toMatch(/step-up on a native app[\s\S]{0,1200}INFERENCE/i)
    expect(security).toMatch(/no passkey bound to it, so[\s\S]{0,120}accept any passkey/i)
    expect(security).toMatch(/shell most likely cannot produce an assertion/i)
  })
})
