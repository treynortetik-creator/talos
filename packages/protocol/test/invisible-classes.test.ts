// Unlisted invisible code points are what a padded command hides behind (permission-hook review R1-1): the shared invisible
// check catches whole classes, not a list, and the app's revealHidden is built from the same source.
import { describe, expect, it } from 'vitest'
import {
  cardNotice,
  composePermissionCard,
  INVISIBLE_OR_BIDI,
  permissionCardAllowsPrimary,
  permissionHiddenReasons,
  permissionVisibleText,
  visibleText,
} from '../src/index.ts'

const cp = (n: number) => String.fromCodePoint(n)
const card = (command: string) =>
  composePermissionCard({
    request: req(command),
    card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4E0',
    thread_id: 'general',
    now: Date.parse('2026-10-28T15:00:00.000Z'),
    client_version: '2.1.312',
  })
const req = (command: string) => ({
  request_id: 'abcde',
  tool_name: 'Bash',
  description: 'd',
  input_preview: JSON.stringify({ command }),
})

describe('invisible code points are hidden, by class', () => {
  it('whole classes: default-ignorable, format, unassigned, private-use and a lone surrogate', () => {
    for (const n of [
      0xe0080, 0xe01f0, 0x13430, 0xfffc, 0x3164, 0x2800, 0x115f, 0x1160, 0xffa0, 0x2064, 0x180e, 0xe000, 0xf0000,
      0x0378, 0xd800,
    ])
      expect(INVISIBLE_OR_BIDI.test(cp(n)), n.toString(16)).toBe(true)
  })
  it('more than three combining marks in a row is hidden; three, and ordinary text, are not', () => {
    const m = cp(0x301)
    expect(INVISIBLE_OR_BIDI.test(`e${m}${m}${m}${m}`)).toBe(true)
    expect(INVISIBLE_OR_BIDI.test(`e${m}${m}${m}`)).toBe(false)
    expect(INVISIBLE_OR_BIDI.test('café déjà vu, naïve 日本語 😀 ls -la')).toBe(false)
  })
  it('each is shown as a visible marker and the card keeps Allow: the owner sees every character (owner call)', () => {
    for (const n of [0xe0080, 0xe01f0, 0x13430, 0xfffc, 0x3164, 0x2800, 0x115f, 0x1160, 0xffa0]) {
      const c = card(`git status${cp(n)}; rm -rf ~`)
      expect(c.body, n.toString(16)).toContain(`[U+${n.toString(16).toUpperCase()}]`)
      expect(permissionCardAllowsPrimary(c), n.toString(16)).toBe(true)
    }
    // ANSI ESC as the raw character (a Bash command shown as text carries it unescaped)
    const esc = composePermissionCard({
      request: { ...req('x'), input_preview: `git status${cp(0x1b)}[2K; rm -rf ~` },
      card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4E0',
      thread_id: 'general',
      now: Date.parse('2026-10-28T15:00:00.000Z'),
      client_version: '2.1.312',
    })
    expect(esc.body).toContain('[U+001B]')
    expect(permissionCardAllowsPrimary(esc)).toBe(true)
    expect(permissionHiddenReasons(req('git status; ls'))).toEqual([])
  })
  it('visibleText shows every code point of a run, not just the first', () => {
    const m = cp(0x301)
    expect(visibleText(`e${m}${m}${m}${m}`)).toBe('e[U+0301][U+0301][U+0301][U+0301]')
  })
})

describe('exotic blanks are marked on a permission card only', () => {
  const exotic = [0xa0, 0x1680, 0x2000, 0x2003, 0x200a, 0x202f, 0x205f, 0x3000]
  it('permissionVisibleText shows each as its own marker, with the rest of the shared class and the odd controls', () => {
    for (const n of [...exotic, 0xfeff, 0x0b, 0x0c]) {
      const hex = n.toString(16).toUpperCase().padStart(4, '0')
      expect(permissionVisibleText(`a${cp(n)}b`), hex).toBe(`a[U+${hex}]b`)
    }
    expect(permissionVisibleText('a b')).toBe('a b')
    expect(permissionVisibleText('a\tb')).toBe('a\u21e5b')
  })
  it('visibleText and the shared class are exactly as before: a no-break space is left alone', () => {
    for (const n of exotic) {
      expect(visibleText(`a${cp(n)}b`), String(n)).toBe(`a${cp(n)}b`)
      expect(INVISIBLE_OR_BIDI.test(cp(n)), String(n)).toBe(false)
    }
  })
  it('a permission card marks a no-break space, while another card and its push text keep it as it was', () => {
    expect(card(`echo a${cp(0xa0)}b`).body).toContain('a[U+00A0]b')
    const other = {
      ...card('x'),
      kind: 'generic',
      title: 'Draft',
      summary: undefined,
      body: `Hi${cp(0xa0)}there&nbsp;`,
    } as never
    expect(cardNotice(other).text).toContain(`Hi${cp(0xa0)}there&nbsp;`)
  })
})
