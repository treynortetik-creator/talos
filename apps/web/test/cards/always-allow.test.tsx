// "Always allow" on a card (always-allow.ts, owner ruling 2026-11-14): a live card of a send kind, from a bridge that says
// ALWAYS_ALLOW_FEATURE, has a third button that approves this card and allows its kind from now on. The tap is one signed
// card.resolve with action 'primary' and always: true. Any other kind, or an older bridge, gets the card as before.
import { ALWAYS_ALLOW_FEATURE, bindingFrom, payloadHash, SEND_KINDS, verifyOwnerFrame } from '@talos-app/protocol'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ALWAYS_ALLOW_LABEL, errorCopy, OLDER_STEP_COPY, OPEN_IN_APP_COPY } from '../../src/features/cards/CardView.tsx'
import { TalosClientError } from '../../src/lib/client.ts'
import { HttpError } from '../../src/lib/http.ts'
import { LiveCard, makeCard, renderWith, setup } from './helpers.tsx'

const withFeature = (client: ReturnType<typeof setup>, on: boolean) =>
  client.store.setState((s) => {
    const rest = (s.presence.features ?? []).filter((f) => f !== ALWAYS_ALLOW_FEATURE)
    return { ...s, presence: { ...s.presence, features: on ? [...rest, ALWAYS_ALLOW_FEATURE] : rest } }
  })
const resolves = (c: ReturnType<typeof setup>) => c.sent.filter((f) => f.type === 'card.resolve')

const KIND_CARDS: Record<(typeof SEND_KINDS)[number], { primary_label: string; kill_label: string }> = {
  email: { primary_label: 'Send', kill_label: 'Kill draft' },
  message: { primary_label: 'Send', kill_label: 'Deny' },
  deploy: { primary_label: 'Deploy', kill_label: 'Deny' },
  push: { primary_label: 'Push', kill_label: 'Deny' },
  publish: { primary_label: 'Publish', kill_label: 'Deny' },
  purchase: { primary_label: 'Buy', kill_label: 'Deny' },
}

describe('Always allow on a card', () => {
  it('reads right for every send kind (a table, not a plural rule)', () => {
    expect(Object.keys(ALWAYS_ALLOW_LABEL).sort()).toEqual([...SEND_KINDS].sort())
    expect(ALWAYS_ALLOW_LABEL).toEqual({
      email: 'Always allow emails',
      message: 'Always allow messages',
      deploy: 'Always allow deploys',
      publish: 'Always allow publishing',
      purchase: 'Always allow purchases',
      push: 'Always allow pushing code',
    })
  })

  it.each(SEND_KINDS)('a %s card with the feature shows its verb, Always allow and the kill button', (kind) => {
    const card = makeCard({ kind, ...KIND_CARDS[kind] })
    const client = setup({ cards: [card] })
    withFeature(client, true)
    renderWith(<LiveCard id={card.id} />, client)
    expect(screen.getByRole('button', { name: KIND_CARDS[kind].primary_label })).toBeTruthy()
    expect(screen.getByRole('button', { name: ALWAYS_ALLOW_LABEL[kind] })).toBeTruthy()
    expect(screen.getByRole('button', { name: KIND_CARDS[kind].kill_label })).toBeTruthy()
  })

  it('without the feature (an older bridge) a send card is unchanged: no Always allow', () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    withFeature(client, false)
    renderWith(<LiveCard id={card.id} />, client)
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull()
  })

  it.each(['config', 'generic', 'schedule'])('a %s card never offers it, even with the feature', (kind) => {
    const card = makeCard({ kind, primary_label: 'Approve' })
    const client = setup({ cards: [card] })
    withFeature(client, true)
    renderWith(<LiveCard id={card.id} />, client)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull()
  })

  it('the tap sends one signed card.resolve: primary, always: true, the rendered hash', async () => {
    const card = makeCard({ risk: 'high', kind: 'purchase', ...KIND_CARDS.purchase })
    const client = setup({ cards: [card] })
    withFeature(client, true)
    renderWith(<LiveCard id={card.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Always allow purchases' }))
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    const frame = resolves(client)[0] as Record<string, unknown>
    expect(frame).toMatchObject({
      type: 'card.resolve',
      card_id: card.id,
      action: 'primary',
      always: true,
      payload_hash: payloadHash(bindingFrom(card)),
    })
    expect(frame).not.toHaveProperty('stepup_token')
    expect(await verifyOwnerFrame(frame, await client.publicJwk())).toBe(true)
    await waitFor(() => expect(screen.getByTestId('collapse-line').textContent).toMatch(/^✓/))
  })

  it('the plain verb still sends primary without always', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    withFeature(client, true)
    renderWith(<LiveCard id={card.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    expect(resolves(client)[0]).toMatchObject({ action: 'primary' })
    expect(resolves(client)[0]).not.toHaveProperty('always')
  })

  it('the kill button still kills, with no always', async () => {
    const card = makeCard({ kind: 'deploy', ...KIND_CARDS.deploy })
    const client = setup({ cards: [card] })
    withFeature(client, true)
    renderWith(<LiveCard id={card.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    expect(resolves(client)[0]).toMatchObject({ action: 'kill' })
    expect(resolves(client)[0]).not.toHaveProperty('always')
  })

  it('an expired card sends nothing from Always allow either', async () => {
    const card = makeCard({ expires_at: '2020-01-01T00:00:00.000Z' })
    const client = setup({ cards: [card] })
    withFeature(client, true)
    renderWith(<LiveCard id={card.id} />, client)
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull()
    expect(resolves(client)).toHaveLength(0)
  })
})

describe('card error copy', () => {
  it('open_in_app: a high-risk card answered from a notification', async () => {
    expect(errorCopy(new TalosClientError('open_in_app'), 'Talos', null)).toBe(
      'This card is approved in the app, not from a notification.',
    )
    expect(OPEN_IN_APP_COPY).toBe('This card is approved in the app, not from a notification.')
    const card = makeCard()
    const client = setup({ cards: [card] })
    client.resolveCard = async () => {
      throw new TalosClientError('open_in_app')
    }
    renderWith(<LiveCard id={card.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toBe(OPEN_IN_APP_COPY)
  })

  it.each([
    ['stepup_required on the socket', new TalosClientError('stepup_required')],
    ['stepup_invalid on the socket', new TalosClientError('stepup_invalid')],
    ['stepup_invalid over HTTP', new HttpError(403, undefined, { error: 'stepup_invalid' })],
  ])('an older relay or Mac (%s) is read harmlessly: update, never "confirm" or Face ID', (_n, e) => {
    const text = errorCopy(e, 'Talos', null)
    expect(text).toBe(OLDER_STEP_COPY)
    expect(text).not.toMatch(/confirm|face id|passkey|cancel/i)
  })

  it.each([
    ['a 502 from the relay', new HttpError(502), 'Something went wrong (502).'],
    ['a 403 with no code', new HttpError(403), 'Something went wrong (403).'],
    [
      'a dropped connection',
      new TypeError('Load failed'),
      "Couldn't reach the server. Check your connection and try again.",
    ],
    ['an error nobody named', new Error('boom'), 'Something went wrong.'],
    [
      'a NotAllowedError (no prompt any more)',
      Object.assign(new Error('x'), { name: 'NotAllowedError' }),
      'Something went wrong.',
    ],
  ])('%s', (_n, e, copy) => {
    expect(errorCopy(e, 'Talos', null)).toBe(copy)
  })
})
