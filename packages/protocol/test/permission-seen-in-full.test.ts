// Owner's rule (2026-11-05, 23:57): "If I can see what the approval is for, I should be able to approve anything from my phone."
// A permission card is Allow-able whenever the whole call can be SHOWN: hidden, bidi, wide, non-ASCII and padded text is shown
// as markers or as it is, never refused for its looks. Since 2026-11-13 a call Claude Code itself cut or hid, one with a
// redacted part, or one past MAX_SHOWN keeps Allow too, with a note naming what is not shown; a card that is not exactly what
// the bridge composed still has no Allow.
import { describe, expect, it } from 'vitest'
import {
  cardNotice,
  composePermissionCard,
  PERMISSION_NOTICE_MAX_CHARS,
  PERMISSION_TAIL_CHARS,
  permissionCallTail,
  permissionCardAllowsPrimary,
  permissionHiddenReasons,
  permissionHiddenWarning,
} from '../src/index.ts'

const cp = (n: number) => String.fromCodePoint(n)
const NOW = Date.parse('2026-10-28T15:00:00.000Z')
const card = (preview: string, description = 'd', tool = 'Bash') =>
  composePermissionCard({
    request: { request_id: 'abcde', tool_name: tool, description, input_preview: preview },
    card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4E0',
    thread_id: 'general',
    now: NOW,
    client_version: '2.1.312',
  })

describe('seen in full means approvable', () => {
  it('CJK, emoji, accents, wide and padded text keep Allow, shown as they are', () => {
    for (const text of [
      '漢字 rm -rf',
      'ls \u{1F600}',
      'echo café',
      'x'.repeat(5000),
      `a${cp(0x1d159).repeat(9000)}b`,
    ]) {
      const c = card(text)
      expect(permissionCardAllowsPrimary(c), text.slice(0, 12)).toBe(true)
      expect(c.warning).toBeUndefined()
    }
  })
  it('hidden and bidi characters are shown as [U+XXXX] markers in the call, the summary and the title, and Allow stays', () => {
    const c = card('a‮b', 'x​y', 'T⁦')
    expect(c.body).toBe('a[U+202E]b')
    expect(c.fields[0]?.value).toBe('x[U+200B]y')
    expect(c.title).toBe('Allow T[U+2066]?')
    expect(permissionCardAllowsPrimary(c)).toBe(true)
  })
  it('a combining-mark run is shown mark by mark', () => {
    expect(card(`e${cp(0x301).repeat(5)}`).body).toBe(`e${'[U+0301]'.repeat(5)}`)
  })
  it('the long padded probes keep Allow: the owner scrolls through them in the approval sheet', () => {
    for (const text of [
      `git status${' .'.repeat(5000)}; rm -rf ~`,
      `${'a'.repeat(15000)}; rm -rf ~`,
      `git status${cp(0x303f).repeat(9000)}; rm -rf ~`,
    ])
      expect(permissionCardAllowsPrimary(card(text))).toBe(true)
  })
})

describe('a call that cannot be shown whole keeps Allow, with a note; a card the bridge did not compose has none', () => {
  const reasons = (p: string, d = 'd') =>
    permissionHiddenReasons({ request_id: 'abcde', tool_name: 'Bash', description: d, input_preview: p })
  it('a call Claude Code cut, elided, redacted or could not serialise', () => {
    expect(reasons('{"command": "ls ⋯ 20 code points elided ⋯ x"}')).toContain('elided')
    expect(reasons('{"command": "ls ...…')).toContain('truncated')
    expect(reasons('{"token": "[REDACTED]"}')).toContain('redacted')
    expect(reasons('{"x": (value unserializable)}')).toContain('unserializable')
    for (const p of ['{"command": "ls ⋯ 20 code points elided ⋯ x"}', '{"token": "[REDACTED]"}']) {
      const c = card(p)
      expect(permissionCardAllowsPrimary(c), p).toBe(true)
      expect(c.warning, p).toBe(permissionHiddenWarning(reasons(p)))
    }
  })
  it('a call past MAX_SHOWN (the card could not hold it whole)', () => {
    const c = card('y'.repeat(25_000))
    expect(
      permissionHiddenReasons({
        request_id: 'abcde',
        tool_name: 'Bash',
        description: 'd',
        input_preview: 'y'.repeat(25_000),
      }),
    ).toContain('too_long')
    expect(permissionCardAllowsPrimary(c)).toBe(true)
    expect(c.warning).toBe(permissionHiddenWarning(['too_long']))
    expect(c.body).toBe('y'.repeat(20_000))
  })
  it('a card that is not exactly what the bridge composed: an edited body, summary or title is refused', () => {
    const c = card('rm -rf /srv/x')
    expect(permissionCardAllowsPrimary(c)).toBe(true)
    expect(permissionCardAllowsPrimary({ ...c, body: 'rm -rf /srv/y' })).toBe(false)
    expect(permissionCardAllowsPrimary({ ...c, title: 'Allow Read?' })).toBe(false)
    expect(
      permissionCardAllowsPrimary({ ...c, fields: [{ ...(c.fields[0] as object), value: 'something else' } as never] }),
    ).toBe(false)
  })
})

describe('the tail line', () => {
  it('shows the last characters of a short call whole, and of a long one behind an ellipsis', () => {
    expect(permissionCallTail('rm -rf /srv/x')).toBe('rm -rf /srv/x')
    const t = permissionCallTail(`${'a'.repeat(500)}; rm -rf ~`)
    expect(t.endsWith('; rm -rf ~')).toBe(true)
    expect([...t].length).toBe(PERMISSION_TAIL_CHARS + 1)
  })
  it('a hidden character in the tail shows as a marker, never as nothing', () => {
    expect(permissionCallTail(`ls ${cp(0x202e)}~ fr- mr`)).toBe('ls [U+202E]~ fr- mr')
  })
})

describe('a notification offers Approve only for a call it can show whole', () => {
  const notice = (preview: string) => cardNotice({ ...card(preview), summary: undefined } as never)
  it('a short one-line call is approvable from the notification', () => {
    expect(notice('rm -rf /srv/x').complete).toBe(true)
  })
  it('a call over the notice limit shows Open (it goes to the approval sheet)', () => {
    expect(notice('x'.repeat(PERMISSION_NOTICE_MAX_CHARS)).complete).toBe(true)
    expect(notice('x'.repeat(PERMISSION_NOTICE_MAX_CHARS + 1)).complete).toBe(false)
  })
  it('a call with a visible line break glyph shows Open', () => {
    expect(notice('echo a⏎echo b').complete).toBe(false)
    expect(notice('echo a\necho b').complete).toBe(false)
  })
  it('a call with a part not shown keeps Allow in the app but opens the app from a notification (no room for the note)', () => {
    expect(permissionCardAllowsPrimary(card('{"token": "[REDACTED]"}'))).toBe(true)
    expect(notice('{"token": "[REDACTED]"}').complete).toBe(false)
  })
})
