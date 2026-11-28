import { buildPushPayload, PUSH_TEMPLATES, withPushWords } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import {
  notificationForPush,
  notificationFromPayload,
  parsePush,
  safeNavigateTarget,
  viewingPushThread,
} from '../src/features/pwa/pushLogic.ts'

describe('push logic', () => {
  it('only a valid PushPayload becomes a notification', () => {
    expect(parsePush({ title: 'x', body: 'leaked message text' })).toBeNull()
    expect(parsePush(null)).toBeNull()
    const ok = parsePush({
      web_push: 8030,
      notification: {
        title: 'Talos',
        body: 'New reply in General',
        navigate: '/t/general',
        silent: false,
        app_badge: 2,
      },
      talos: { v: 1, kind: 'reply', thread_id: 'general' },
    })
    expect(ok).not.toBeNull()
    const n = notificationFromPayload(ok as NonNullable<typeof ok>)
    expect(n.title).toBe('Talos')
    expect(n.options.data.navigate).toBe('/t/general')
    expect(n.badge).toBe(2)
  })
  it('every payload the protocol builder makes parses and becomes a notification with the same words', () => {
    const cfg = {
      agent: { name: 'Talos' },
      notifications: { show_thread_names: 'all' as const },
      threads: [{ id: 'general', name: 'General', kind: 'fixed' as const }],
    }
    const ids = { thread_id: 'general', card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6' }
    // The test used to list its 19 templates by hand. An empty or shrunken list would let the loop below pass without checking them.
    expect(PUSH_TEMPLATES.length).toBeGreaterThanOrEqual(19)
    for (const template of PUSH_TEMPLATES) {
      const built = buildPushPayload({ template, count: 3, replies: 2, cards: 1, ...ids }, cfg)
      const parsed = parsePush(JSON.parse(JSON.stringify(built)))
      // A payload the app cannot parse would silently become the generic "You have an update." fallback.
      expect(parsed, template).not.toBeNull()
      const n = notificationFromPayload(parsed as NonNullable<typeof parsed>)
      expect(n.title, template).toBe(built.notification.title)
      expect(n.options.body, template).toBe(built.notification.body)
      expect(n.options.data.navigate, template).toBe(built.notification.navigate)
    }
  })
  it('sent_always_allowed (a send made without a card) opens its thread, like settings_changed, in fixed words', () => {
    const cfg = {
      agent: { name: 'Talos' },
      notifications: { show_thread_names: 'all' as const },
      threads: [{ id: 'errands', name: 'Errands', kind: 'fixed' as const }],
    }
    for (const template of ['sent_always_allowed', 'settings_changed'] as const) {
      const parsed = parsePush(JSON.parse(JSON.stringify(buildPushPayload({ template, thread_id: 'errands' }, cfg))))
      expect(parsed, template).not.toBeNull()
      const n = notificationFromPayload(parsed as NonNullable<typeof parsed>)
      expect(n.options.data.navigate, template).toBe('/t/errands')
      expect(safeNavigateTarget(n.options.data.navigate, 'https://app.example.com'), template).toBe('/t/errands')
    }
    const built = buildPushPayload({ template: 'sent_always_allowed', thread_id: 'errands' }, cfg)
    expect(built.notification.body).toBe('Talos sent something you always allow')
  })

  it('notification clicks only open in-scope paths', () => {
    const o = 'https://app.example.com'
    expect(safeNavigateTarget('/card/c_1', o)).toBe('/card/c_1')
    expect(safeNavigateTarget('/t/general?x=1#y', o)).toBe('/t/general?x=1#y')
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      '',
      undefined,
      5,
      'card',
    ])
      expect(safeNavigateTarget(bad, o)).toBe('/')
  })
  it('a push is quiet only for a visible, focused window already on that thread', () => {
    const o = 'https://app.example.com'
    const push = (thread?: string) => ({
      web_push: 8030,
      notification: { title: 'Talos', body: 'New reply in General', navigate: '/t/general', silent: false },
      talos: { v: 1, kind: 'reply', ...(thread ? { thread_id: thread } : {}) },
    })
    const win = (url: string, visibilityState = 'visible', focused = true) => ({ url, visibilityState, focused })
    expect(viewingPushThread(push('general'), [win(`${o}/t/general`)], o)).toBe(true)
    expect(viewingPushThread(push('general'), [win(`${o}/t/other`)], o)).toBe(false)
    expect(viewingPushThread(push('general'), [win(`${o}/t/general`, 'hidden')], o)).toBe(false)
    expect(viewingPushThread(push('general'), [win(`${o}/t/general`, 'visible', false)], o)).toBe(false)
    expect(viewingPushThread(push('general'), [win('https://evil.example/t/general')], o)).toBe(false)
    expect(viewingPushThread(push(), [win(`${o}/t/general`)], o)).toBe(false) // an opaque (Apple) payload names no thread
    expect(viewingPushThread({ junk: true }, [win(`${o}/t/general`)], o)).toBe(false)
  })
})

describe('a push with real words', () => {
  const cfg = {
    agent: { name: 'Talos' },
    notifications: { show_thread_names: 'all' as const },
    threads: [{ id: 'general', name: 'General', kind: 'fixed' as const }],
  }
  const generic = buildPushPayload({ template: 'reply', thread_id: 'general' }, cfg)

  it('shows the thread name and the preview, and asks to be heard again', () => {
    const n = notificationForPush(withPushWords(generic, { thread: 'General', text: 'Lunch is at noon.' }))
    expect(n.title).toBe('General')
    expect(n.options.body).toBe('Lunch is at noon.')
    expect(n.options.renotify).toBe(true)
    expect(n.options.data).toMatchObject({ navigate: '/t/general', kind: 'reply', thread_id: 'general' })
  })

  it("a payload from a relay that sends no words still shows today's fixed text", () => {
    const n = notificationForPush(generic)
    expect(n.title).toBe('Talos')
    expect(n.options.body).toBe('New reply in General')
  })

  it('a payload that breaks the limits is not shown as words: the fixed fallback, never the text', () => {
    const tooLong = { ...generic, notification: { ...generic.notification, body: 'x'.repeat(500) } }
    const n = notificationForPush(tooLong)
    expect(n.options.body).toBe('You have an update.')
    expect(JSON.stringify(n)).not.toContain('xxxxx')
  })
})
