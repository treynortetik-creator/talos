import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
import { EventRow } from '../../src/features/inbox/EventRow.tsx'
import { InboxScreen } from '../../src/features/inbox/InboxScreen.tsx'
import { safeHref, snoozeUntil, tabCounts, tabItems } from '../../src/features/inbox/logic.ts'
import { setPlatform, webPlatform } from '../../src/lib/platform.ts'
import { makeCard, makeItem, renderWith, setup } from '../cards/helpers.tsx'

const XSS = '<img src=x onerror=alert(1)> **bold** [x](javascript:alert(1)) <script>alert(2)</script>'

function seeded() {
  const items = [
    makeItem({ title: 'High one', priority: 'high', ts: '2026-10-28T15:00:00.000Z' }),
    makeItem({ title: 'Normal one', priority: 'normal', ts: '2026-10-28T15:10:00.000Z' }),
    makeItem({ title: 'Low one', priority: 'low', ts: '2026-10-28T15:20:00.000Z' }),
    makeItem({ title: 'Done already', priority: 'high', state: 'done' }),
    makeItem({
      title: 'Snoozed already',
      priority: 'high',
      state: 'snoozed',
      snooze_until: '2026-10-29T08:00:00.000Z',
    }),
  ]
  return { items, client: setup({ inbox: items }) }
}

function swipe(el: HTMLElement, dx: number) {
  fireEvent.pointerDown(el, { clientX: 100, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: 100 + dx / 2, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: 100 + dx, clientY: 100, pointerId: 1 })
  fireEvent.pointerUp(el, { clientX: 100 + dx, clientY: 100, pointerId: 1 })
}

describe('inbox logic', () => {
  it('tab counts exclude done and snoozed, and "other" is the low-priority tab', () => {
    const { items } = seeded()
    expect(tabCounts(items)).toEqual({ priority: 2, other: 1 })
    expect(tabItems(items, 'priority').map((i) => i.title)).toEqual(['Normal one', 'High one'])
  })

  it('safeHref keeps https and drops javascript:, data:, whitespace and junk', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeHref('http://example.com')).toBe('http://example.com/')
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<b>',
      ' https://example.com',
      'https://exa mple.com',
      '//x',
      'vbscript:x',
      '',
      undefined,
    ])
      expect(safeHref(bad)).toBeNull()
  })

  it('snoozes until 08:00 in the owner zone without a quiet window, else until its end', () => {
    const now = new Date('2026-10-28T16:00:00.000Z')
    expect(snoozeUntil(now, 'UTC', null).toISOString()).toBe('2026-10-29T08:00:00.000Z')
    expect(snoozeUntil(now, 'UTC', { start: '22:00', end: '07:30' }).toISOString()).toBe('2026-10-29T07:30:00.000Z')
    expect(snoozeUntil(now, 'America/New_York', null).toISOString()).toBe('2026-10-29T12:00:00.000Z')
  })
})

describe('InboxScreen', () => {
  it('shows Priority and Other tabs with counts and the right rows', async () => {
    const { client } = seeded()
    renderWith(<InboxScreen />, client)
    expect(screen.getByRole('tab', { name: 'Priority (2)' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Other (1)' })).toBeTruthy()
    expect(screen.getByText('High one')).toBeTruthy()
    expect(screen.queryByText('Done already')).toBeNull()
    expect(screen.queryByText('Snoozed already')).toBeNull()
    await userEvent.click(screen.getByRole('tab', { name: 'Other (1)' }))
    expect(screen.getByText('Low one')).toBeTruthy()
  })

  it('swiping a row right marks it done and the counts drop', () => {
    const { items, client } = seeded()
    renderWith(<InboxScreen />, client)
    const row = screen.getByText('High one').closest('button') as HTMLElement
    swipe(row, 120)
    expect(client.store.getState().inbox.find((i) => i.id === items[0]?.id)?.state).toBe('done')
    expect(screen.getByRole('tab', { name: 'Priority (1)' })).toBeTruthy()
    expect(screen.queryByText('High one')).toBeNull()
  })

  it('swiping left snoozes until tomorrow morning', () => {
    const { items, client } = seeded()
    renderWith(<InboxScreen />, client)
    swipe(screen.getByText('High one').closest('button') as HTMLElement, -120)
    const it = client.store.getState().inbox.find((i) => i.id === items[0]?.id)
    expect(it?.state).toBe('snoozed')
    expect(it?.snooze_until).toMatch(/T08:00:00\.000Z$/)
  })

  it('a short drag or a mostly-vertical one does nothing', () => {
    const { items, client } = seeded()
    renderWith(<InboxScreen />, client)
    const row = screen.getByText('High one').closest('button') as HTMLElement
    swipe(row, 30)
    fireEvent.pointerDown(row, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(row, { clientX: 150, clientY: 400, pointerId: 1 })
    fireEvent.pointerUp(row, { clientX: 150, clientY: 400, pointerId: 1 })
    expect(client.store.getState().inbox.find((i) => i.id === items[0]?.id)?.state).toBe('new')
  })

  it('shows the truncated notice', () => {
    const client = setup({ inbox: [makeItem()] })
    client.store.setState((s) => ({ ...s, inboxTruncated: true }))
    renderWith(<InboxScreen />, client)
    expect(screen.getByText('Some mail was skipped: more than 200 messages arrived at once.')).toBeTruthy()
  })

  it('says how many items the relay could not read, and nothing when it read them all', async () => {
    const client = setup({ inbox: [makeItem()] })
    const answer = (unreadable?: number) => ({
      items: [],
      counts: { priority: 1, other: 0 },
      ...(unreadable ? { unreadable } : {}),
    })
    client.api.inbox = vi.fn(async () => answer(2))
    const { unmount } = renderWith(<InboxScreen />, client)
    expect((await screen.findByTestId('inbox-unreadable')).textContent).toBe(
      '2 items could not be read and are left out.',
    )
    unmount()
    client.api.inbox = vi.fn(async () => answer(1))
    const second = renderWith(<InboxScreen />, client)
    expect((await screen.findByTestId('inbox-unreadable')).textContent).toBe(
      '1 item could not be read and is left out.',
    )
    second.unmount()
    client.api.inbox = vi.fn(async () => answer())
    renderWith(<InboxScreen />, client)
    await waitFor(() => expect(client.api.inbox).toHaveBeenCalled())
    expect(screen.queryByTestId('inbox-unreadable')).toBeNull()
  })

  it('hides the unreadable notice on the Done tab, where the count does not apply', async () => {
    const client = setup({ inbox: [makeItem()] })
    client.api.inbox = vi.fn(async () => ({ items: [], counts: { priority: 1, other: 0 }, unreadable: 2 }))
    renderWith(<InboxScreen />, client)
    await screen.findByTestId('inbox-unreadable')
    await userEvent.click(screen.getByRole('tab', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByTestId('inbox-unreadable')).toBeNull())
    await userEvent.click(screen.getByRole('tab', { name: /^Priority/ }))
    expect(await screen.findByTestId('inbox-unreadable')).toBeTruthy()
  })

  it('shows the inbox-zero empty state', () => {
    renderWith(<InboxScreen />, setup())
    expect(screen.getByTestId('inbox-empty').textContent).toBe('Inbox zero. Nobody wants anything from you.')
  })

  it('an event title with <img onerror> and markdown renders as literal text', () => {
    const client = setup({ inbox: [makeItem({ title: XSS, summary: XSS })] })
    const { container } = renderWith(<InboxScreen />, client)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(screen.getAllByText(XSS, { selector: 'span' })).toHaveLength(2) // title and summary, as text
  })

  it('agent summaries get the glyph; deterministic ones do not', () => {
    const client = setup({
      inbox: [makeItem({ title: 'A', agent_summary: 'Agent says hi' }), makeItem({ title: 'B' })],
    })
    renderWith(<InboxScreen />, client)
    expect(screen.getByText('Agent says hi').parentElement?.textContent).toContain('✦')
    expect(screen.getByText('octocat requested your review').className).toContain('text-text-2')
  })

  it('opening an item shows the sheet, marks it read, and offers Done / Snooze / Ask', async () => {
    const item = makeItem({ title: 'Needs a look', url: 'https://example.com/pr/1' })
    const client = setup({ inbox: [item] })
    renderWith(<InboxScreen />, client)
    await userEvent.click(screen.getByText('Needs a look'))
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog)
        .getByRole('link', { name: /Open source/ })
        .getAttribute('href'),
    ).toBe('https://example.com/pr/1')
    expect(client.store.getState().inbox[0]?.state).toBe('read')
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Snooze' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Ask Talos' })).toBeTruthy()
  })

  it('the source link opens through the platform adapter, not window.open', async () => {
    const openExternal = vi.fn(() => true)
    setPlatform({ ...webPlatform, openExternal })
    const client = setup({ inbox: [makeItem({ title: 'Linked', url: 'https://example.com/x' })] })
    renderWith(<InboxScreen />, client)
    await userEvent.click(screen.getByText('Linked'))
    await userEvent.click(await screen.findByRole('link', { name: /Open source/ }))
    expect(openExternal).toHaveBeenCalledWith('https://example.com/x')
    setPlatform(webPlatform)
  })

  it('a javascript: or data: URL never becomes an href', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
      const client = setup({ inbox: [makeItem({ title: 'Evil link' })] })
      // The protocol schema already rejects these, so inject past it the way a compromised relay could.
      client.store.setState((s) => ({ ...s, inbox: s.inbox.map((i) => ({ ...i, url })) }))
      const { container, unmount } = renderWith(<InboxScreen />, client)
      await userEvent.click(screen.getByText('Evil link'))
      await screen.findByRole('dialog')
      expect(document.body.querySelector('a[href]')).toBeNull()
      expect(container.innerHTML).not.toContain('javascript:')
      unmount()
    }
  })

  it('Ask {agent} navigates to the default thread with a "re:" draft in its composer', async () => {
    const client = setup({ inbox: [makeItem({ title: 'Invoice question' })] })
    renderWith(<InboxScreen />, client)
    await userEvent.click(screen.getByText('Invoice question'))
    await userEvent.click(await screen.findByRole('button', { name: 'Ask Talos' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/t/general'))
    expect(useComposerStore.getState().prefill.general).toEqual({ text: 're: Invoice question', mode: 'replace' })
  })

  it('shows the related card in the item sheet', async () => {
    const card = makeCard({ title: 'Draft reply' })
    const client = setup({ inbox: [makeItem({ title: 'Has card', card_id: card.id })], cards: [card] })
    renderWith(<InboxScreen />, client)
    await userEvent.click(screen.getByText('Has card'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Draft reply')).toBeTruthy()
  })

  it('the composer sends to the inbox thread', async () => {
    const client = setup({ inbox: [makeItem()] })
    renderWith(<InboxScreen />, client)
    await userEvent.type(screen.getByRole('textbox', { name: 'Ask Talos about your inbox' }), 'anything urgent?')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    // the fake client signs before it records the frame, so the send lands a tick after the click (flaky under load)
    await waitFor(() => expect(client.sent.length).toBeGreaterThan(0))
    const frame = client.sent.at(-1) as Record<string, unknown>
    expect(frame.thread_id).toBe('inbox')
    expect(frame.text).toBe('anything urgent?')
  })
})

describe('EventRow', () => {
  it('renders as plain text and calls onOpen on tap', async () => {
    const item = makeItem({ title: '**not bold**' })
    const onOpen = vi.fn()
    const client = setup({ inbox: [item] })
    const { container } = renderWith(
      <ul>
        <EventRow item={item} onOpen={onOpen} />
      </ul>,
      client,
    )
    expect(container.querySelector('strong')).toBeNull()
    await userEvent.click(screen.getByText('**not bold**'))
    expect(onOpen).toHaveBeenCalledWith(item)
  })
})
