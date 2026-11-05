// Home's status word for a card the owner decided: killed and revised read as such, in grey, whether the Mac closed the
// card (done) or an older Mac left it resolved. An approved card with no result says so once the wait is overdue, the same
// as the thread does.
import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RESULT_OVERDUE_MS } from '../../src/features/cards/logic.ts'
import { HomeScreen } from '../../src/features/home/HomeScreen.tsx'
import { makeCard, renderWith, setup } from '../cards/helpers.tsx'

afterEach(() => vi.useRealTimers())

const NOW = Date.parse('2026-10-28T16:00:00.000Z')
const res = (action: string, atMs: number) => ({
  action,
  at: new Date(atMs).toISOString(),
  edited: false,
  payload_hash: 'sha256:x',
})
const word = (title: string) => {
  const row = screen.getAllByText(title)[0]?.closest('button') as HTMLElement
  return row.querySelector('span.uppercase') as HTMLElement
}

describe('Home status word for a decided card', () => {
  it.each([
    ['done', 'kill', 'Killed'],
    ['done', 'revise', 'Revised'],
    ['resolved', 'kill', 'Killed'],
    ['resolved', 'revise', 'Revised'],
  ] as const)('a %s card the owner %sed reads %s, in grey, never green', (state, action, label) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const card = makeCard({ title: 'Decided one', state, resolution: res(action, NOW - 60_000) })
    renderWith(<HomeScreen />, setup({ cards: [card] }))
    expect(word('Decided one').textContent).toBe(label)
    expect(word('Decided one').className).toContain('text-text-2')
    expect(word('Decided one').className).not.toContain('text-ok')
  })

  it('an approved card that finished still reads Done in green', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const card = makeCard({
      title: 'Finished one',
      state: 'done',
      resolution: res('primary', NOW - 60_000),
      result: { ok: true, text: 'Sent', at: new Date(NOW - 30_000).toISOString() },
    })
    renderWith(<HomeScreen />, setup({ cards: [card] }))
    expect(word('Finished one').textContent).toBe('Done')
    expect(word('Finished one').className).toContain('text-ok')
  })

  it('an approved card waiting for its result reads Working, then No result once the wait is overdue', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const fresh = makeCard({ title: 'Fresh wait', state: 'resolved', resolution: res('primary', NOW - 60_000) })
    const stale = makeCard({
      title: 'Stale wait',
      state: 'resolved',
      resolution: res('primary', NOW - RESULT_OVERDUE_MS - 1),
    })
    renderWith(<HomeScreen />, setup({ cards: [fresh, stale] }))
    expect(word('Fresh wait').textContent).toBe('Working')
    expect(word('Stale wait').textContent).toBe('No result')
  })

  it('a card killed through the fake client reads Killed, and one sent back reads Revised', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const a = makeCard({ title: 'Kill me' })
    const b = makeCard({ title: 'Revise me' })
    const client = setup({ cards: [a, b] })
    const { renderedHash } = await import('../../src/features/cards/logic.ts')
    await client.resolveCard(a.id, { action: 'kill', payloadHash: renderedHash(a) })
    await client.resolveCard(b.id, { action: 'revise', payloadHash: renderedHash(b), note: 'shorter' })
    renderWith(<HomeScreen />, client)
    expect(word('Kill me').textContent).toBe('Killed')
    expect(word('Revise me').textContent).toBe('Revised')
    expect(word('Revise me').className).not.toContain('text-ok')
  })
})
