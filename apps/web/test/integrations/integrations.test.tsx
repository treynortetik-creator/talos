import { listSetupSpecs } from '@talos-app/integrations/catalog'
import { checkConfigPatch, SetupSpec, type SetupSpecT, verifyOwnerFrame } from '@talos-app/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionDetail, IntegrationsScreen, IntegrationWizard } from '../../src/features/integrations/index.tsx'
import { fillTemplate, safeUrl } from '../../src/features/integrations/template.tsx'
import { TEST_WAIT_MS } from '../../src/features/integrations/Wizard.tsx'
import { setPlatform, webPlatform } from '../../src/lib/platform.ts'
import { makeItem, renderWith, setup } from '../cards/helpers.tsx'

afterEach(() => {
  vi.useRealTimers()
  setPlatform(webPlatform)
})

const spec = (over: Partial<SetupSpecT> = {}): SetupSpecT =>
  SetupSpec.parse({
    id: 'generic',
    name: 'Any app',
    category: 'personal',
    icon: 'webhook',
    blurb: 'Anything that can send a webhook.',
    default_thread: 'inbox',
    filters: [{ key: 'important', label: 'Only important', default: true }],
    connect: [
      { type: 'text', md: '**1.** Add a webhook step.\n\nUse `POST`.' },
      { type: 'copy', label: 'URL', value_template: '{{HOOK_URL}}', secret: false },
      { type: 'copy', label: 'Secret', value_template: '{{SECRET}}', secret: true },
      { type: 'link', label: 'Open docs', href_template: 'https://example.com/docs' },
    ],
    test_hint: 'Send a test request.',
    ...over,
  })

function withCatalog(client: ReturnType<typeof setup>, specs: SetupSpecT[]) {
  client.api.catalog = async () => specs
}

describe('template helpers', () => {
  it('fills known variables and returns null when one is missing', () => {
    expect(fillTemplate('a {{X}} b {{Y}}', { X: '1', Y: '2' })).toBe('a 1 b 2')
    expect(fillTemplate('{{X}}', {})).toBeNull()
    expect(fillTemplate('{{X}}', { X: '' })).toBeNull()
  })
  it('safeUrl drops javascript: and data:', () => {
    expect(safeUrl('https://example.com')).toBe('https://example.com/')
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('data:text/html,x')).toBeNull()
    expect(safeUrl(null)).toBeNull()
  })
})

describe('integrations list and work gate', () => {
  it('shows Personal tiles and the work group with its lock and the config ask_note', async () => {
    const client = setup()
    renderWith(<IntegrationsScreen />, client)
    const work = await screen.findByRole('region', { name: 'Work systems' })
    const note = client.store.getState().config?.work.ask_note ?? ''
    const slack = within(work).getByRole('button', { name: /Slack/ })
    expect(slack.getAttribute('data-locked')).toBe('true')
    expect(slack.textContent).toContain(note)
    expect(slack.textContent).toContain('🔒')
    const personal = screen.getByRole('region', { name: 'Personal' })
    expect(within(personal).getByRole('button', { name: /Any app|Generic/i })).toBeTruthy()
    expect(screen.getByText(/pick/)).toBeTruthy()
  })

  it('uses the configured work label and note', async () => {
    const client = setup()
    client.store.setState((s) =>
      s.config
        ? {
            ...s,
            config: { ...s.config, work: { ...s.config.work, label: 'Office stuff', ask_note: 'Check with IT.' } },
          }
        : s,
    )
    renderWith(<IntegrationsScreen />, client)
    const work = await screen.findByRole('region', { name: 'Office stuff' })
    expect(within(work).getAllByText('Check with IT.').length).toBeGreaterThan(0)
  })

  it('enabling a work integration needs step-up and sends a config.patch touching work.enabled', async () => {
    const client = setup()
    const stepup = vi.spyOn(client, 'stepup')
    renderWith(<IntegrationsScreen />, client)
    await userEvent.click(await screen.findByRole('button', { name: /Slack/ }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/pass through your relay/)
    expect(dialog.textContent).toMatch(/Passthrough/)
    expect(client.sent).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: "Confirm it's you" }))
    await waitFor(() => expect(client.store.getState().config?.work.enabled).toContain('slack'))
    expect(stepup).toHaveBeenCalledWith('config:work')
    const frame = client.sent.at(-1) as Record<string, unknown>
    expect(frame.type).toBe('config.patch')
    expect(frame.patch).toEqual({ work: { enabled: ['slack'] } })
    expect(frame.base_rev).toBe(client.store.getState().config ? (client.store.getState().config?.rev ?? 0) - 1 : -1)
    expect(checkConfigPatch(frame.patch)).toEqual({ ok: true, touchesWorkEnabled: true })
    expect(await verifyOwnerFrame(frame, await client.publicJwk())).toBe(true)
    // the tile is unlocked now
    await waitFor(() =>
      expect(document.querySelector('[data-tile="slack"]')?.getAttribute('data-locked')).toBe('false'),
    )
  })

  it('a refused step-up changes nothing', async () => {
    const client = setup()
    client.stepup = async () => {
      throw new Error('cancelled')
    }
    renderWith(<IntegrationsScreen />, client)
    await userEvent.click(await screen.findByRole('button', { name: /Slack/ }))
    await userEvent.click(await screen.findByRole('button', { name: "Confirm it's you" }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Nothing was changed/)
    expect(client.sent).toHaveLength(0)
    expect(client.store.getState().config?.work.enabled).toEqual([])
  })

  it('with the Mac offline the confirm button is disabled', async () => {
    const client = setup({ macOffline: true })
    renderWith(<IntegrationsScreen />, client)
    await userEvent.click(await screen.findByRole('button', { name: /Slack/ }))
    expect((await screen.findByRole('button', { name: 'Mac is offline' })).hasAttribute('disabled')).toBe(true)
  })

  it('a work system that is on can be turned off from its tile (the dialog had no way in before, U3)', async () => {
    const client = setup()
    client.store.setState((s) =>
      s.config ? { ...s, config: { ...s.config, work: { ...s.config.work, enabled: ['slack'] } } } : s,
    )
    const stepup = vi.spyOn(client, 'stepup')
    renderWith(<IntegrationsScreen />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off Slack' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/Turn off Slack\?/)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(client.store.getState().config?.work.enabled).toEqual([]))
    expect(stepup).toHaveBeenCalledWith('config:work')
    expect(document.querySelector('[data-tile="slack"]')?.getAttribute('data-locked')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Turn off Slack' })).toBeNull()
  })

  it('turning a work integration off also goes through step-up', async () => {
    const client = setup()
    client.store.setState((s) =>
      s.config ? { ...s, config: { ...s.config, work: { ...s.config.work, enabled: ['slack'] } } } : s,
    )
    const { WorkEnableDialog } = await import('../../src/features/integrations/WorkEnable.tsx')
    const slackSpec = listSetupSpecs().find((x) => x.id === 'slack')
    if (!slackSpec) throw new Error('slack missing from the catalog')
    renderWith(<WorkEnableDialog spec={slackSpec} mode="disable" readOnly={false} onClose={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(client.store.getState().config?.work.enabled).toEqual([]))
    expect((client.sent.at(-1) as Record<string, unknown>).patch).toEqual({ work: { enabled: [] } })
  })
})

describe('IntegrationWizard', () => {
  it('walks all 5 screens for a spec-driven integration', async () => {
    const client = setup()
    withCatalog(client, [spec()])
    renderWith(<IntegrationWizard onDone={() => {}} />, client)
    expect(await screen.findByText('Step 1 of 5')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Any app/ }))

    expect(screen.getByText('Step 2 of 5')).toBeTruthy()
    expect(
      screen.getByRole('checkbox', { name: 'Only important' }).hasAttribute('checked') ||
        (screen.getByRole('checkbox', { name: 'Only important' }) as HTMLInputElement).checked,
    ).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByText('Step 3 of 5')).toBeTruthy()
    await screen.findByText('URL')
    expect(screen.getByText(/https:\/\/relay\.example\.com\/hook\/generic\/cn_/)).toBeTruthy()
    expect(screen.getByText('1.').tagName).toBe('STRONG')
    expect(screen.getByRole('link', { name: /Open docs/ }).getAttribute('href')).toBe('https://example.com/docs')
    // secrets are masked until asked for
    expect(screen.queryByText(/whsec_/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(screen.getByText(/whsec_/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(screen.getByText('Step 4 of 5')).toBeTruthy()
    expect(screen.getByText('Waiting for the first event…')).toBeTruthy()
    const conn = (await client.api.connections.list())[0]
    expect(conn?.filters).toEqual({ important: true })
    act(() => {
      client.store.setState((s) => ({
        ...s,
        inbox: [
          makeItem({ connection: conn?.id ?? '', title: 'Hello from the app', ts: new Date().toISOString() }),
          ...s.inbox,
        ],
      }))
    })
    expect((await screen.findByTestId('first-event')).textContent).toBe('Hello from the app')
    await userEvent.click(screen.getByRole('button', { name: 'Looks right' }))

    expect(await screen.findByText('Step 5 of 5')).toBeTruthy()
    expect(screen.getByTestId('conn-status').textContent).toMatch(
      /Any app · connected · No events yet · 0 kept \/ 0 received today/,
    )
  })

  it('starts at screen 2 when an integration is preselected', async () => {
    const client = setup()
    withCatalog(client, [spec()])
    renderWith(<IntegrationWizard integrationId="generic" onDone={() => {}} />, client)
    expect(await screen.findByText('Step 2 of 5')).toBeTruthy()
  })

  it('shows the quiet-window line only when one is set', async () => {
    const client = setup()
    withCatalog(client, [spec()])
    client.store.setState((s) =>
      s.config ? { ...s, config: { ...s.config, quiet_window: { start: '22:00', end: '07:00' } } } : s,
    )
    renderWith(<IntegrationWizard integrationId="generic" onDone={() => {}} />, client)
    expect(await screen.findByText('Between 22:00 and 07:00 these wait for your morning digest.')).toBeTruthy()
  })

  it('the thread picker sends the connection to the chosen thread', async () => {
    const client = setup()
    withCatalog(client, [spec()])
    renderWith(<IntegrationWizard integrationId="generic" onDone={() => {}} />, client)
    await userEvent.selectOptions(await screen.findByLabelText('Send to:'), 'general')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Step 3 of 5')
    await waitFor(async () => expect((await client.api.connections.list())[0]?.thread).toBe('general'))
  })

  it('validates a field with its pattern and saves credentials once it is right', async () => {
    const client = setup()
    withCatalog(client, [
      spec({
        connect: [
          { type: 'field', key: 'token', label: 'Token', secret: true, pattern: '^xoxp-', help: 'Starts with xoxp-' },
        ],
      }),
    ])
    const creds = vi.spyOn(client.api.connections, 'credentials')
    renderWith(<IntegrationWizard integrationId="generic" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    const input = await screen.findByLabelText('Token')
    expect(input.getAttribute('type')).toBe('password')
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Required')
    await userEvent.type(input, 'nope')
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/doesn't look right/)
    expect(creds).not.toHaveBeenCalled()
    await userEvent.clear(input)
    await userEvent.type(input, 'xoxp-123')
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    await waitFor(() => expect(creds).toHaveBeenCalledWith(expect.stringMatching(/^cn_/), { token: 'xoxp-123' }))
    expect(await screen.findByRole('button', { name: 'Next' })).toBeTruthy()
  })

  it('does not offer a repositories box: per-repo webhooks are not wired yet, and a repos field breaks setup', async () => {
    const client = setup()
    withCatalog(client, [
      spec({ connect: [{ type: 'field', key: 'token', label: 'Token', secret: true }, { type: 'repo_picker' }] }),
    ])
    const creds = vi.spyOn(client.api.connections, 'credentials')
    renderWith(<IntegrationWizard integrationId="generic" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await userEvent.type(await screen.findByLabelText('Token'), 'abc')
    expect(screen.queryByLabelText(/Repositories/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    await waitFor(() => expect(creds).toHaveBeenCalledWith(expect.stringMatching(/^cn_/), { token: 'abc' }))
  })

  it('an optional field may stay empty (FOLLOWUPS: Linear team id)', async () => {
    const client = setup()
    withCatalog(client, [
      spec({
        connect: [
          { type: 'field', key: 'token', label: 'Token', secret: true },
          { type: 'field', key: 'team', label: 'Team', secret: false, help: 'Optional. Leave empty for all teams.' },
        ],
      }),
    ])
    const creds = vi.spyOn(client.api.connections, 'credentials')
    renderWith(<IntegrationWizard integrationId="generic" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await userEvent.type(await screen.findByLabelText('Token'), 'abc')
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    await waitFor(() => expect(creds).toHaveBeenCalledWith(expect.stringMatching(/^cn_/), { token: 'abc' }))
  })

  it('backing out before the test screen deletes the half-made connection (FOLLOWUPS PR4 F16)', async () => {
    const client = setup()
    withCatalog(client, [spec()])
    const del = vi.spyOn(client.api.connections, 'delete')
    const view = renderWith(<IntegrationWizard integrationId="generic" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await screen.findByText('Step 3 of 5')
    await waitFor(async () => expect(await client.api.connections.list()).toHaveLength(1))
    view.unmount()
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1))
  })

  it('shows relay-side credential errors', async () => {
    const client = setup()
    withCatalog(client, [spec({ connect: [{ type: 'field', key: 'token', label: 'Token', secret: true }] })])
    client.api.connections.credentials = async () => ({ ok: false, detail: 'Slack said invalid_auth' })
    renderWith(<IntegrationWizard integrationId="generic" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await userEvent.type(await screen.findByLabelText('Token'), 'abc')
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Slack said invalid_auth')
  })

  it('drops a javascript: link and says it is unavailable; steps without data say "not available yet"', async () => {
    const client = setup()
    withCatalog(client, [
      spec({
        connect: [
          { type: 'link', label: 'Evil', href_template: 'javascript:alert(1)' },
          { type: 'copy', label: 'Claim', value_template: '{{CLAIM_CODE}}', secret: false },
          { type: 'script', template_id: 'gmail' },
        ],
      }),
    ])
    const { container } = renderWith(<IntegrationWizard integrationId="generic" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await screen.findByText(/Evil isn't available yet/)
    expect(container.querySelector('a[href^="javascript"]')).toBeNull()
    expect(screen.getByText(/Claim: not available yet/)).toBeTruthy()
    expect(screen.getByText(/setup script isn't available yet/)).toBeTruthy()
  })

  it('opens setup links through the platform adapter', async () => {
    const openExternal = vi.fn(() => true)
    setPlatform({ ...webPlatform, openExternal })
    const client = setup()
    withCatalog(client, [spec()])
    renderWith(<IntegrationWizard integrationId="generic" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await userEvent.click(await screen.findByRole('link', { name: /Open docs/ }))
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('the test screen shows the last error the relay recorded after 2 minutes', async () => {
    const client = setup()
    withCatalog(client, [spec()])
    client.api.connections.deliveries = async () => [
      { at: new Date().toISOString(), status: 401, reason: "Signature didn't match: re-copy the Signing Secret" },
    ]
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    renderWith(<IntegrationWizard integrationId="generic" onDone={() => {}} />, client)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Waiting for the first event…')).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEST_WAIT_MS + 6000)
    })
    expect(screen.getByText("Here's what to check:", { exact: false })).toBeTruthy()
    expect(screen.getByText("Signature didn't match: re-copy the Signing Secret")).toBeTruthy()
  })

  it('a locked work integration shows the lock, not the setup', async () => {
    const client = setup()
    renderWith(<IntegrationWizard integrationId="slack" onDone={() => {}} />, client)
    expect(await screen.findByText(/Slack is off/)).toBeTruthy()
    expect(screen.queryByText('Step 3 of 5')).toBeNull() // nothing was created: the gate stops the flow at screen 2
  })

  it('renders every catalog entry through all 5 screens (fake mode)', async () => {
    const real = listSetupSpecs()
    expect(real.length).toBeGreaterThanOrEqual(18)
    const outline: Record<string, string[]> = {}
    for (const entry of real) {
      const client = setup()
      client.store.setState((s) =>
        s.config
          ? {
              ...s,
              config: {
                ...s.config,
                work: { ...s.config.work, enabled: ['slack', 'jira', 'gmail_work', 'zoom', 'salesforce', 'heartbeat'] },
              },
            }
          : s,
      )
      const screens: string[] = []
      const { unmount } = renderWith(<IntegrationWizard onDone={() => {}} />, client)
      await screen.findByRole('region', { name: 'Personal' })
      await userEvent.click(document.querySelector(`[data-tile="${entry.id}"]`) as HTMLElement)
      screens.push(screen.getByRole('heading', { level: 2 }).textContent ?? '')
      await userEvent.click(screen.getByRole('button', { name: 'Next' }))
      await screen.findByText('Step 3 of 5')
      await waitFor(() => expect(screen.queryByText('Setting up…')).toBeNull())
      screens.push(screen.getByRole('heading', { level: 2 }).textContent ?? '')
      // fill any fields with something every pattern in the catalog accepts, or skip validation by trying candidates
      for (const f of entry.connect.filter((c) => c.type === 'field')) {
        const input = screen.getByLabelText(f.label)
        for (const candidate of [
          'x',
          'xoxp-abc',
          '0123456789abcdef0123456789abcdef',
          'example.atlassian.net',
          'whsec_EXAMPLEexampleEXAMPLE0001',
          '00D000000000062EAA',
          `lin_api_${'a'.repeat(24)}`,
          'alex@example.com',
          'https://example.com',
          '1',
          `ghp_${'a'.repeat(36)}`,
          'a.b.c',
          '/a',
        ]) {
          fireEvent.change(input, { target: { value: candidate } })
          if (!f.pattern || new RegExp(f.pattern).test(candidate)) break
        }
      }
      const save = screen.queryByRole('button', { name: 'Save and continue' })
      if (save) {
        await userEvent.click(save)
        await screen.findByRole('button', { name: 'Next' })
      }
      await userEvent.click(screen.getByRole('button', { name: 'Next' }))
      screens.push(screen.getByRole('heading', { level: 2 }).textContent ?? '')
      const conn = (await client.api.connections.list())[0]
      act(() => {
        client.store.setState((s) => ({
          ...s,
          inbox: [
            makeItem({ connection: conn?.id ?? '', title: `Event from ${entry.name}`, ts: new Date().toISOString() }),
            ...s.inbox,
          ],
        }))
      })
      await userEvent.click(await screen.findByRole('button', { name: 'Looks right' }))
      screens.push((await screen.findByRole('heading', { level: 2 })).textContent ?? '')
      outline[entry.id] = screens
      unmount()
    }
    for (const steps of Object.values(outline)) expect(steps.slice(1)).toEqual(['Connect', 'Test', 'Connected'])
    expect(outline).toMatchSnapshot()
  })
})

describe('ConnectionDetail', () => {
  async function connected(over: Partial<SetupSpecT> = {}) {
    const client = setup()
    withCatalog(client, [spec(over)])
    const created = await client.api.connections.create({
      integration: 'generic',
      name: 'Any app',
      filters: { important: true },
    })
    return { client, created }
  }

  it('shows the status line with counts and last event', async () => {
    const { client, created } = await connected()
    await client.api.connections.patch(created.id, {})
    const base = await client.api.connections.get(created.id)
    client.api.connections.get = async () => ({
      ...base,
      last_event_at: new Date(Date.now() - 4 * 60_000).toISOString(),
      kept_24h: 14,
      received_24h: 312,
    })
    renderWith(<ConnectionDetail connectionId={created.id} />, client)
    expect((await screen.findByTestId('conn-status')).textContent).toBe(
      'Any app · connected · Last event 4 min ago · 14 kept / 312 received today',
    )
  })

  it('Pause then Resume patches the status', async () => {
    const { client, created } = await connected()
    renderWith(<ConnectionDetail connectionId={created.id} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    await waitFor(async () => expect((await client.api.connections.get(created.id)).status).toBe('paused'))
    expect(screen.getByTestId('conn-status').textContent).toMatch(/paused/)
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(async () => expect((await client.api.connections.get(created.id)).status).toBe('active'))
  })

  it('Edit filters saves the changed filters', async () => {
    const { client, created } = await connected()
    renderWith(<ConnectionDetail connectionId={created.id} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Edit filters' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only important' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save filters' }))
    await waitFor(async () =>
      expect((await client.api.connections.get(created.id)).filters).toEqual({ important: false }),
    )
  })

  it('lists the last 20 deliveries with time, status and reason', async () => {
    const { client, created } = await connected()
    client.api.connections.deliveries = async () =>
      Array.from({ length: 25 }, (_, i) => ({
        at: `2026-10-28T15:${String(i).padStart(2, '0')}:00.000Z`,
        status: i === 0 ? 401 : 200,
        ...(i === 0 ? { reason: 'bad signature' } : {}),
      }))
    renderWith(<ConnectionDetail connectionId={created.id} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Recent deliveries' }))
    const items = await screen.findAllByText(/^(200|401)$/)
    expect(items).toHaveLength(20)
    expect(screen.getByText('bad signature')).toBeTruthy()
  })

  it('Rotate secret shows the new secret once, with the 24-hour note', async () => {
    const { client, created } = await connected()
    renderWith(<ConnectionDetail connectionId={created.id} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Rotate secret' }))
    expect((await screen.findByTestId('rotated-secret')).textContent).toMatch(/^whsec_/)
    expect(screen.getByText(/old one keeps working for 24 hours/)).toBeTruthy()
  })

  it.each(['gmail', 'gmail_work', 'gcal', 'forward', 'linear', 'calendly'] as const)(
    'Rotate secret is hidden for %s, with a one-line reason',
    async (integration) => {
      const client = setup()
      withCatalog(client, [spec({ id: integration })])
      const created = await client.api.connections.create({ integration, name: 'Apps Script app', filters: {} })
      renderWith(<ConnectionDetail connectionId={created.id} />, client)
      await screen.findByRole('button', { name: 'Pause' })
      expect(screen.queryByRole('button', { name: 'Rotate secret' })).toBeNull()
      expect(screen.getByText(/Rotating the secret is not supported for this app yet/)).toBeTruthy()
    },
  )

  it('Disconnect asks first, then deletes', async () => {
    const { client, created } = await connected()
    const { IntegrationsHub } = await import('../../src/features/integrations/IntegrationsHub.tsx')
    renderWith(<IntegrationsHub />, client)
    await screen.findByRole('list', { name: 'Connected apps' })
    await userEvent.click(document.querySelector('[data-conn]') as HTMLElement)
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('dialog')
    expect((await client.api.connections.list()).length).toBe(1)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }))
    await waitFor(async () => expect(await client.api.connections.list()).toHaveLength(0))
    expect(created.id).toMatch(/^cn_/)
  })
})
