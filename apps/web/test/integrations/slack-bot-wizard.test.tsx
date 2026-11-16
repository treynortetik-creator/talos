// The Slack wizard's "Whose messages?" choice: the owner's messages (as before) or an agent's bot, with the bot's words,
// its two ways to connect in step 3, and the choice locked once a Signing Secret is saved.
import { slackBot } from '@talos-app/integrations/catalog'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionDetail, IntegrationsScreen, IntegrationWizard } from '../../src/features/integrations/index.tsx'
import { renderWith, setup } from '../cards/helpers.tsx'

const SECRET = '0123456789abcdef0123456789abcdef'

function slackOn() {
  const client = setup()
  client.store.setState((s) =>
    s.config
      ? {
          ...s,
          config: {
            ...s.config,
            agent: { ...s.config.agent, name: 'Ari' },
            work: { ...s.config.work, enabled: ['slack'] },
          },
        }
      : s,
  )
  return client
}

const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed')

describe('Slack wizard: whose messages', () => {
  it('"My messages" is chosen first and everything below is as before', async () => {
    const client = slackOn()
    const create = vi.spyOn(client.api.connections, 'create')
    renderWith(<IntegrationWizard integrationId="slack" onDone={() => {}} />, client)
    expect(await screen.findByRole('heading', { name: 'What should reach you?' })).toBeTruthy()
    expect(pressed('My messages')).toBe('true')
    expect(pressed("An agent's bot")).toBe('false')
    expect(screen.getByText('Reach me for')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Direct messages' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Step 3 of 5')
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const body = create.mock.calls[0]?.[0]
    expect(body).toMatchObject({ integration: 'slack', name: 'Slack' })
    expect(body?.fields).toBeUndefined()
    // the placeholder is the agent's name now
    expect(screen.queryByText(/\{agent\}/)).toBeNull()
    expect(screen.getByText(/Ari only keeps direct messages and messages that mention you/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open Slack/ }).getAttribute('href')).toContain('user_events')
  })

  it("the bot's words in step 2, and the connection is made for the bot", async () => {
    const client = slackOn()
    const create = vi.spyOn(client.api.connections, 'create')
    renderWith(<IntegrationWizard integrationId="slack" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: "An agent's bot" }))
    expect(screen.getByRole('heading', { name: 'What should reach the bot?' })).toBeTruthy()
    expect(
      screen.getByText(/Messages people send to your agent's Slack bot\. The bot's own posts are ignored\./),
    ).toBeTruthy()
    expect(screen.getByText('Reach the agent for')).toBeTruthy()
    for (const label of Object.values(slackBot.filterLabels))
      expect(screen.getByRole('checkbox', { name: label })).toBeTruthy()
    expect(screen.getByText(/Pick the thread of the agent that answers as this bot/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Step 3 of 5')
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]?.[0]).toMatchObject({ name: "Slack (agent's bot)", fields: { identity: 'bot' } })
  })

  it('step 3 for the bot: two ways, an app you already have first, then the Signing Secret', async () => {
    const client = slackOn()
    renderWith(<IntegrationWizard integrationId="slack" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: "An agent's bot" }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Step 3 of 5')
    await waitFor(() => expect(screen.queryByText('Setting up…')).toBeNull())
    expect(screen.queryByText(/\{agent\}/)).toBeNull()
    expect(screen.getByText(/The bot only hears public channels it has been added to\./)).toBeTruthy()
    expect(
      within(document.querySelector('details') as HTMLElement).getByText(/5\. Add the bot to channels/),
    ).toBeTruthy()
    expect(within(document.querySelector('details') as HTMLElement).getByText('chat:write')).toBeTruthy()
    const ways = [...document.querySelectorAll('details')]
    expect(ways.map((d) => d.querySelector('summary')?.textContent)).toEqual([
      'Add to a bot app you already have',
      'Create a new bot app',
    ])
    const existing = ways[0] as HTMLElement
    expect(within(existing).getByText(/An app has one Request URL for all its events\./)).toBeTruthy()
    expect(within(existing).getByText(/https:\/\/relay\.example\.com\/hook\/slack\/cn_/)).toBeTruthy()
    for (const code of [
      'message.im',
      'message.mpim',
      'message.channels',
      'im:history',
      'mpim:history',
      'channels:history',
    ])
      expect(within(existing).getByText(code)).toBeTruthy()
    expect(within(existing).getByText(/Messages Tab/)).toBeTruthy()
    // the new app's manifest: bot scopes and events, a Messages tab people can write in, no user scopes
    const href =
      within(ways[1] as HTMLElement)
        .getByRole('link', { name: /Open Slack/ })
        .getAttribute('href') ?? ''
    const manifest = JSON.parse(decodeURIComponent(href.split('manifest_json=')[1] ?? ''))
    expect(manifest.oauth_config.scopes).toEqual({
      bot: ['im:history', 'mpim:history', 'channels:history', 'chat:write'],
    })
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(['message.im', 'message.mpim', 'message.channels'])
    expect(manifest.settings.event_subscriptions.user_events).toBeUndefined()
    expect(manifest.features.app_home).toMatchObject({
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    })
    expect(manifest.settings.socket_mode_enabled).toBe(false)
    // one Signing Secret field, outside both ways
    const field = screen.getByLabelText('Signing Secret')
    expect(ways.some((d) => d.contains(field))).toBe(false)
  })

  it('switching before a secret is saved replaces the draft; after it is saved the choice is locked', async () => {
    const client = slackOn()
    const del = vi.spyOn(client.api.connections, 'delete')
    const create = vi.spyOn(client.api.connections, 'create')
    renderWith(<IntegrationWizard integrationId="slack" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Next' })) // a draft for "My messages"
    await screen.findByText('Step 3 of 5')
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await userEvent.click(screen.getByRole('button', { name: "An agent's bot" }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Step 3 of 5')
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(del).toHaveBeenCalledTimes(1) // only the secret-less draft
    expect(create.mock.calls[1]?.[0]).toMatchObject({ fields: { identity: 'bot' } })
    expect(await client.api.connections.list()).toHaveLength(1)
    // save the Signing Secret: from now on the choice is fixed
    await userEvent.type(screen.getByLabelText('Signing Secret'), SECRET)
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    await screen.findByText('Saved.')
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'My messages' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: "An agent's bot" }).hasAttribute('disabled')).toBe(true)
    expect(
      screen.getByText(
        "This connection listens to an agent's bot. To listen to the other, add a second Slack connection.",
      ),
    ).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Step 3 of 5')
    expect(del).toHaveBeenCalledTimes(1) // nothing more was deleted
  })

  it('bot back to my messages before a secret: the bot draft is replaced by one for the owner', async () => {
    const client = slackOn()
    const del = vi.spyOn(client.api.connections, 'delete')
    const create = vi.spyOn(client.api.connections, 'create')
    renderWith(<IntegrationWizard integrationId="slack" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: "An agent's bot" }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    await screen.findByText(/Add to a bot app you already have/)
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await userEvent.click(screen.getByRole('button', { name: 'My messages' }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(del).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[1]?.[0]?.fields).toBeUndefined()
    // step 3 speaks for the connection that exists now: the owner's
    await screen.findByText(/only keeps direct messages and messages that mention you/)
    expect(screen.queryByText(/Add to a bot app you already have/)).toBeNull()
  })

  it('closing the wizard after the secret was sent keeps the connection; before, the draft goes', async () => {
    const client = slackOn()
    const del = vi.spyOn(client.api.connections, 'delete')
    const view = renderWith(<IntegrationWizard integrationId="slack" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: "An agent's bot" }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.type(await screen.findByLabelText('Signing Secret'), SECRET)
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    await screen.findByText('Saved.')
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    view.unmount()
    await new Promise((r) => setTimeout(r, 20))
    expect(del).not.toHaveBeenCalled()
    expect(await client.api.connections.list()).toHaveLength(1)
  })

  it('a secret sent whose answer was lost still locks the choice', async () => {
    const client = slackOn()
    client.api.connections.credentials = vi.fn(async () => {
      throw new Error('network')
    }) as never
    const del = vi.spyOn(client.api.connections, 'delete')
    renderWith(<IntegrationWizard integrationId="slack" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: "An agent's bot" }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.type(await screen.findByLabelText('Signing Secret'), SECRET)
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    await screen.findByText('Those did not work.')
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'My messages' }).hasAttribute('disabled')).toBe(true)
    expect(del).not.toHaveBeenCalled()
  })

  it('a save the relay refused leaves a draft: the choice stays free and backing out deletes it', async () => {
    const client = slackOn()
    client.api.connections.credentials = vi.fn(async () => ({ ok: false, detail: 'No.' })) as never
    const del = vi.spyOn(client.api.connections, 'delete')
    const view = renderWith(<IntegrationWizard integrationId="slack" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: "An agent's bot" }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.type(await screen.findByLabelText('Signing Secret'), SECRET)
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    await screen.findByText('No.')
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'My messages' }).hasAttribute('disabled')).toBe(false)
    view.unmount()
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1))
  })

  it('step 4 for the bot says how to test it; the locked choice is described for screen readers', async () => {
    const client = slackOn()
    renderWith(<IntegrationWizard integrationId="slack" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: "An agent's bot" }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.type(await screen.findByLabelText('Signing Secret'), SECRET)
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    expect(await screen.findAllByText(slackBot.test_hint)).not.toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Back' }))
    const b = screen.getByRole('button', { name: 'My messages' })
    const id = b.getAttribute('aria-describedby') ?? ''
    expect(document.getElementById(id)?.textContent).toMatch(/This connection listens to an agent's bot/)
  })

  it('other integrations have no such choice', async () => {
    const client = slackOn()
    renderWith(<IntegrationWizard integrationId="generic" onDone={() => {}} />, client)
    await screen.findByText('Step 2 of 5')
    expect(screen.queryByText('Whose messages?')).toBeNull()
  })
})

describe('Slack connections in the list and on their page', () => {
  it('the list and the connection page say whose messages, and a bot connection uses the bot words', async () => {
    const client = slackOn()
    const mine = await client.api.connections.create({ integration: 'slack', name: 'Slack' })
    const bot = await client.api.connections.create({
      integration: 'slack',
      name: "Slack (agent's bot)",
      fields: { identity: 'bot' },
    })
    renderWith(<IntegrationsScreen />, client)
    const rows = await screen.findAllByTestId('conn-identity')
    expect(rows.map((r) => r.textContent)).toEqual(['Your messages', "An agent's bot"])
    const { unmount } = renderWith(<ConnectionDetail connectionId={bot.id} />, client)
    expect((await screen.findByTestId('conn-status')).textContent).toContain("An agent's bot")
    await userEvent.click(screen.getByRole('button', { name: /Edit filters/ }))
    expect(screen.getByText('What reaches the agent')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Direct messages to the bot' })).toBeTruthy()
    unmount()
    expect(mine.identity).toBe('owner')
  })

  it("a Slack connection from a relay that says nothing about identity is the owner's", async () => {
    const client = slackOn()
    const c = await client.api.connections.create({ integration: 'slack', name: 'Slack' })
    const { identity: _gone, ...old } = c
    client.api.connections.list = async () => [old]
    renderWith(<IntegrationsScreen />, client)
    expect((await screen.findByTestId('conn-identity')).textContent).toBe('Your messages')
  })
})
