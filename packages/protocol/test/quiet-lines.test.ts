// The last lines of a quiet session's pane, shown in the app under the "has been quiet" notice: at most 3 lines of 100 characters, every one
// passed through the shared redact() (and an email mask, which redact has not got) before it leaves the supervisor and again before the bridge
// sends it. The lines ride an ephemeral frame, never the notice, so nothing here is stored or pushed.
import { describe, expect, it as test } from 'vitest'
import { parseFrame } from '../src/frames.ts'
import { newId, newUlid } from '../src/ids.ts'
import {
  PANE_LINE_CHARS,
  PANE_LINES_MAX,
  QUIET_LINES_FEATURE,
  QuietLinesFrame,
  sanitizePaneLines,
} from '../src/quiet-lines.ts'

const GH = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`
const ANT = `sk-ant-api03-${'Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe'}`

describe('sanitizePaneLines', () => {
  test('tokens, keys, link codes, passwords in a URL and emails never survive', () => {
    const out = sanitizePaneLines([
      `export GITHUB_TOKEN=${GH}`,
      `key ${ANT} was used`,
      'open talos-link:https://relay.example/abc/def_ghi-jkl',
      'git clone https://bob:hunter2@example.com/repo.git',
      'mail me at alex+work@example.com please',
      `authorization: Bearer ${GH}`,
    ])
    const all = out.join('\n')
    expect(all).not.toContain(GH)
    expect(all).not.toContain(ANT)
    expect(all).not.toContain('abc/def_ghi-jkl')
    expect(all).not.toContain('hunter2')
    expect(all).not.toContain('alex+work')
    expect(all).not.toContain('alex+work@example.com')
    expect(all).toContain('[email]')
    expect(out.length).toBeLessThanOrEqual(PANE_LINES_MAX)
  })

  test('a secret across the 100-character cut is redacted BEFORE the cut, never half shown', () => {
    const line = `${'x '.repeat(45)}token=${GH} tail`
    const out = sanitizePaneLines([line])[0] as string
    expect(out).not.toContain(GH.slice(0, 12))
    expect([...out].length).toBeLessThanOrEqual(PANE_LINE_CHARS)
  })

  test('at most 3 lines, the LAST three, each at most 100 characters', () => {
    const rows = Array.from({ length: 8 }, (_, i) => `row ${i} ${'word '.repeat(40)}`)
    const out = sanitizePaneLines(rows)
    expect(out).toHaveLength(3)
    expect(out.map((l) => l.slice(0, 5))).toEqual(['row 5', 'row 6', 'row 7'])
    for (const l of out) expect([...l].length).toBeLessThanOrEqual(100)
  })

  test('control and invisible characters go, blank rows and non-strings are dropped, whitespace is collapsed', () => {
    const out = sanitizePaneLines(['  a\u001b[31mb\tc  ', '', '   ', 42 as never, 'd‮e', 'ok  fine'])
    expect(out).toEqual(['a[31mb c', 'de', 'ok fine'])
    const bad = (c: number) => c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e)
    for (const l of out) expect([...l].some((ch) => bad(ch.codePointAt(0) ?? 0))).toBe(false)
  })

  test('not an array, or an empty one: no lines', () => {
    expect(sanitizePaneLines(undefined)).toEqual([])
    expect(sanitizePaneLines('nope')).toEqual([])
    expect(sanitizePaneLines([])).toEqual([])
  })
})

const GH2 = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`
const PAT = `github_pat_${'11AABBCCD0abcdEFGHijklMN_o9p8Q7r6S5t4U3v2W1x0Y9z8A7b6C5d4E3f2G1h0I9j8K7l6M5n4O3p2Q1r'}`
/** Any run of `n` characters of `secret` showing in `out`: a half of it is still a leak. */
const leaks = (out: string[], secret: string, n = 10) => {
  const all = out.join('\n')
  for (let i = 0; i + n <= secret.length; i++) if (all.includes(secret.slice(i, i + n))) return secret.slice(i, i + n)
  return null
}

describe('a secret wrapped across rows (Ink wraps at the pane width)', () => {
  test('a ghp_ token split at EVERY position across two rows shows no part of it', () => {
    for (let cut = 6; cut < GH2.length - 4; cut++) {
      const out = sanitizePaneLines(['something before', GH2.slice(0, cut), GH2.slice(cut)])
      expect(leaks(out, GH2), `cut at ${cut}`).toBeNull()
    }
  })

  test('a github_pat_ token over three rows shows no part of it', () => {
    for (const [a, b] of [
      [40, 80],
      [30, 70],
      [45, 85],
    ] as const) {
      const out = sanitizePaneLines([PAT.slice(0, a), PAT.slice(a, b), PAT.slice(b)])
      expect(leaks(out, PAT), `rows ${a}/${b}`).toBeNull()
    }
  })

  test('a long run of token characters at the start or the end of a row is masked, even when nothing else marks it', () => {
    const out = sanitizePaneLines([
      'see k8d2Jx0Qe7Lw9Zr3Tn5Vb1Ya6Uc4Hf8M== and',
      'then Zr3Tn5Vb1Ya6Uc4Hf8Mk8d2Jx0Qe7Lw9',
    ])
    expect(out.join('\n')).not.toContain('k8d2Jx0Qe7Lw9Zr3')
    expect(out.join('\n')).not.toContain('Zr3Tn5Vb1Ya6Uc4Hf8M')
  })

  test('ordinary rows next to each other are left alone', () => {
    expect(sanitizePaneLines(['Reading the file', 'Running the tests', 'All 12 passed'])).toEqual([
      'Reading the file',
      'Running the tests',
      'All 12 passed',
    ])
  })
})

describe('an invisible character inside a token does not split it', () => {
  test('a zero-width space, a soft hyphen and a bidi mark in the middle of a token', () => {
    for (const mark of ['​', '­', '‮', '﻿']) {
      const split = `${GH2.slice(0, 20)}${mark}${GH2.slice(20)}`
      const out = sanitizePaneLines([`token ${split} end`])
      expect(leaks(out, GH2), JSON.stringify(mark)).toBeNull()
    }
  })

  test('a tab or a new line is still a space', () => {
    expect(sanitizePaneLines(['a\tb\nc'])).toEqual(['a b c'])
  })
})

describe('what the shared redact() does not know', () => {
  test('a password after -p with no space (mysql), after PGPASSWORD with a space, and "passphrase is: x"', () => {
    const out = sanitizePaneLines([
      'mysql -u root -phunter2 mydb',
      'export PGPASSWORD hunter2',
      'the passphrase is: hunter2',
      'password is hunter2',
    ])
    expect(out.join('\n')).not.toContain('hunter2')
    expect(out.length).toBe(3)
  })

  test('a lone AWS secret key (40 base64 characters with a slash) is masked', () => {
    const out = sanitizePaneLines(['AWS_SECRET wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'])
    expect(out.join('\n')).not.toContain('wJalrXUtnFEMI')
  })

  test('a private key: every row from BEGIN through END is dropped; with no END visible, everything after BEGIN', () => {
    const body = [
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAA',
      'AAtzc2gtZWQyNTUxOQAAACD1Zk3w9c',
      'xyz',
    ]
    const whole = sanitizePaneLines([
      'before',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      ...body,
      '-----END OPENSSH PRIVATE KEY-----',
      'after',
    ])
    expect(whole).toEqual(['before', 'after'])
    const open = sanitizePaneLines(['before', '-----BEGIN RSA PRIVATE KEY-----', ...body])
    expect(open).toEqual(['before'])
  })

  test('a private key whose BEGIN has scrolled off: its last base64 line is masked by the edge rule', () => {
    const out = sanitizePaneLines(['xyz', 'AAAAB3NzaC1yc2EAAAADAQABAAABAQC7vbqajDw4o6gJy8UtmIbkcpNBZ1e3Zk=='])
    expect(out.join('\n')).not.toContain('AAAAB3NzaC1yc2E')
  })
})

describe('the quiet.lines frame', () => {
  const ok = {
    v: 1,
    id: newUlid(),
    ts: new Date().toISOString(),
    type: 'quiet.lines',
    message_id: newId('m'),
    thread_id: 'trip',
    lines: ['a', 'b', 'c'],
  }
  test('3 lines parse; 4 lines or a very long line do not', () => {
    expect(QuietLinesFrame.safeParse(ok).success).toBe(true)
    expect(QuietLinesFrame.safeParse({ ...ok, lines: ['a', 'b', 'c', 'd'] }).success).toBe(false)
    expect(QuietLinesFrame.safeParse({ ...ok, lines: ['x'.repeat(401)] }).success).toBe(false)
  })

  test('it goes bridge to relay to the app, and no other way (an app or the relay cannot send it to the bridge)', () => {
    const raw = { ...ok }
    expect(parseFrame(raw, { direction: 'bridge_to_relay' }).ok).toBe(true)
    expect(parseFrame(raw, { direction: 'relay_to_app' }).ok).toBe(true)
    expect(parseFrame(raw, { direction: 'app_to_relay' }).ok).toBe(false)
    expect(parseFrame(raw, { direction: 'relay_to_bridge' }).ok).toBe(false)
  })

  test('the feature name', () => {
    expect(QUIET_LINES_FEATURE).toBe('quiet-lines/1')
  })
})

describe('a private key whose BEGIN is out of view', () => {
  test('an END line with no BEGIN before it drops every row before it, and itself', () => {
    expect(sanitizePaneLines(['tail9Qx+/a', 'Zm9v==', '-----END OPENSSH PRIVATE KEY-----'])).toEqual([])
    expect(sanitizePaneLines(['an earlier line', 'tail9Qx+/a', '-----END RSA PRIVATE KEY-----', 'after'])).toEqual([
      'after',
    ])
  })

  test('a whole key in the window is still dropped, and what is before its BEGIN stays', () => {
    expect(
      sanitizePaneLines(['before', '-----BEGIN RSA PRIVATE KEY-----', 'abc', '-----END RSA PRIVATE KEY-----', 'after']),
    ).toEqual(['before', 'after'])
  })
})

describe('real paths and words at the edge of a row stay readable', () => {
  test('paths, an Edited row and a Claude Code tool row are not masked', () => {
    const rows = [
      'Running the tests in apps/bridge/test/supervisor',
      'Edited packages/protocol/test/quiet-lines2',
      '/home/alex/projects/talos2/apps/bridge',
      '● Update(apps/bridge/src/router/quiet-wiring.ts)',
    ]
    expect(sanitizePaneLines(rows)).toEqual(rows.slice(-3))
    expect(sanitizePaneLines(rows.slice(0, 1))).toEqual(rows.slice(0, 1))
  })

  test('a long mixed run with no path shape at an edge is still masked (a wrapped token or a key line)', () => {
    const out = sanitizePaneLines([
      'k8d2Jx0Qe7Lw9Zr3Tn5Vb1Ya6Uc4Hf8M==',
      'AAAAB3NzaC1yc2EAAAADAQABAAABAQC7vbqajDw4o6gJy8UtmIbkcpNBZ1e3Zk==',
    ])
    expect(out.join('\n')).not.toContain('k8d2Jx0Qe7Lw9')
    expect(out.join('\n')).not.toContain('AAAAB3NzaC1yc2E')
  })
})

describe('a secret inside a slash-joined run is not taken for a path', () => {
  const AWS = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  test.each([
    ['inside a longer slash run', `key/${AWS}`, 'wJalrXUtnFEMI'],
    ['with a slash and more after it', `${AWS}/x`, 'bPxRfiCYEXAMPLE'],
    ['after a path', `/home/alex/${AWS}`, 'K7MDENG'],
    ['split into mixed segments', 'abcDEF1234/ghiJKL5678/mnoPQR9012/stuVWX3456', 'ghiJKL5678'],
    ['behind a token prefix segment', 'ghp/a1B2c3D4e5F6/g7H8i9J0k1L2/m3N4o5P6q7R8', 'a1B2c3D4e5F6'],
    [
      'an S3 style path with an AKIA id',
      's3/AKIAIOSFODNN7EXAMPLE/wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'bPxRfiCYEXAMPLE',
    ],
  ])('%s is masked', (_why, row, piece) => {
    for (const shown of [row, `see ${row}`, `${row} and more words`]) {
      expect(sanitizePaneLines([shown]).join('\n'), shown).not.toContain(piece)
    }
  })

  test('real paths stay readable', () => {
    for (const row of [
      'Running the tests in apps/bridge/test/supervisor',
      'Edited packages/protocol/test/quiet-lines2',
      '/home/alex/projects/talos2/apps/bridge',
      '● Update(apps/bridge/src/router/quiet-wiring.ts)',
      'Read apps/web/src/features/threads/QuietLines.tsx',
    ])
      expect(sanitizePaneLines([row]), row).toEqual([row])
  })
})
