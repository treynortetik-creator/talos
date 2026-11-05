// PR #94 review L1: a timeline inbox row has its own sideways swipe (done / snooze), so it opts out of the edge swipe.
import { describe, expect, it } from 'vitest'
import { MessageView } from '../../src/features/threads/MessageView.tsx'
import { renderWith, setup } from '../cards/helpers.tsx'

describe('timeline inbox rows opt out of the screen-edge swipe', () => {
  it('the event row wrapper carries data-no-edge-swipe', () => {
    const message = {
      id: 'm_evt',
      thread_id: 'inbox',
      seq: 1,
      author: 'hook',
      kind: 'event',
      text: 'New mail',
      format: 'plain',
      attachments: [],
      via: 'hook',
      created_at: new Date().toISOString(),
    }
    const { container } = renderWith(
      <MessageView message={message as never} cards={[]} inbox={[]} onOpenImage={() => {}} onOpenItem={() => {}} />,
      setup(),
      '/t/inbox',
    )
    expect(container.querySelector('[data-no-edge-swipe]')).not.toBeNull()
  })
})
