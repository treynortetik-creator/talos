// @vitest-environment jsdom
// Audit D34 guard: task lists and math are new markdown features. Text a hook delivered (mail subjects, webhook bodies) must
// still never reach the markdown renderer, so none of it can turn into a glyph list or a formula.
import { describe, expect, it } from 'vitest'
import { MessageView } from '../../src/features/threads/MessageView.tsx'
import { renderWith, setup } from '../cards/helpers.tsx'

const text = '- [x] pay $x^2$ now\n\n$$\\frac{a}{b}$$'
const msg = (author: 'hook' | 'agent', kind: 'event' | 'text') => ({
  id: `m_${author}`,
  thread_id: 'inbox',
  seq: 1,
  author,
  kind,
  text,
  format: author === 'agent' ? 'markdown' : 'plain',
  attachments: [],
  via: author === 'hook' ? 'hook' : 'app',
  created_at: new Date().toISOString(),
})

describe('hook-origin text stays plain', () => {
  it('shows the raw characters, no list item, no math', () => {
    const { container } = renderWith(
      <MessageView
        message={msg('hook', 'event') as never}
        cards={[]}
        inbox={[]}
        onOpenImage={() => {}}
        onOpenItem={() => {}}
      />,
      setup(),
      '/t/inbox',
    )
    expect(container.querySelector('li, math, .prose-talos')).toBeNull()
    expect(container.textContent).toContain('- [x] pay $x^2$ now')
  })

  it('agent text of the same shape does go through the renderer (so the test above is meaningful)', () => {
    const { container } = renderWith(
      <MessageView
        message={msg('agent', 'text') as never}
        cards={[]}
        inbox={[]}
        onOpenImage={() => {}}
        onOpenItem={() => {}}
      />,
      setup(),
      '/t/inbox',
    )
    expect(container.querySelector('.prose-talos li.md-task')).not.toBeNull()
  })
})
