import { bindingFrom, editedHash, payloadHash, verifyOwnerFrame } from '@talos-app/protocol'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CardDeepLink } from '../../src/features/cards/CardDeepLink.tsx'
import { collapseLine, editsFromDraft, isAltered, RESULT_OVERDUE_MS } from '../../src/features/cards/logic.ts'
import { LiveCard, makeCard, renderWith, setup } from './helpers.tsx'

const view = (card: ReturnType<typeof makeCard>) => <LiveCard id={card.id} />

afterEach(() => vi.useRealTimers())

describe('CardView: collapse lines', () => {
  const at = '2026-10-28T08:41:00.000Z'
  const res = (action: string) => ({ action, at, edited: false, payload_hash: 'sha256:x' })
  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      'done email',
      { state: 'done', resolution: res('primary'), result: { ok: true, text: 'Sent', at } },
      '✓ Sent 08:41',
    ],
    [
      'done publish',
      { kind: 'publish', state: 'done', resolution: res('primary'), result: { ok: true, text: 'ok', at } },
      '✓ Published 08:41',
    ],
    ['killed', { state: 'resolved', resolution: res('kill') }, '✕ Killed 08:41'],
    ['revise', { state: 'resolved', resolution: res('revise') }, '↻ Asked Talos to change it 08:41'],
    ['sending', { state: 'resolved', resolution: res('primary') }, '… Working on it 08:41'],
    ['expired', { state: 'expired' }, '⌛ Expired'],
    ['failed', { state: 'failed' }, "⚠ Couldn't send · Ask Talos to retry"],
    ['superseded', { state: 'superseded' }, '↻ Replaced by a newer draft'],
    [
      'done but result not ok',
      { state: 'done', resolution: res('primary'), result: { ok: false, text: 'bounced', at } },
      "⚠ Couldn't send · Ask Talos to retry",
    ],
  ]
  it.each(cases)('%s renders its collapse line and no buttons', (_n, over, line) => {
    // The clock sits ten minutes after the decision: an approval older than RESULT_OVERDUE_MS reads differently.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(at) + 10 * 60_000)
    const card = makeCard(over)
    const client = setup({ cards: [card] })
    renderWith(view(card), client)
    expect(screen.getByTestId('collapse-line').textContent).toBe(line)
    expect(screen.queryByRole('button', { name: card.primary_label })).toBeNull()
    expect(screen.queryByRole('button', { name: card.kill_label })).toBeNull()
  })

  it('an approved card whose result never comes says so once the wait is overdue, and says nothing wrong before', () => {
    const at = '2026-10-28T08:41:00.000Z'
    const card = makeCard({
      state: 'resolved',
      resolution: { action: 'primary', at, edited: false, payload_hash: 'sha256:x' },
    })
    const line = (afterMs: number) => collapseLine(card, { agent: 'Talos', nowMs: Date.parse(at) + afterMs })
    expect(line(RESULT_OVERDUE_MS)).toMatch(/^… Working on it/)
    expect(line(RESULT_OVERDUE_MS + 1)).toBe('⚠ No result reported yet · Ask Talos how it went')
    // a killed card never reads as waiting for a result, however old
    const killed = { ...card, resolution: { ...card.resolution!, action: 'kill' as const } }
    expect(collapseLine(killed, { agent: 'Talos', nowMs: Date.parse(at) + 100 * RESULT_OVERDUE_MS })).toMatch(
      /^✕ Killed/,
    )
  })

  it('a done card with no approval on record never says it was sent', () => {
    // A bare `done` (a replay the Mac refused carried no resolution once) must not read as a sent email.
    const bare = makeCard({ kind: 'email', state: 'done' })
    expect(collapseLine(bare, { agent: 'Talos', nowMs: Date.now() })).not.toMatch(/Sent/)
    const withResult = makeCard({
      kind: 'email',
      state: 'done',
      result: { ok: true, text: 'ok', at: '2026-10-28T08:41:00.000Z' },
    })
    expect(collapseLine(withResult, { agent: 'Talos', nowMs: Date.now() })).toMatch(/Sent/)
  })

  it('says only that an expired card expired, whether or not the Mac is offline: the phone cannot know what ran', () => {
    const card = makeCard({ state: 'expired' })
    const client = setup({ cards: [card], macOffline: true })
    renderWith(view(card), client)
    expect(screen.getByTestId('collapse-line').textContent).toBe('⌛ Expired')
  })

  it('collapseLine is null for a live pending card', () => {
    const card = makeCard()
    expect(collapseLine(card, { agent: 'Talos', nowMs: Date.parse('2026-10-28T16:00:00Z') })).toBeNull()
  })
})

describe('CardView: pending card', () => {
  it('shows destination rows, fields, body, warning, labels and the named kill target', () => {
    const card = makeCard({ warning: "Goes outside this app. Can't be unsent.", origin: 'background' })
    renderWith(view(card), setup({ cards: [card] }))
    expect(screen.getByText('events@example.com')).toBeTruthy()
    expect(screen.getByText('Re: Saturday booking')).toBeTruthy()
    expect(screen.getByTestId('card-body').textContent).toContain('thanks for holding the room')
    expect(screen.getByText(/Can't be unsent/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Kill draft' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    expect(screen.getByTestId('card-expiry').textContent).toMatch(/^Expires (\S+ )?\d\d:\d\d if untouched$/)
  })

  it('shows a live countdown inside the last 15 minutes', () => {
    const card = makeCard({ expires_at: new Date(Date.now() + 5 * 60_000 + 500).toISOString() })
    renderWith(view(card), setup({ cards: [card] }))
    expect(screen.getByTestId('card-expiry').textContent).toMatch(/^Expires in [45]:\d\d$/)
  })

  it('a long body previews and expands with Show all', async () => {
    const card = makeCard({ body: Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n') })
    renderWith(view(card), setup({ cards: [card] }))
    await userEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy()
  })

  it('shows the payload as pretty JSON under Details, collapsed until asked', async () => {
    const card = makeCard({ payload: { to: 'events@example.com', n: 1 } })
    renderWith(view(card), setup({ cards: [card] }))
    expect(screen.queryByTestId('card-details')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByTestId('card-details').textContent).toBe(
      JSON.stringify({ to: 'events@example.com', n: 1 }, null, 2),
    )
  })

  it('Kill sends card.resolve kill with the app-computed hash', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    renderWith(view(card), client)
    await userEvent.click(screen.getByRole('button', { name: 'Kill draft' }))
    await waitFor(() => expect(client.store.getState().cards[0]?.state).toBe('done'))
    const frame = client.sent.at(-1) as Record<string, unknown>
    expect(frame.type).toBe('card.resolve')
    expect(frame.action).toBe('kill')
    expect(frame.payload_hash).toBe(payloadHash(bindingFrom(card)))
  })

  it('primary on a low-risk card sends without step-up and collapses to "Sent"', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    const stepup = vi.spyOn(client, 'stepup')
    renderWith(view(card), client)
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByTestId('collapse-line').textContent).toMatch(/^✓ Sent/))
    expect(stepup).not.toHaveBeenCalled()
  })

  it('a high-risk primary runs the step-up first, then sends a verifiable card.resolve', async () => {
    const card = makeCard({ risk: 'high', kind: 'publish', primary_label: 'Publish', kill_label: 'Kill release notes' })
    const client = setup({ cards: [card] })
    const order: string[] = []
    const stepup = client.stepup.bind(client)
    client.stepup = async (p) => {
      order.push(`stepup:${p}`)
      expect(client.sent.some((f) => f.type === 'card.resolve')).toBe(false)
      return stepup(p)
    }
    renderWith(view(card), client)
    await userEvent.click(screen.getByRole('button', { name: /Publish/ }))
    await waitFor(() => expect(client.sent.some((f) => f.type === 'card.resolve')).toBe(true))
    expect(order).toEqual([`stepup:card:${card.id}`])
    const frame = client.sent.at(-1) as Record<string, unknown>
    expect(await verifyOwnerFrame(frame, await client.publicJwk())).toBe(true)
  })

  it('a failed step-up sends nothing and says so', async () => {
    const card = makeCard({ risk: 'high' })
    const client = setup({ cards: [card] })
    client.stepup = async () => {
      throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })
    }
    renderWith(view(card), client)
    await userEvent.click(screen.getByRole('button', { name: /Send/ }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/cancelled/i)
    expect(client.sent).toHaveLength(0)
  })

  it('revise sends the note and the card collapses', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    renderWith(view(card), client)
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Tell Talos what to change/ }))
    await userEvent.type(screen.getByRole('textbox', { name: /What should Talos change/ }), 'shorter please')
    await userEvent.click(screen.getByRole('button', { name: 'Send note' }))
    await waitFor(() => expect(screen.getByTestId('collapse-line').textContent).toMatch(/^↻ Asked Talos/))
    const frame = client.sent.at(-1) as Record<string, unknown>
    expect(frame.action).toBe('revise')
    expect(frame.note).toBe('shorter please')
  })

  it('a card that expires while the Face ID prompt is open is not sent, and says that about this tap only', async () => {
    const card = makeCard({ risk: 'high', expires_at: new Date(Date.now() + 60_000).toISOString() })
    const client = setup({ cards: [card] })
    client.stepup = async () => {
      // the owner takes longer than the card has: only the clock moves, the screen still shows it as live
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 120_000)
      return 'stepup-token'
    }
    renderWith(view(card), client)
    await userEvent.click(screen.getByRole('button', { name: /Send/ }))
    // an earlier tap, or another device, may already have approved it, so nothing is said about what ran
    expect((await screen.findByRole('alert')).textContent).toBe('This card expired, so this tap was not sent.')
    expect(client.sent.some((f) => f.type === 'card.resolve')).toBe(false)
  })

  it('maps a relay rejection to plain words', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    const { TalosClientError } = await import('../../src/lib/client.ts')
    client.resolveCard = async () => {
      throw new TalosClientError('card_expired')
    }
    renderWith(view(card), client)
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toBe('This card expired. Nothing ran.')
  })

  it("shows the relay's own message when a save fails with a code that has no wording of its own", async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    const { TalosClientError } = await import('../../src/lib/client.ts')
    client.resolveCard = async () => {
      throw new TalosClientError('internal', 'The subject is longer than 200 characters.')
    }
    renderWith(view(card), client)
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The subject is longer than 200 characters.')
  })

  it('says it did not hear back when the relay fails with a bare internal error (a deploy)', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    const { TalosClientError } = await import('../../src/lib/client.ts')
    client.resolveCard = async () => {
      throw new TalosClientError('internal')
    }
    renderWith(view(card), client)
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Didn't hear back. Check whether it ran before trying again.",
    )
  })

  // The relay's refusals keep their own words (test/socket-card-resolve.test.ts has the real client rejecting with them).
  it.each([
    ['card_not_pending', /^This card was already decided\.$/],
    ['card_hash_mismatch', /^This card changed after it was drafted\. Don't approve it\.$/],
    ['mac_offline', /Mac is offline\. Try again when it is back\.$/],
  ] as const)('a refused approval (%s) says so and leaves the card open to decide again', async (code, copy) => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    const { TalosClientError } = await import('../../src/lib/client.ts')
    client.resolveCard = async () => {
      throw new TalosClientError(code, 'from the client')
    }
    renderWith(view(card), client)
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(copy)
    expect(screen.queryByTestId('collapse-line')).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })

  // What the real client throws when the relay never answered (test/socket-card-resolve.test.ts): the phone only claims
  // "nothing was sent" when the frame never left it, and says nothing about the outcome otherwise. No special card state.
  it.each([
    [
      'no answer',
      (e: typeof import('../../src/lib/client.ts')) => new e.NoAnswerError('internal', 'Connection lost'),
      /^Didn't hear back\. Check whether it ran before trying again\.$/,
    ],
    [
      'offline',
      (e: typeof import('../../src/lib/client.ts')) => new e.NotSentError('internal', "You're offline."),
      /^You're offline\. Nothing was sent\.$/,
    ],
    [
      'device not confirmed',
      (e: typeof import('../../src/lib/client.ts')) =>
        new e.NotSentError('device_not_pinned', 'Waiting for your Mac to confirm this device.'),
      /^Waiting for your Mac to confirm this device\. Nothing was sent\.$/,
    ],
  ] as const)('an approval with %s says so, and the card stays as it was', async (_name, make, copy) => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    const errors = await import('../../src/lib/client.ts')
    client.resolveCard = async () => {
      throw make(errors)
    }
    renderWith(view(card), client)
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(copy)
    expect(screen.queryByTestId('collapse-line')).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Kill draft' })).toBeTruthy()
  })
})

describe('CardView: editing', () => {
  it('editing a field changes edited_hash and the primary button reads "Send edited"', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    renderWith(view(card), client)
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const article = screen.getByRole('article')
    expect(article.getAttribute('data-edited-hash')).toBeNull()
    const subject = screen.getByRole('textbox', { name: 'Subj' })
    await userEvent.clear(subject)
    await userEvent.type(subject, 'Re: Sunday booking')
    expect(screen.getByRole('button', { name: 'Send edited' })).toBeTruthy()
    const expected = editedHash(bindingFrom(card), { fields: [{ key: 'subject', value: 'Re: Sunday booking' }] })
    expect(article.getAttribute('data-edited-hash')).toBe(expected)
    expect(expected).not.toBe(card.payload_hash)
  })

  it('only editable fields get editors', async () => {
    const card = makeCard()
    renderWith(view(card), setup({ cards: [card] }))
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.queryByRole('textbox', { name: 'Cc' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Subj' })).toBeTruthy()
  })

  it('sends edited + edited_hash and the fake Mac accepts them', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    renderWith(view(card), client)
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const body = screen.getByRole('textbox', { name: 'Message body' })
    await userEvent.type(body, ' Thanks!')
    await userEvent.click(screen.getByRole('button', { name: 'Send edited' }))
    await waitFor(() => expect(client.store.getState().cards[0]?.resolution?.edited).toBe(true))
    const frame = client.sent.at(-1) as Record<string, unknown>
    expect(frame.payload_hash).toBe(payloadHash(bindingFrom(card)))
    expect(frame.edited_hash).toBe(
      editedHash(bindingFrom(card), { fields: [], body: 'Hi, thanks for holding the room. Thanks!' }),
    )
  })

  it('a card that does not allow edits has no Edit button', () => {
    const card = makeCard({ allow_edit: false })
    renderWith(view(card), setup({ cards: [card] }))
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('editsFromDraft ignores unchanged values and non-editable keys', () => {
    const card = makeCard()
    expect(
      editsFromDraft(card, { fields: { subject: card.fields[0]?.value ?? '', cc: 'x' }, body: card.body }),
    ).toBeNull()
    expect(editsFromDraft(card, { fields: { cc: 'x' }, body: undefined })).toBeNull()
    expect(editsFromDraft(card, { fields: { subject: 'New' }, body: undefined })).toEqual({
      fields: [{ key: 'subject', value: 'New' }],
    })
  })
})

describe('CardView: expiry and tampering', () => {
  it('an expired card shows no buttons', () => {
    const card = makeCard({ expires_at: '2020-01-01T00:00:00.000Z', created_at: '2019-12-31T00:00:00.000Z' })
    renderWith(view(card), setup({ cards: [card] }))
    expect(screen.getByTestId('collapse-line').textContent).toBe('⌛ Expired')
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })

  it('a card that expires while open loses its buttons', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const card = makeCard({ expires_at: new Date(Date.now() + 3000).toISOString() })
    renderWith(view(card), setup({ cards: [card] }))
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    await act(async () => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(screen.getByTestId('collapse-line').textContent).toMatch(/Expired/)
  })

  const tamper: Array<[string, (c: ReturnType<typeof makeCard>) => ReturnType<typeof makeCard>]> = [
    ['body', (c) => ({ ...c, body: 'Send the money to a different account.' })],
    ['warning', (c) => ({ ...c, warning: 'Nothing to worry about.' })],
    ['risk', (c) => ({ ...c, risk: 'high' as const })],
    ['a field label', (c) => ({ ...c, fields: c.fields.map((f, i) => (i === 0 ? { ...f, label: 'Cc' } : f)) })],
    ['the title', (c) => ({ ...c, title: 'Totally different title' })],
    ['a destination', (c) => ({ ...c, destination: [{ label: 'To', value: 'attacker@example.com' }] })],
    ['the primary label', (c) => ({ ...c, primary_label: 'Cancel' })],
  ]
  it.each(tamper)('a card whose %s changed after hashing renders the altered state with no buttons', async (_n, fn) => {
    const original = makeCard()
    const altered = fn(original)
    const client = setup({ cards: [altered] })
    const resolve = vi.spyOn(client, 'resolveCard')
    renderWith(view(altered), client)
    expect(isAltered(altered)).toBe(true)
    expect((await screen.findByRole('alert')).textContent).toBe("⚠ This card was altered in transit. Don't approve it.")
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(resolve).not.toHaveBeenCalled()
  })
})

describe('CardDeepLink', () => {
  it('scrolls to the card and highlights it for 1.2 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const card = makeCard()
    const client = setup({ cards: [card] })
    const { container } = renderWith(<CardDeepLink />, client, `/card/${card.id}`, '/card/:id')
    const article = () => container.querySelector('article') as HTMLElement
    expect(scroll).toHaveBeenCalled()
    expect(article().className).toContain('ring-2')
    await act(async () => {
      vi.advanceTimersByTime(1300)
    })
    expect(article().className).not.toContain('ring-2')
  })

  it('says so when the card is gone', () => {
    renderWith(<CardDeepLink />, setup(), '/card/c_01JBF3V7Q8K2M4N6P8R0S2T4ZZ', '/card/:id')
    expect(screen.getByText(/no longer here/)).toBeTruthy()
  })
})

describe('header', () => {
  it('names the kind and thread and shows the Needs-you status word', () => {
    const card = makeCard()
    renderWith(view(card), setup({ cards: [card] }))
    const article = screen.getByRole('article')
    expect(within(article).getByText(/Email · General/)).toBeTruthy()
    expect(within(article).getByText(/Needs you/)).toBeTruthy()
  })
})
