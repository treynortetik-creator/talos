// The fake relay refuses what the real one does (apps/relay/src/hooks/api.ts), so the wizard's error paths run in fake mode:
// an unknown setup field, a value its pattern refuses, a Slack identity sent after the connection exists, and a required
// field still missing. One test per refusal, each through the screen the owner would see it on.
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { IntegrationWizard } from '../../src/features/integrations/index.tsx'
import { HttpError } from '../../src/lib/http.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

const SECRET = '0123456789abcdef0123456789abcdef'

function slackOn() {
  const client = setup()
  client.store.setState((s) =>
    s.config ? { ...s, config: { ...s.config, work: { ...s.config.work, enabled: ['slack'] } } } : s,
  )
  return client
}

describe('the fake relay refuses what the real one refuses', () => {
  it('an unknown setup field when a connection is made: a 400, nothing created', async () => {
    const client = slackOn()
    const made = client.api.connections.create({ integration: 'slack', name: 'Slack', fields: { surprise: 'x' } })
    await expect(made).rejects.toBeInstanceOf(HttpError)
    await expect(made).rejects.toMatchObject({ status: 400, body: { error: 'unknown field: surprise' } })
    expect(await client.api.connections.list()).toHaveLength(0)
    // and a value its pattern refuses (an identity that is neither owner nor bot)
    await expect(
      client.api.connections.create({ integration: 'slack', name: 'Slack', fields: { identity: 'robot' } }),
    ).rejects.toMatchObject({ status: 400, body: { error: 'identity does not look right' } })
    // identity is Slack's alone
    await expect(
      client.api.connections.create({ integration: 'generic', name: 'Any app', fields: { identity: 'bot' } }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it("a Slack identity sent with the credentials (after the connection exists) is refused: it is set when it's made", async () => {
    const client = slackOn()
    const c = await client.api.connections.create({ integration: 'slack', name: 'Slack', fields: { identity: 'bot' } })
    expect(c.identity).toBe('bot')
    expect(await client.api.connections.credentials(c.id, { signing_secret: SECRET, identity: 'owner' })).toEqual({
      ok: false,
      detail: 'identity is set when the connection is made',
    })
    expect((await client.api.connections.get(c.id)).identity).toBe('bot')
  })

  it("a required field still missing is refused on save; the wizard shows the relay's words", async () => {
    const client = slackOn()
    const c = await client.api.connections.create({ integration: 'slack', name: 'Slack' })
    expect(await client.api.connections.credentials(c.id, {})).toEqual({
      ok: false,
      detail: 'signing_secret is missing',
    })
    expect(await client.api.connections.credentials(c.id, { signing_secret: SECRET })).toEqual({ ok: true })
    // once given, a later save need not repeat it (the relay keeps it)
    expect(await client.api.connections.credentials(c.id, { bot_user_id: 'U0BOT00001' })).toEqual({ ok: true })
  })

  it("a value the pattern refuses at save time reaches the wizard as the relay's error", async () => {
    const client = slackOn()
    const c = await client.api.connections.create({ integration: 'slack', name: 'Slack' })
    expect(await client.api.connections.credentials(c.id, { signing_secret: 'NOT-HEX' })).toEqual({
      ok: false,
      detail: 'signing_secret does not look right',
    })
    // through the screen: the wizard checks the pattern itself first, so the relay's own refusal shows for what only the
    // relay knows, here a bot user id that is not one
    client.api.connections.credentials = (
      (orig) => (id: string, f: Record<string, string>) =>
        orig(id, { ...f, bot_user_id: 'not-an-id' })
    )(client.api.connections.credentials)
    renderWith(<IntegrationWizard integrationId="slack" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await userEvent.type(await screen.findByLabelText('Signing Secret'), SECRET)
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    expect(await screen.findByText('bot_user_id does not look right')).toBeTruthy()
  })
})
