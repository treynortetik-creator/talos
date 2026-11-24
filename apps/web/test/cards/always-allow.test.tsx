// "Always allow" on a card (always-allow.ts, owner rulings 2026-11-14 and 2026-11-21): a live ACTION card (a send kind, generic,
// schedule, undo, or a settings card that touches only ordinary settings), from a bridge that says ALWAYS_ALLOW_FEATURE, has a
// button that approves this card and allows its kind from now on. The tap is one signed card.resolve with action 'primary' and
// always: true. A question card, a permission card, a card a notification cannot approve, a trust-key or high settings card, or
// an older bridge, gets the card as before.
import {
  ALWAYS_ALLOW_2_FEATURE,
  ALWAYS_ALLOW_FEATURE,
  ALWAYS_KINDS,
  bindingFrom,
  CLI_FIELD_KEY,
  payloadHash,
  verifyOwnerFrame,
} from '@talos-app/protocol'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ALWAYS_ALLOW_LABEL, errorCopy, OLDER_STEP_COPY, OPEN_IN_APP_COPY } from '../../src/features/cards/CardView.tsx'
import { TalosClientError } from '../../src/lib/client.ts'
import { HttpError } from '../../src/lib/http.ts'
import { LiveCard, makeCard, renderWith, setup } from './helpers.tsx'

// `on`: the bridge reads always-allow/1 and /2 (this build); `v1Only`: an older bridge that says /1 alone
const withFeature = (client: ReturnType<typeof setup>, on: boolean, v1Only = false) =>
  client.store.setState((s) => {
    const rest = (s.presence.features ?? []).filter((f) => f !== ALWAYS_ALLOW_FEATURE && f !== ALWAYS_ALLOW_2_FEATURE)
    const add = !on ? [] : v1Only ? [ALWAYS_ALLOW_FEATURE] : [ALWAYS_ALLOW_FEATURE, ALWAYS_ALLOW_2_FEATURE]
    return { ...s, presence: { ...s.presence, features: [...rest, ...add] } }
  })
const resolves = (c: ReturnType<typeof setup>) => c.sent.filter((f) => f.type === 'card.resolve')

const KIND_CARDS: Record<(typeof ALWAYS_KINDS)[number], { primary_label: string; kill_label: string }> = {
  email: { primary_label: 'Send', kill_label: 'Kill draft' },
  message: { primary_label: 'Send', kill_label: 'Deny' },
  deploy: { primary_label: 'Deploy', kill_label: 'Deny' },
  push: { primary_label: 'Push', kill_label: 'Deny' },
  publish: { primary_label: 'Publish', kill_label: 'Deny' },
  purchase: { primary_label: 'Buy', kill_label: 'Deny' },
  generic: { primary_label: 'Approve', kill_label: 'Deny' },
  schedule: { primary_label: 'Save schedule', kill_label: 'Deny' },
  undo: { primary_label: 'Undo files', kill_label: 'Keep files' },
  config: { primary_label: 'Apply', kill_label: 'Keep settings' },
}

// what a config card binds: the changes it shows (an ordinary setting here)
const configPayload = (path: string, o: unknown, n: unknown) => ({
  v: 1,
  base_rev: 1,
  reason: 'because',
  changes: [{ path, old: o, new: n }],
})
// a card of each kind as the bridge makes it, so the table below needs no special case
const cardOf = (kind: (typeof ALWAYS_KINDS)[number], over: Record<string, unknown> = {}) =>
  makeCard({
    kind,
    ...KIND_CARDS[kind],
    ...(kind === 'config' ? { payload: configPayload('agent.name', 'Talos', 'Hal') } : {}),
    ...(kind === 'schedule' ? { payload: { own_risk: 'low' } } : {}),
    ...over,
  })

describe('Always allow on a card', () => {
  it('reads right for every action kind (a table, not a plural rule)', () => {
    expect(Object.keys(ALWAYS_ALLOW_LABEL).sort()).toEqual([...ALWAYS_KINDS].sort())
    expect(ALWAYS_ALLOW_LABEL).toEqual({
      email: 'Always allow emails',
      message: 'Always allow messages',
      deploy: 'Always allow deploys',
      publish: 'Always allow publishing',
      purchase: 'Always allow purchases',
      push: 'Always allow pushing code',
      generic: 'Always allow approvals',
      schedule: 'Always allow schedule changes',
      undo: 'Always allow undos',
      config: 'Always allow settings changes',
    })
  })

  it.each(ALWAYS_KINDS)('a %s card with the feature shows its verb, Always allow and the kill button', (kind) => {
    const card = cardOf(kind)
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

  it.each(ALWAYS_KINDS)(
    'a bridge that says only always-allow/1: the send kinds still offer it, the newer kinds do not (%s)',
    (kind) => {
      const card = cardOf(kind)
      const client = setup({ cards: [card] })
      withFeature(client, true, true)
      renderWith(<LiveCard id={card.id} />, client)
      expect(screen.getByRole('button', { name: KIND_CARDS[kind].primary_label })).toBeTruthy()
      const sendKind = ['email', 'message', 'deploy', 'publish', 'purchase', 'push'].includes(kind)
      expect(screen.queryByRole('button', { name: ALWAYS_ALLOW_LABEL[kind] }) !== null).toBe(sendKind)
    },
  )

  it('a high-risk schedule card never offers it (it holds full permissions, headless runs, more tools or memory)', () => {
    const client = setup({ cards: [cardOf('schedule', { risk: 'high' })] })
    withFeature(client, true)
    renderWith(<LiveCard id={client.store.getState().cards[0]?.id as string} />, client)
    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull()
  })

  it('a schedule card minted low by trust mode but high by its own measure never offers it', () => {
    const client = setup({ cards: [cardOf('schedule', { risk: 'low', payload: { own_risk: 'high' } })] })
    withFeature(client, true)
    renderWith(<LiveCard id={client.store.getState().cards[0]?.id as string} />, client)
    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull()
  })

  it.each([
    ['memory turned on', 'memory_browser', false, true],
    ['the notes lookup turned on', 'dev.note_lookup', false, true],
    ['attachments kept for fewer days', 'media_keep_days', 60, 30],
    ['quiet hours set (a row the value makes high)', 'quiet_window', null, { start: '22:00', end: '07:00' }],
  ])('a settings card for %s never offers it', (_n, path, o, n) => {
    absent(cardOf('config', { payload: configPayload(path, o, n) }), 'Apply')
  })

  const absent = (card: ReturnType<typeof makeCard>, verb: string) => {
    const client = setup({ cards: [card] })
    withFeature(client, true)
    renderWith(<LiveCard id={card.id} />, client)
    expect(screen.getByRole('button', { name: verb })).toBeTruthy() // still one tap to approve
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull()
  }

  it('a decision card never offers it, even with the feature (it keeps its content on the card)', () => {
    absent(makeCard({ kind: 'decision', primary_label: 'Approve' }), 'Approve')
  })

  it('a card that carries talos-app commands never offers it (the bridge refuses it from a notification)', () => {
    absent(
      cardOf('generic', {
        fields: [{ key: CLI_FIELD_KEY, label: 'Commands', value: 'talos-app trust off', editable: false }],
        allow_edit: false,
      }),
      'Approve',
    )
  })

  it.each([
    ['always_allow itself', 'always_allow', [], ['email']],
    ['the settings lock', 'settings_lock', false, true],
    ['the thread fence', 'dev.thread_fence', true, false],
    ['a thread field (its own session)', 'threads.trip.session', 'shared', 'dedicated'],
    ['a thread field (its folder)', 'threads.trip.session_opts.cwd', null, '/work/a'],
    ['a row the table marks high', 'default_thread', 'inbox', 'general'],
    ['a path nothing knows', 'permission_relay', false, true],
  ])('a settings card for %s never offers it', (_n, path, o, n) => {
    absent(cardOf('config', { payload: configPayload(path, o, n) }), 'Apply')
  })

  it('a settings card whose changes cannot be read never offers it', () => {
    absent(cardOf('config', { payload: { v: 1, changes: 'not a list' } }), 'Apply')
  })
  it('a settings card with no payload at all never offers it', () => {
    absent(makeCard({ kind: 'config', primary_label: 'Apply' }), 'Apply')
  })
  it('a high-risk settings card never offers it, whatever it changes', () => {
    absent(cardOf('config', { risk: 'high' }), 'Apply')
  })

  it('a settings card with one ordinary and one trust change never offers it', () => {
    const p = configPayload('agent.name', 'Talos', 'Hal')
    p.changes.push({ path: 'settings_lock', old: false, new: true })
    absent(cardOf('config', { payload: p }), 'Apply')
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

describe('an action card with a long body', () => {
  it('shows its title and Deny / Always allow / Approve without opening anything', () => {
    const card = makeCard({
      kind: 'generic',
      ...KIND_CARDS.generic,
      title: 'Run the nightly cleanup',
      body: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'),
    })
    const client = setup({ cards: [card] })
    withFeature(client, true)
    renderWith(<LiveCard id={card.id} />, client)
    expect(screen.getByText('Run the nightly cleanup')).toBeTruthy()
    for (const name of ['Deny', 'Always allow approvals', 'Approve'])
      expect(screen.getByRole('button', { name })).toBeTruthy()
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
