import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HomeScreen } from '../../src/features/home/HomeScreen.tsx'
import { lastReplyText } from '../../src/features/native/companion.ts'
import { watchForBanner } from '../../src/features/threads/bannerWatch.ts'
import { ThreadList } from '../../src/features/threads/ThreadList.tsx'
import { ThreadScreen } from '../../src/features/threads/ThreadScreen.tsx'
import { renderWith, setup } from '../cards/helpers.tsx'

// A thread called `constructor` saved before new ids stopped using such names still has to open. A store keyed by thread id
// answers `messages.constructor` with Object's own function unless the reader asks for an own key.
const at = '2026-10-28T15:00:00.000Z'
function withStored() {
  const client = setup()
  client.store.setState((s) => ({
    ...s,
    threads: [
      ...s.threads,
      {
        id: 'constructor',
        name: 'Constructor',
        kind: 'agent' as const,
        order: 9,
        notify: 'all' as const,
        voice_context: 'recent' as const,
        archived: false,
        created_at: at,
      },
    ],
  }))
  return client
}

describe('a thread stored with the id constructor', () => {
  it('shows in the thread list as a row', () => {
    renderWith(<ThreadList />, withStored(), '/threads')
    expect(screen.getByTestId('thread-row-constructor')).toBeTruthy()
  })

  it('opens as an empty thread and takes its first message', async () => {
    const client = withStored()
    renderWith(<ThreadScreen />, client, '/t/constructor', '/t/:thread')
    expect(await screen.findByTestId('timeline')).toBeTruthy()
    await client.sendMessage({ threadId: 'constructor', text: 'hello there' })
    expect(await screen.findByText('hello there')).toBeTruthy()
  })

  it('shows on Home once it has something unread', async () => {
    const client = withStored()
    client.store.setState((s) => ({ ...s, unread: { ...s.unread, constructor: 2 } }))
    renderWith(<HomeScreen />, client, '/')
    expect(await screen.findByText('Constructor')).toBeTruthy()
  })

  it('marking it unread then read keeps the count a number', () => {
    const client = withStored()
    client.markThreadUnread('constructor')
    expect(client.store.getState().unread.constructor).toBe(1)
    client.markThreadRead('constructor', 3)
    expect(client.store.getState().unread.constructor).toBe(0)
  })

  it('lastReplyText reads it as nothing loaded, not as a function', () => {
    expect(lastReplyText({}, 'constructor')).toEqual({ text: null, truncated: false })
  })

  it('the banner watcher ignores a count that rose with no messages held, without throwing', () => {
    const client = withStored()
    const shown: unknown[] = []
    const stop = watchForBanner(
      client.store,
      () => 'general',
      (b) => shown.push(b),
    )
    expect(() => client.store.setState((s) => ({ ...s, unread: { ...s.unread, constructor: 1 } }))).not.toThrow()
    stop()
    expect(shown).toEqual([])
  })
})
