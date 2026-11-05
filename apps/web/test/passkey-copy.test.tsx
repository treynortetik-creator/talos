// WP-I6 / audit O1: when a passkey step-up cannot run in a shell, every screen that needs one says so truthfully. The old
// line for a card was "Confirmation was cancelled." even when the owner had cancelled nothing.
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { armCard, resetArmForTests } from '../src/features/cards/arm.tsx'
import { CardDeepLink } from '../src/features/cards/CardDeepLink.tsx'
import { IntegrationsScreen } from '../src/features/integrations/index.tsx'
import { HttpError } from '../src/lib/http.ts'
import { PasskeyUnavailableError } from '../src/lib/passkeyGate.ts'
import { makeCard, renderWith, setup } from './cards/helpers.tsx'

afterEach(resetArmForTests)

describe('truthful copy when the shell has no passkey', () => {
  it.each([
    ['mac_app', 'Approve on your phone or in a browser.'],
    ['not_linked', "This app can't use your passkey yet. Approve in Safari or the Home Screen app."],
  ] as const)(
    'a high-risk card (%s) says where to approve, sends nothing, and never says cancelled',
    async (reason, copy) => {
      const card = makeCard({ risk: 'high' })
      const client = setup({ cards: [card] })
      client.stepup = async () => {
        throw new PasskeyUnavailableError(reason)
      }
      armCard(card.id)
      renderWith(<CardDeepLink />, client, `/card/${card.id}`, '/card/:id')
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toBe(copy)
      expect(alert.textContent).not.toMatch(/cancel/i)
      expect(client.sent.filter((f) => f.type === 'card.resolve')).toHaveLength(0)
    },
  )

  it('a browser Cancel on a card is still "Confirmation was cancelled."', async () => {
    const card = makeCard({ risk: 'high' })
    const client = setup({ cards: [card] })
    client.stepup = async () => {
      throw Object.assign(new Error('x'), { name: 'NotAllowedError' })
    }
    armCard(card.id)
    renderWith(<CardDeepLink />, client, `/card/${card.id}`, '/card/:id')
    expect((await screen.findByRole('alert')).textContent).toBe('Confirmation was cancelled.')
  })

  it.each([
    [
      'a 403 from verify (stepup_invalid)',
      () => new HttpError(403, undefined, { error: 'stepup_invalid' }),
      'Confirmation failed. Try again.',
    ],
    ['a 401 from options', () => new HttpError(401), 'Confirmation failed. Try again.'],
    ['a 502 from the relay', () => new HttpError(502), 'Something went wrong (502).'],
    [
      'a dropped connection',
      () => new TypeError('Load failed'),
      "Couldn't reach the server. Check your connection and try again.",
    ],
    ['an error nobody named', () => new Error('boom'), 'Something went wrong.'],
    ['an AbortError', () => Object.assign(new Error('x'), { name: 'AbortError' }), 'Confirmation was cancelled.'],
  ])('audit finding: %s is not called a cancel', async (_n, make, copy) => {
    const card = makeCard({ risk: 'high' })
    const client = setup({ cards: [card] })
    client.stepup = async () => {
      throw make()
    }
    armCard(card.id)
    renderWith(<CardDeepLink />, client, `/card/${card.id}`, '/card/:id')
    const text = (await screen.findByRole('alert')).textContent
    expect(text).toBe(copy)
    if (!/cancelled/.test(copy)) expect(text).not.toMatch(/cancel/i)
    expect(client.sent.filter((f) => f.type === 'card.resolve')).toHaveLength(0)
  })

  it('turning on a work integration says where to approve, and changes nothing', async () => {
    const client = setup()
    client.stepup = async () => {
      throw new PasskeyUnavailableError('mac_app')
    }
    renderWith(<IntegrationsScreen />, client)
    await userEvent.click(await screen.findByRole('button', { name: /Slack/ }))
    await userEvent.click(await screen.findByRole('button', { name: "Confirm it's you" }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Approve on your phone or in a browser.'))
    expect(client.sent).toHaveLength(0)
  })
})
