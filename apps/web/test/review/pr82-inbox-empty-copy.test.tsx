// PR #82 review: with Inbox zero, the conversation's empty line must not point at events "above" that aren't there.
// Today the screen reads "Inbox zero. Nobody wants anything from you." then "Ask Talos about anything above: what came in…".
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ThreadScreen } from '../../src/features/threads/ThreadScreen.tsx'
import { makeItem, renderWith, setup } from '../cards/helpers.tsx'

describe('empty Inbox conversation', () => {
  it('does not ask about "anything above" when nothing came in', async () => {
    renderWith(<ThreadScreen />, setup({ inbox: [] }), '/t/inbox', '/t/:thread')
    const text = (await screen.findByTestId('thread-empty-explainer')).textContent ?? ''
    expect(text).not.toMatch(/anything above|what came in/)
  })

  it('still points at the events above when some came in', async () => {
    renderWith(<ThreadScreen />, setup({ inbox: [makeItem()] }), '/t/inbox', '/t/:thread')
    await screen.findByText('Review requested')
    const text = (await screen.findByTestId('thread-empty-explainer')).textContent ?? ''
    expect(text).toMatch(/anything above/)
  })
})
