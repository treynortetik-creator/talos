// Regression tests for the needs-you cards. Each `it` names the finding id it pins.
// R-PASS tests are checks of behaviour that already held.
import { SetupSpec, type SetupSpecT } from '@talos-app/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CardView } from '../../src/features/cards/CardView.tsx'
import { HomeScreen } from '../../src/features/home/HomeScreen.tsx'
import { InboxScreen } from '../../src/features/inbox/InboxScreen.tsx'
import { IntegrationsScreen, IntegrationWizard } from '../../src/features/integrations/index.tsx'
import { LiveCard, makeCard, makeItem, renderWith, setup } from './helpers.tsx'

const HOSTILE = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script><svg onload="window.__xss=1">'

function noInjectedMarkup(root: HTMLElement) {
  expect(root.querySelector('script, svg[onload], img[onerror], iframe, object, embed')).toBeNull()
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    expect(a.getAttribute('href') ?? '').toMatch(/^https?:/)
  }
  expect((window as unknown as { __xss?: number }).__xss).toBeUndefined()
}

describe('PR4 review: cards', () => {
  it('F1: after a resolve is accepted, the card cannot be decided again while card.update is in flight', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    // A real socket client sends the frame and resolves; the store only changes when card.update arrives.
    const calls: string[] = []
    client.resolveCard = vi.fn(async (_id, input) => {
      calls.push(input.action)
    })
    renderWith(<LiveCard id={card.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(calls).toEqual(['primary']))
    // The owner (or a double tap) can now fire a second, distinct decision.
    const kill = screen.queryByRole('button', { name: 'Kill draft' })
    expect(kill === null || (kill as HTMLButtonElement).disabled).toBe(true)
  })

  it('F2: a card that expires during the step-up is not sent', async () => {
    const card = makeCard({ risk: 'high', expires_at: new Date(Date.now() + 1500).toISOString() })
    const client = setup({ cards: [card] })
    const sent = vi.fn(async () => {})
    client.resolveCard = sent
    client.stepup = () => new Promise((r) => setTimeout(() => r('st_test'), 2000))
    renderWith(<LiveCard id={card.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: /Send/ }))
    await new Promise((r) => setTimeout(r, 2300))
    expect(sent).not.toHaveBeenCalled()
  }, 10_000)

  it('F9: bidi controls in a destination are isolated or made visible', () => {
    const card = makeCard({ destination: [{ label: 'To', value: 'alice@example.com‮moc.elpmaxe@evil' }] })
    const client = setup({ cards: [card] })
    const { container } = renderWith(<CardView card={card} threadName="General" />, client)
    const dd = container.querySelector('dd')
    const isolated = dd?.getAttribute('dir') === 'auto' || dd?.querySelector('bdi') !== null
    const visible = !(dd?.textContent ?? '').includes('‮')
    expect(isolated && visible).toBe(true)
  })

  it('R-PASS: hostile text in every card field renders inert', async () => {
    const card = makeCard({
      title: HOSTILE.slice(0, 120),
      summary: HOSTILE,
      body: HOSTILE,
      warning: HOSTILE.slice(0, 160),
      destination: [{ label: '<b>To', value: HOSTILE }],
      fields: [{ key: 'k', label: '<i>x', value: HOSTILE, editable: true, multiline: true }],
      payload: { html: HOSTILE, url: 'javascript:alert(1)' },
    })
    const client = setup({ cards: [card] })
    const { container } = renderWith(<CardView card={card} threadName={HOSTILE} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Details' }))
    noInjectedMarkup(container)
  })
})

describe('PR4 review: home', () => {
  it('F5: an altered pending card is not listed as an ordinary "Needs you" row', () => {
    const good = makeCard({ title: 'Venue reply' })
    const altered = { ...good, body: 'Send the money elsewhere.' }
    const client = setup({ cards: [altered] })
    renderWith(<HomeScreen />, client)
    const row = screen.getByText('Venue reply').closest('button') as HTMLElement
    expect(row.textContent).toMatch(/altered/i)
  })

  it('F11: the long-press menu takes focus and closes on Escape', async () => {
    const client = setup({ cards: [makeCard({ title: 'Menu card' })] })
    renderWith(<HomeScreen />, client)
    await userEvent.click(screen.getByRole('button', { name: 'More actions for Menu card' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('F12: a working thread does not say "Idle"', () => {
    const client = setup()
    client.store.setState((s) => ({
      ...s,
      unread: {},
      statuses: { general: { thread_id: 'general', state: 'working', since: new Date().toISOString() } },
    }))
    renderWith(<HomeScreen />, client)
    const working = screen.getByRole('region', { name: /Working/ })
    expect(within(working).queryByText('Idle')).toBeNull()
  })
})

describe('PR4 review: inbox', () => {
  it('R-PASS: hostile hook text renders inert in the row and the sheet', async () => {
    const item = makeItem({
      title: HOSTILE.slice(0, 200),
      summary: HOSTILE.slice(0, 280),
      agent_summary: HOSTILE.slice(0, 140),
      actor: { name: HOSTILE.slice(0, 120) },
      url: undefined,
    })
    const client = setup({ inbox: [item] })
    const { baseElement } = renderWith(<InboxScreen />, client)
    noInjectedMarkup(baseElement as HTMLElement)
    fireEvent.click(baseElement.querySelector(`[data-event-id="${item.id}"] button`) as HTMLElement)
    await screen.findByTestId('item-summary')
    noInjectedMarkup(baseElement as HTMLElement)
  })
})

const filterSpec = (): SetupSpecT =>
  SetupSpec.parse({
    id: 'generic',
    name: 'Any app',
    category: 'personal',
    icon: 'webhook',
    blurb: 'Anything that can send a webhook.',
    default_thread: 'inbox',
    filters: [{ key: 'important', label: 'Only important', default: true }],
    connect: [
      { type: 'text', md: `${HOSTILE} **1.** step` },
      { type: 'link', label: 'Docs', href_template: 'javascript:alert(1)' },
      { type: 'copy', label: 'URL', value_template: '{{HOOK_URL}}', secret: false },
    ],
    test_hint: HOSTILE,
  })

describe('PR4 review: integrations', () => {
  it('F4: "Adjust what reaches me" actually changes the connection filters', async () => {
    const client = setup()
    client.api.catalog = async () => [filterSpec()]
    renderWith(<IntegrationWizard onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: /Any app/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Step 3 of 5')
    await screen.findByText('URL')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    const conn = (await client.api.connections.list())[0]
    act(() => {
      client.store.setState((s) => ({
        ...s,
        inbox: [makeItem({ connection: conn?.id ?? '', title: 'First', ts: new Date().toISOString() }), ...s.inbox],
      }))
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust what reaches me' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only important' }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(async () => {
      const after = (await client.api.connections.list())[0]
      expect(after?.filters).toEqual({ important: false })
    })
  })

  it('F7: a catalog that fails to load shows an error, not "No webhooks yet"', async () => {
    const client = setup()
    client.api.catalog = async () => {
      throw new Error('relay down')
    }
    client.api.connections.list = async () => {
      throw new Error('relay down')
    }
    renderWith(<IntegrationsScreen />, client)
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('R-PASS: hostile catalog text and a javascript: link render inert in the wizard', async () => {
    const client = setup()
    client.api.catalog = async () => [filterSpec()]
    const { container } = renderWith(<IntegrationWizard integrationId="generic" onDone={() => {}} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await screen.findByText('URL')
    noInjectedMarkup(container)
  })
})
