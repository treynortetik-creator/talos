// Org pages' protocol (docs/ORG-PAGES-SPEC.md): the page a message carries degrades to plain text when it cannot be read.
import { describe, expect, it } from 'vitest'
import { Message, newId, PAGE_CSP, PAGE_SANDBOX_ATTR, PageRef } from '../src/index.ts'

const row = (page: unknown) => ({
  id: newId('m'),
  thread_id: 'general',
  author: 'agent',
  kind: 'text',
  text: 'Published a page: “Rota”.',
  created_at: '2026-11-11T12:00:00.000Z',
  page,
})
const ref = {
  page_id: 'pg_01JBF3V7Q8K2M4N6P8R0S2T4V9',
  title: 'Rota',
  version: 'a'.repeat(64),
}

describe('Message.page', () => {
  it('a readable page rides on an ordinary text message', () => {
    expect(Message.parse(row(ref)).page).toEqual(ref)
  })
  it('one that cannot be read reads as absent: the message stays, as its text', () => {
    for (const bad of [{ ...ref, version: 'x' }, { ...ref, extra: 1 }, 'pg_x', { ...ref, title: 'a\nb' }]) {
      const m = Message.parse(row(bad))
      expect(m.page).toBeUndefined()
      expect(m.text).toBe('Published a page: “Rota”.')
    }
    // no link rides on the message: the app builds /p/<page_id> itself
    expect(PageRef.safeParse({ ...ref, owner_url: 'https://evil.example.com/' }).success).toBe(false)
  })
})

describe('the page policy, shared by the relay and the frame', () => {
  it('runs script only, in an opaque origin, with no network', () => {
    expect(PAGE_SANDBOX_ATTR).toBe('allow-scripts')
    expect(PAGE_CSP.startsWith('sandbox allow-scripts;')).toBe(true)
    expect(PAGE_CSP).not.toMatch(/allow-same-origin|connect-src|allow-forms|allow-popups|allow-top-navigation/)
  })
})
