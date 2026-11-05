// Review finding #20: one snoozeUntil with one timezone rule, and Home re-snooze sends a time.
import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomeScreen } from '../../src/features/home/HomeScreen.tsx'
import { snoozeUntil } from '../../src/features/inbox/logic.ts'
import { ItemSheet } from '../../src/features/threads/ItemSheet.tsx'
import { makeItem, renderWith, setup } from '../cards/helpers.tsx'

afterEach(() => vi.useRealTimers())

describe('snooze', () => {
  it('the item sheet snoozes with the shared rule: the agent timezone, not the phone clock', async () => {
    const item = makeItem()
    const client = setup({ inbox: [item] })
    client.store.setState((s) =>
      s.config ? { config: { ...s.config, timezone: 'Pacific/Auckland', quiet_window: null } } : {},
    )
    const spy = vi.spyOn(client, 'updateInbox')
    const before = Date.now()
    renderWith(<ItemSheet item={item} onClose={() => {}} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Snooze' }))
    const patch = spy.mock.calls[0]?.[1]
    const after = Date.now()
    const expected = [before, after].map((t) => snoozeUntil(new Date(t), 'Pacific/Auckland', null).toISOString())
    expect(expected).toContain(patch?.snoozeUntil)
  })

  it('re-snoozing a snoozed item from Home sends a snooze time to the relay', async () => {
    const item = makeItem({ state: 'snoozed', snooze_until: '2099-01-01T07:00:00.000Z', title: 'Later thing' })
    const client = setup({ inbox: [item] })
    const spy = vi.spyOn(client, 'updateInbox')
    renderWith(<HomeScreen />, client)
    await userEvent.click(screen.getByRole('tab', { name: /Up next/ }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const row = screen.getByText('Later thing').closest('button') as HTMLElement
    fireEvent.pointerDown(row)
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    const menu = screen.getByRole('dialog', { name: /Actions for Later thing/ })
    fireEvent.click(within(menu).getByRole('button', { name: 'Snooze' }))
    expect(spy).toHaveBeenCalled()
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ state: 'snoozed', snoozeUntil: expect.any(String) })
  })
})
