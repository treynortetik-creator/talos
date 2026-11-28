// Real words for a browser push: the thread name and a one-line preview, inside the limits the service worker's parser has.
import { describe, expect, it } from 'vitest'
import {
  buildPushPayload,
  normalizeNoticeText,
  PUSH_BODY_MAX,
  PUSH_TITLE_MAX,
  PushPayload,
  redactLinkCodes,
  richContentFor,
  withPushWords,
} from '../src/index.ts'

const cfg = {
  agent: { name: 'Talos' },
  notifications: { show_thread_names: 'all' as const },
  threads: [{ id: 'general', name: 'General', kind: 'fixed' as const }],
}
const reply = () => buildPushPayload({ template: 'reply', thread_id: 'general', app_badge: 2 }, cfg)

describe('withPushWords', () => {
  it('puts the thread name in the title and the reply in the body, and the result is still a valid payload', () => {
    const p = withPushWords(reply(), { thread: 'General', text: 'The build passed.' })
    expect(p.notification).toMatchObject({ title: 'General', body: 'The build passed.', navigate: '/t/general' })
    expect(PushPayload.safeParse(p).success).toBe(true)
  })

  it('keeps the agent name as the title when there is no thread name to show', () => {
    expect(withPushWords(reply(), { text: 'hello' }).notification).toMatchObject({ title: 'Talos', body: 'hello' })
  })

  it('makes the preview one line, cut inside the body limit with an ellipsis, and the title inside its limit', () => {
    const p = withPushWords(reply(), { thread: 'T'.repeat(200), text: `first line\n\n  second ${'word '.repeat(100)}` })
    expect(p.notification.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX)
    expect(p.notification.body.startsWith('first line second word')).toBe(true)
    expect(p.notification.body.endsWith('…')).toBe(true)
    expect(p.notification.body).not.toMatch(/\n/)
    expect(p.notification.title.length).toBeLessThanOrEqual(PUSH_TITLE_MAX)
    expect(PushPayload.safeParse(p).success).toBe(true)
  })

  it('never splits an emoji when it cuts, and stays inside the limit counted the way the schema counts', () => {
    const p = withPushWords(reply(), { text: '\u{1F600}'.repeat(200) })
    expect(p.notification.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX)
    expect(PushPayload.safeParse(p).success).toBe(true)
    expect([...p.notification.body.replace('…', '')].every((c) => c === '\u{1F600}')).toBe(true)
  })

  it('hides passwords, bearer tokens and keys, as the full redactor does', () => {
    const p = withPushWords(reply(), {
      text: 'Login is password: hunter2 and the header is Authorization: Bearer abcDEF123456789 and API_KEY=sk_live_abcdef123456',
    })
    for (const secret of ['hunter2', 'abcDEF123456789', 'sk_live_abcdef123456'])
      expect(p.notification.body, secret).not.toContain(secret)
  })

  it('hides a link code that a line break splits from its colon, because it flattens before it redacts', () => {
    const p = withPushWords(reply(), { text: 'here: talos-link:\nhost.example.com/conn/SECRETTOKEN ok' })
    expect(p.notification.body).not.toContain('SECRETTOKEN')
    const joined = withPushWords(reply(), { text: 'talos-link:host.example.com/conn/\u200DSECRETTOKEN' })
    expect(joined.notification.body).not.toContain('SECRETTOKEN')
  })

  it('drops emoji joiners and variation selectors instead of marking them, and still marks other hidden characters', () => {
    const p = withPushWords(reply(), { text: '\u26A0\uFE0F Build failed \u{1F468}\u200D\u{1F4BB} \u2764\uFE0F' })
    expect(p.notification.body).not.toMatch(/U\+FE0F|U\+200D/)
    expect(p.notification.body).toBe('\u26A0 Build failed \u{1F468}\u{1F4BB} \u2764')
    expect(withPushWords(reply(), { text: 'a\u200Bb' }).notification.body).toContain('[U+200B]')
  })

  it('never cuts inside a flag, a combined accent or a [U+XXXX] marker, whatever the length before it', () => {
    const lone = (b: string) => [...b].filter((c) => /\p{Regional_Indicator}/u.test(c)).length % 2
    for (let pad = 70; pad < 80; pad++) {
      const filler = 'ab '.repeat(30).slice(0, pad).trimEnd().padEnd(pad, 'b') // not one repeated character: the redactor hides a long run of those
      const flags = withPushWords(reply(), { text: `${filler}\u{1F1FA}\u{1F1F8}\u{1F1FA}\u{1F1F8}` }).notification.body
      expect(lone(flags), `flag at ${pad}`).toBe(0)
      const accent = withPushWords(reply(), { text: `${filler}e\u0301e\u0301` }).notification.body
      expect(accent, `accent at ${pad}`).not.toMatch(/e\u2026$/)
      expect(accent.length).toBeLessThanOrEqual(PUSH_BODY_MAX)
    }
    for (let pad = 66; pad < 80; pad++) {
      const b = withPushWords(reply(), { text: `${'ab '.repeat(Math.floor(pad / 3))}\u200B\u200B\u200B x` })
        .notification.body
      expect(b.length).toBeLessThanOrEqual(PUSH_BODY_MAX)
      expect(b.replace(/\[U\+[0-9A-F]{4}\]/g, '')).not.toMatch(/\[U|U\+|\+2/)
    }
  })

  it('keeps the shared link-code redactor strict, so the card text a phone signs a hash of is unchanged', () => {
    const text = 'Send the draft; talos-link: is the scheme, then talos-link:\nNext paragraph'
    expect(redactLinkCodes(text)).toBe(text)
    expect(richContentFor({ kind: 'card', text }).b).toBe(normalizeNoticeText(text))
    expect(redactLinkCodes('talos-link:host.example.com/c/TOKEN')).toBe('talos-link:[redacted]')
  })

  it('shows hidden and direction-changing characters, and hides a link code', () => {
    const p = withPushWords(reply(), { text: 'a‮b talos-link:host.example.com/abc/secrettoken' })
    expect(p.notification.body).toContain('U+202E')
    expect(p.notification.body).not.toContain('‮')
    expect(p.notification.body).not.toContain('secrettoken')
  })

  it('asks to be heard again, because the banner it replaces had other words', () => {
    expect(withPushWords(reply(), { text: 'hi' }).notification.renotify).toBe(true)
  })

  it('leaves the fixed text alone when there are no words, and for anything that is not a reply', () => {
    expect(withPushWords(reply(), { text: ' \n\t ' })).toEqual(reply())
    const card = buildPushPayload(
      { template: 'needs_you', thread_id: 'general', card_id: 'c_01JABCDEFGHJKMNPQRSTVWXYZ0' },
      cfg,
    )
    expect(withPushWords(card, { text: 'approve me' })).toEqual(card)
  })
})
