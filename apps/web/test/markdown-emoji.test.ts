// :shortcode: emoji in message text. They turn into the emoji only in plain text; the output goes through the same
// markdown-it -> DOMPurify path as everything else, so a shortcode can never add markup.
import { describe, expect, it } from 'vitest'
import { revealHidden } from '../src/features/cards/util.ts'
import table from '../src/lib/emoji-shortcodes.json' with { type: 'json' }
import { expandShortcodes, renderMarkdown, sanitizeMarkdownHtml } from '../src/lib/markdown.ts'

const text = (src: string) => new DOMParser().parseFromString(renderMarkdown(src), 'text/html').body.textContent ?? ''

describe('emoji shortcodes in text', () => {
  it('renders known codes in a paragraph, a list item, a heading, bold and a table cell', () => {
    expect(text('ship it :rocket:')).toContain('ship it 🚀')
    expect(text('- done :white_check_mark:')).toContain('done ✅')
    expect(text('# Launch :tada:')).toContain('Launch 🎉')
    expect(text('**big :fire:**')).toContain('big 🔥')
    expect(text('| a |\n|---|\n| :+1: |')).toContain('👍')
    expect(text('- [x] :memo: notes')).toContain('☑ 📝 notes')
  })

  it('renders several in a row and in a multi-codepoint form', () => {
    expect(text(':tada::tada:')).toContain('🎉🎉')
    expect(text(':family_man_woman_girl_boy:')).toMatch(/👨‍👩‍👧‍👦/)
  })

  it('leaves an unknown code exactly as typed', () => {
    expect(text('hello :not_a_real_emoji: there')).toContain('hello :not_a_real_emoji: there')
    expect(text(':: ::: :a b:')).toContain(':: ::: :a b:')
  })

  it('leaves clock times, ratios and URLs with colons alone', () => {
    expect(text('at 10:30:45 sharp')).toContain('10:30:45')
    expect(text('ratio 1:2:3')).toContain('1:2:3')
    expect(text('key:value:other')).toContain('key:value:other')
  })

  it('a backslash keeps a code literal', () => {
    expect(text('\\:rocket:')).toContain(':rocket:')
    expect(text('\\:rocket:')).not.toContain('🚀')
  })

  it('treats object-prototype names as unknown', () => {
    for (const n of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(text(`:${n}:`)).toContain(`:${n}:`)
    }
  })

  it('does not render inside inline code, fenced code or indented code', () => {
    expect(text('use `:rocket:` here')).toContain(':rocket:')
    expect(text('use `:rocket:` here')).not.toContain('🚀')
    expect(text('```\n:rocket:\n```')).toContain(':rocket:')
    expect(text('```\n:rocket:\n```')).not.toContain('🚀')
    expect(text('    :rocket:')).not.toContain('🚀')
    expect(renderMarkdown('`:fire:`')).toContain('<code>:fire:</code>')
  })

  it('does not render inside link text, a link target, a bare URL or an autolink', () => {
    const a = renderMarkdown('[see :rocket: now](https://example.com/:fire:)')
    expect(a).toContain('see :rocket: now')
    expect(a).toContain('href="https://example.com/:fire:"')
    expect(a).not.toMatch(/🚀|🔥/u)
    expect(renderMarkdown('go to https://example.com/a:fire:b:smile: ok')).not.toMatch(/🔥|😄/u)
    expect(renderMarkdown('<https://example.com/:fire:>')).not.toMatch(/🔥/u)
    // outside the link, on the same line, it still renders
    expect(text('[a](https://x.example) :fire:')).toContain('a 🔥')
  })

  it('does not render inside an image alt, a math span or math source', () => {
    expect(renderMarkdown('![:fire:](https://example.com/a.png)')).not.toContain('🔥')
    expect(renderMarkdown('$x :fire: y$')).not.toContain('🔥')
    expect(renderMarkdown('$$\n:fire:\n$$')).not.toContain('🔥')
  })

  it('cannot add markup: the output is escaped text, and sanitizing it changes nothing', () => {
    const html = renderMarkdown('<b>:rocket:</b> & :tada: <script>:fire:</script>')
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelectorAll('script, b, img, svg').length).toBe(0)
    expect(html).toContain('🚀')
    expect(sanitizeMarkdownHtml(html)).toBe(html)
  })

  it('the vendored table holds only emoji text: no markup, no controls, no hidden characters', () => {
    const map: Record<string, string> = table
    const names = Object.keys(map)
    expect(names.length).toBeGreaterThan(1500)
    for (const k of ['smile', 'rocket', '+1', '-1', 'tada', 'white_check_mark', 'thumbsup'])
      expect(map[k], k).toBeTruthy()
    for (const [name, emoji] of Object.entries(map)) {
      expect(name, name).toMatch(/^[a-z0-9_+-]+$/)
      expect(emoji, name).not.toMatch(/[<>&"'`\\$[\]()]/)
      expect(emoji.length, name).toBeLessThanOrEqual(16)
      // card labels flag hidden characters; every table entry must pass that check untouched (joiners inside an emoji are ordinary)
      expect(revealHidden(emoji), name).toBe(emoji)
      expect(revealHidden(`a ${emoji} b`), name).toBe(`a ${emoji} b`)
    }
  })
})

describe('card labels are not touched', () => {
  it('still flag a hidden character, and do not expand shortcodes', () => {
    expect(revealHidden('Deploy :rocket: now')).toBe('Deploy :rocket: now')
    expect(revealHidden('Deploy‮evil')).toBe('Deploy⟦U+202E⟧evil')
    expect(revealHidden('ok​hidden :tada:')).toBe('ok⟦U+200B⟧hidden :tada:')
  })

  it('a hidden character beside a shortcode in message text is not turned into an emoji or hidden by it', () => {
    // markdown never un-hides anything: the control character stays in the text for the reader-side check
    expect(text(':ro​cket:')).not.toContain('🚀')
    expect(text(':rocket‮:')).not.toContain('🚀')
  })
  it('leaves IPv6 addresses and a code followed by a letter as typed', () => {
    expect(expandShortcodes('link fe80::ab:1 up')).toBe('link fe80::ab:1 up')
    expect(expandShortcodes('2001:db8::a:1')).toBe('2001:db8::a:1')
    expect(expandShortcodes('mode :on:off')).toBe('mode :on:off')
    expect(expandShortcodes(':tada::tada:')).not.toContain(':tada:')
  })
})
