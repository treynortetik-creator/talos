// The shared table for `dialogVisibleText` (src/dialog-card.ts): input to expected output, hand-written. It is written to
// fixtures/needs-you/visible-text.json (UPDATE_NEEDS_YOU_FIXTURES=1), and the Mac app's Swift port (`DialogVisibleText`) is tested against
// that file, so the two cannot drift. Written with escapes so a reader sees every code point.
export type VisibleTextCase = { name: string; input: string; expected: string }

const m = (cp: string) => `\u27e6U+${cp}\u27e7`

export const VISIBLE_TEXT_CASES: VisibleTextCase[] = [
  { name: 'plain text is left alone', input: 'Yes, I trust this folder', expected: 'Yes, I trust this folder' },
  {
    name: 'letters, CJK and an emoji are left alone',
    input: 'caf\u00e9 \u65e5\u672c\u8a9e \u{1F600} ls -la',
    expected: 'caf\u00e9 \u65e5\u672c\u8a9e \u{1F600} ls -la',
  },
  { name: 'zero-width space', input: 'a\u200bb', expected: `a${m('200B')}b` },
  { name: 'right-to-left override', input: 'a\u202eb', expected: `a${m('202E')}b` },
  { name: 'arabic letter mark', input: 'a\u061cb', expected: `a${m('061C')}b` },
  { name: 'soft hyphen and byte order mark', input: 'a\u00adb\ufeff', expected: `a${m('00AD')}b${m('FEFF')}` },
  { name: 'escape', input: 'a\u001b[2Kb', expected: `a${m('001B')}[2Kb` },
  { name: 'a line break and a tab', input: 'l\none\t', expected: `l${m('000A')}one${m('0009')}` },
  { name: 'a C1 control', input: 'a\u0085b', expected: `a${m('0085')}b` },
  { name: 'line and paragraph separators', input: 'a\u2028b\u2029', expected: `a${m('2028')}b${m('2029')}` },
  { name: 'a tag character', input: 'a\u{e0041}b', expected: `a${m('E0041')}b` },
  { name: 'hangul filler and braille blank', input: 'a\u3164b\u2800', expected: `a${m('3164')}b${m('2800')}` },
  { name: 'a variation selector', input: 'a\ufe0f', expected: `a${m('FE0F')}` },
  {
    name: 'a joiner inside an emoji is shown too',
    input: '\u{1F469}\u200d\u{1F4BB}',
    expected: `\u{1F469}${m('200D')}\u{1F4BB}`,
  },
  { name: 'private use', input: 'a\ue000b', expected: `a${m('E000')}b` },
  { name: 'unassigned', input: 'a\u0378b', expected: `a${m('0378')}b` },
  { name: 'object replacement character', input: 'a\ufffcb', expected: `a${m('FFFC')}b` },
  { name: 'a format character outside the listed ranges', input: 'a\u{110bd}b', expected: `a${m('110BD')}b` },
  {
    name: 'the marker brackets are marked too',
    input: '\u27e6U+0041\u27e7',
    expected: `${m('27E6')}U+0041${m('27E7')}`,
  },
  { name: 'three combining marks are left alone', input: 'e\u0301\u0301\u0301', expected: 'e\u0301\u0301\u0301' },
  {
    name: 'four combining marks in a row are all shown',
    input: 'e\u0301\u0301\u0301\u0301',
    expected: `e${m('0301')}${m('0301')}${m('0301')}${m('0301')}`,
  },
  {
    name: 'a no-break space is an ordinary space on every card but a permission card',
    input: 'a\u00a0b',
    expected: 'a\u00a0b',
  },
]
