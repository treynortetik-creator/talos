// Text an agent or an email put in a card can carry direction overrides and invisible characters. Every line the owner
// approves from must show them as visible tokens, never obey them: the summary, the body and the warning as much as the title.
import { bindingFrom, cardNotice, composePermissionCard, payloadHash } from '@talos-app/protocol'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CardView } from '../../src/features/cards/CardView.tsx'
import { revealHidden } from '../../src/features/cards/util.ts'
import { LiveCard, makeCard, renderWith, setup } from './helpers.tsx'

// Each of these reorders or hides text: right-to-left override, left-to-right isolate, zero-width space, word joiner,
// the Arabic letter mark, a byte-order mark, and a variation selector.
const RLO = '\u202E'
const TRICKS = ['‮', '⁦', '​', '⁠', '؜', '﻿', '️']

describe('hidden characters in a card', () => {
  it.each(['summary', 'body', 'warning'] as const)(
    '%s shows every direction and invisible character as a token',
    (field) => {
      const text = `Pay ${TRICKS.join('')}the invoice`
      const card = makeCard({ [field]: text })
      const { container } = renderWith(<CardView card={card} threadName="General" />, setup({ cards: [card] }))
      const shown = container.textContent ?? ''
      for (const t of TRICKS) expect(shown, `U+${t.charCodeAt(0).toString(16)} left raw in ${field}`).not.toContain(t)
      expect(shown).toContain('⟦U+202E⟧')
      expect(shown).toContain('⟦U+FEFF⟧')
      expect(shown).toContain('⟦U+2060⟧')
    },
  )

  it.each([
    ['live buttons', {}],
    ['a collapsed card', { state: 'failed' }],
    ['a card waiting on the Mac', { state: 'pending' }],
  ] as const)('button labels and the title on %s show tokens', (_n, over) => {
    const bad = `Go${TRICKS.join('')}now`
    const card = makeCard({
      ...over,
      title: bad,
      primary_label: bad,
      kill_label: bad,
      result: { ok: false, text: bad, at: '2026-10-28T08:41:00.000Z' },
    } as never)
    const { container } = renderWith(<CardView card={card} threadName="General" />, setup({ cards: [card] }))
    const shown = container.textContent ?? ''
    for (const t of TRICKS) expect(shown).not.toContain(t)
  })

  it('the Details pane shows a bound payload with tokens, not reversed', async () => {
    const card = makeCard({ payload: { account: '\u202E4321' } })
    renderWith(<CardView card={card} threadName="General" />, setup({ cards: [card] }))
    fireEvent.click(screen.getByRole('button', { name: /details/i }))
    const shown = screen.getByTestId('card-details').textContent ?? ''
    expect(shown).not.toContain('\u202E')
    expect(shown).toContain('⟦U+202E⟧')
  })

  it('a permission card shows them as tokens in its title, the call, the summary line and the reason', () => {
    const base = composePermissionCard({
      request: {
        request_id: 'abcde',
        tool_name: 'Bash',
        description: 'Run the tests',
        input_preview: '{"command": "ls"}',
      },
      card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4E0',
      thread_id: 'general',
      now: Date.parse('2026-10-28T15:00:00.000Z'),
      client_version: '2.1.312',
    })
    const edited = {
      ...base,
      title: `Allow${RLO} Bash?`,
      body: `rm${RLO} -rf`,
      warning: `Careful${RLO}now`,
      fields: base.fields.map((f) => (f.key === 'summary' ? { ...f, value: `Run${RLO}tests` } : f)),
    }
    const card = { ...edited, payload_hash: payloadHash(bindingFrom(edited)) } // a card that is as the Mac made it, not an altered one
    const { container } = renderWith(<LiveCard id={card.id} />, setup({ cards: [card] }))
    expect(container.textContent).not.toContain(RLO)
    expect(screen.getByRole('heading').textContent).toBe('Allow⟦U+202E⟧ Bash?')
    expect(screen.getByTestId('permission-call').textContent).toBe('rm⟦U+202E⟧ -rf')
    expect(screen.getByTestId('permission-summary').textContent).toContain('Run⟦U+202E⟧tests')
    expect(screen.getByRole('status').textContent).toContain('Careful⟦U+202E⟧now')
  })

  it('an altered card shows its title with the hidden characters as tokens too', () => {
    const card = { ...makeCard({ title: `Pay${RLO}bob` }), payload_hash: `sha256:${'0'.repeat(64)}` }
    const { container } = renderWith(<CardView card={card} threadName="General" />, setup({ cards: [card] }))
    expect(container.querySelector('[data-card-state="altered"]')).not.toBeNull()
    expect(container.textContent).not.toContain(RLO)
    expect(container.textContent).toContain('Pay⟦U+202E⟧bob')
  })

  it('an attachment name is covered too', () => {
    const card = makeCard({
      attachments: [
        {
          media_id: 'md_01J00000000000000000000000',
          kind: 'file',
          role: 'attachment',
          name: 'a\u202Egpj.exe',
          mime: 'application/octet-stream',
          size: 10,
          sha256: 'a'.repeat(64),
        },
      ] as never,
    })
    const { container } = renderWith(<CardView card={card} threadName="General" />, setup({ cards: [card] }))
    expect(container.textContent).not.toContain('‮')
  })

  it('ordinary line breaks and tabs in a body are kept', () => {
    const card = makeCard({ body: 'line one\n\tline two' })
    const { container } = renderWith(<CardView card={card} threadName="General" />, setup({ cards: [card] }))
    expect(container.querySelector('[data-testid="card-body"]')?.textContent).toBe('line one\n\tline two')
  })

  it('revealHidden leaves clean text alone and names each hidden character once', () => {
    expect(revealHidden('plain text, emoji \u{1F600}, שלום')).toBe('plain text, emoji \u{1F600}, שלום')
    expect(revealHidden('a‮b​c')).toBe('a⟦U+202E⟧b⟦U+200B⟧c')
  })

  it('the notification text for the same card already shows them (one rule on both surfaces)', () => {
    const card = makeCard({
      summary: `s${TRICKS.join('')}`,
      body: `b${TRICKS.join('')}`,
      warning: `w${TRICKS.join('')}`,
    })
    const { text } = cardNotice(card as never)
    for (const t of TRICKS) expect(text).not.toContain(t)
    expect(text).toContain('[U+202E]')
  })
})

describe('ordinary text with invisible parts is left alone', () => {
  const ENGLAND = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'
  const ORDINARY: Array<[string, string]> = [
    ['an emoji with its presentation selector', '\u26A0\uFE0F Deploy'],
    ['an emoji joined from two (woman technologist)', '\u{1F469}\u200D\u{1F4BB}'],
    ['a flag drawn from tag characters', `Team ${ENGLAND} won`],
    ['a Persian word with a zero-width non-joiner', '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645'],
    ['a Hebrew word ending in a right-to-left mark', '\u05E9\u05DC\u05D5\u05DD\u200F.'],
    ['Hebrew points joined by a grapheme joiner', '\u05D1\u05B0\u034F\u05BC'],
    ['a keycap', '1\uFE0F\u20E3 first'],
    ['pointed Hebrew ending in a right-to-left mark', '\u05E9\u05B8\u05C1\u05DC\u05D5\u05B9\u05DD\u200F'],
    ['a pointed Hebrew letter, a mark, then punctuation', '\u05E9\u05B8\u05C1\u200F.'],
    ['pointed Hebrew then a mark before more Hebrew', '\u05E9\u05B8\u05C1\u200F\u05DC\u05D5\u05DD'],
    [
      'Scotland and Wales flags',
      `${'\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'} ${'\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}'}`,
    ],
  ]
  it.each(ORDINARY)('%s', (_name, text) => {
    expect(revealHidden(text)).toBe(text)
    const card = makeCard({ summary: text })
    const { container } = renderWith(<CardView card={card} threadName="General" />, setup({ cards: [card] }))
    expect(container.textContent).not.toContain('\u27E6')
  })

  const ATTACKS: Array<[string, string, string]> = [
    ['a right-to-left override', 'Pay \u202Etxet', '\u27E6U+202E\u27E7'],
    ['an isolate', 'Pay \u2066Bob\u2069', '\u27E6U+2066\u27E7'],
    ['a zero-width space after an emoji', '\u26A0\u200B Deploy', '\u27E6U+200B\u27E7'],
    ['a non-joiner between Latin letters', 'pa\u200Cy', '\u27E6U+200C\u27E7'],
    ['a joiner between Latin letters', 'pa\u200Dy', '\u27E6U+200D\u27E7'],
    ['a joiner between an emoji and a letter', '\u{1F469}\u200Dx', '\u27E6U+200D\u27E7'],
    ['a selector after a letter', 'A\uFE0F', '\u27E6U+FE0F\u27E7'],
    ['tag characters with no flag', 'hi\u{E0067}\u{E007F}', '\u27E6U+E0067\u27E7'],
    ['a flag with no cancel tag', '\u{1F3F4}\u{E0067}\u{E0062}', '\u27E6U+E0067\u27E7'],
    ['a direction mark in Latin text', 'ab\u200Fcd', '\u27E6U+200F\u27E7'],
    ['a joiner mixed across scripts', 'a\u200C\u0645', '\u27E6U+200C\u27E7'],
    ['an override hidden in Persian text', '\u0645\u06CC\u202E\u062E', '\u27E6U+202E\u27E7'],
    ['a word joiner', 'pay\u2060ment', '\u27E6U+2060\u27E7'],
    [
      'a Hebrew point lets a right-to-left mark into Latin text (numbers swap)',
      'Wire to account \u05BD\u200F4417 1234\u200F\u05BD now',
      '\u27E6U+200F\u27E7',
    ],
    ['the same trick in a link-like field', '\u05BD\u200Fbank.com \u05BD\u200Fevil.com', '\u27E6U+200F\u27E7'],
    ['an Arabic letter mark after a Hebrew point', 'pay \u05BD\u061C4417', '\u27E6U+061C\u27E7'],
    [
      'a whole message hidden as a flag',
      `Hi Bob \u{1F3F4}\u{E0077}\u{E0069}\u{E0072}\u{E0065}\u{E0020}\u{E0039}\u{E0030}\u{E0030}\u{E0030}\u{E0020}\u{E0074}\u{E006F}\u{E0020}\u{E0061}\u{E0074}\u{E0074}\u{E0061}\u{E0063}\u{E006B}\u{E0065}\u{E0072}\u{E0020}\u{E006E}\u{E006F}\u{E0077}\u{E007F} thanks`,
      '\u27E6U+E0077\u27E7',
    ],
    ['a two-letter fake flag', '\u{1F3F4}\u{E0075}\u{E0073}\u{E007F}', '\u27E6U+E0075\u27E7'],
    [
      'a fake flag that starts like England',
      '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E0067}\u{E007F}',
      '\u27E6U+E0067\u27E7',
    ],
    ['an Arabic number sign (U+0600)', '\u0600 4417', '\u27E6U+0600\u27E7'],
    ['a Syriac abbreviation mark (U+070F) around numbers', '\u070F4417 1234\u070F', '\u27E6U+070F\u27E7'],
    ['an Arabic pound mark (U+0890)', 'x\u0890y', '\u27E6U+0890\u27E7'],
  ]
  it.each(ATTACKS)('%s is still shown as a token', (_name, text, token) => {
    const out = revealHidden(text)
    expect(out).toContain(token)
    const hidden = [...out].filter((c) =>
      /[\u0600-\u0604\u070F\u0890\u0891\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069]|\uFE0F|[\u{E0000}-\u{E007F}]/u.test(
        c,
      ),
    )
    // Whatever is left raw must be only the ordinary parts; these samples have none.
    expect(hidden).toEqual([])
  })

  it('the notification text is unchanged: it still shows these as [U+XXXX] (the Mac checks the same bytes)', () => {
    const card = makeCard({ summary: '\u26A0\uFE0F Deploy', body: `b ${'\u202E'}x` })
    const { text } = cardNotice(card as never)
    expect(text).toContain('\u26A0[U+FE0F] Deploy')
    expect(text).toContain('[U+202E]')
  })
})
