import { describe, expect, it } from 'vitest'
import {
  APNS_CATEGORIES,
  ApnsRegistration,
  buildApnsBody,
  buildPushPayload,
  type PushConfig,
  type PushIntent,
  PushPayload,
} from '../src/index.ts'

const config: PushConfig = {
  agent: { name: 'Talos' },
  notifications: { show_thread_names: 'fixed_only' },
  threads: [
    { id: 'general', name: 'General', kind: 'fixed' },
    { id: 'inbox', name: 'Inbox', kind: 'system' },
    { id: 'secret_plan', name: 'Q3 layoffs plan', kind: 'agent' },
  ],
}
const CARD = 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6'

describe('buildPushPayload', () => {
  it('uses the fixed templates and validates against PushPayload', () => {
    const cases: Array<[PushIntent, string]> = [
      [{ template: 'reply', thread_id: 'general' }, 'New reply in General'],
      [{ template: 'needs_you', thread_id: 'general', card_id: CARD }, 'Needs you in General'],
      [{ template: 'answer_ready', thread_id: 'general' }, 'Answer ready in General'],
      [{ template: 'overnight', count: 7 }, 'Overnight: 7 items'],
      [{ template: 'session_stopped' }, "Talos's Mac session stopped"],
      [{ template: 'device_pinned' }, 'New device pinned'],
      [{ template: 'bridge_key' }, 'Your bridge key may be in use somewhere else'],
      [{ template: 'sign_in' }, 'New sign-in to Talos'],
      [{ template: 'sign_in_unproven' }, 'Sign-in on a device that did not prove its key'],
      [{ template: 'storage_full' }, 'Relay storage is nearly full'],
    ]
    for (const [intent, body] of cases) {
      const p = buildPushPayload(intent, config)
      expect(PushPayload.safeParse(p).success).toBe(true)
      expect(p.notification.body).toBe(body)
      expect(p.notification.title).toBe('Talos')
      expect(p.notification.silent).toBe(false)
      expect(p.web_push).toBe(8030)
    }
  })

  it('hides agent-created thread names under fixed_only, shows them under all, hides everything under none', () => {
    const i: PushIntent = { template: 'reply', thread_id: 'secret_plan' }
    expect(buildPushPayload(i, config).notification.body).toBe('New reply in a thread')
    expect(buildPushPayload(i, { ...config, notifications: { show_thread_names: 'all' } }).notification.body).toBe(
      'New reply in Q3 layoffs plan',
    )
    expect(
      buildPushPayload(
        { template: 'reply', thread_id: 'general' },
        { ...config, notifications: { show_thread_names: 'none' } },
      ).notification.body,
    ).toBe('New reply in a thread')
    expect(buildPushPayload({ template: 'reply', thread_id: 'ghost' }, config).notification.body).toBe(
      'New reply in a thread',
    )
  })

  it('deep links stay in scope', () => {
    expect(buildPushPayload({ template: 'reply', thread_id: 'general' }, config).notification.navigate).toBe(
      '/t/general',
    )
    expect(
      buildPushPayload({ template: 'needs_you', thread_id: 'general', card_id: CARD }, config).notification.navigate,
    ).toBe(`/card/${CARD}`)
    expect(buildPushPayload({ template: 'overnight', count: 1 }, config).notification.navigate).toBe('/t/inbox')
    // docs/V2-FEATURES.md V1.3: session_stopped opens Settings -> Health like the other health templates
    expect(buildPushPayload({ template: 'session_stopped' }, config).notification.navigate).toBe('/settings/health')
    // junk ids never become a path
    expect(buildPushPayload({ template: 'reply', thread_id: '../../evil' }, config).notification.navigate).toBe('/')
    expect(
      buildPushPayload({ template: 'needs_you', card_id: 'javascript:alert(1)' }, config).notification.navigate,
    ).toBe('/')
  })

  it('property: random text in message/card/sender fields never appears in the output', () => {
    let seed = 0x9e3779b9
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const alphabet =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 <>"\'&;:/\\\u00e9\u4e2d\ud83d\ude00'
    const templates = [
      'reply',
      'needs_you',
      'answer_ready',
      'overnight',
      'session_stopped',
      'device_pinned',
      'bridge_key',
      'storage_full',
    ] as const
    for (let n = 0; n < 500; n++) {
      const text = `zz${Array.from({ length: 12 + Math.floor(rnd() * 40) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('')}zz`
      const intent = {
        template: templates[n % templates.length],
        thread_id: n % 2 ? 'general' : undefined,
        // fields a careless caller might try to smuggle in; the type has nowhere for them
        text,
        message_text: text,
        title: text,
        card_title: text,
        sender: text,
        subject: text,
        summary: text,
      } as unknown as PushIntent
      const json = JSON.stringify(buildPushPayload(intent, config))
      expect(json).not.toContain(text)
      expect(json).not.toContain(text.slice(2, 14))
    }
  })

  it('caps the title at 40 and the body at 80 characters', () => {
    const p = buildPushPayload({ template: 'bridge_key' }, { ...config, agent: { name: 'x'.repeat(100) } })
    expect(p.notification.title.length).toBeLessThanOrEqual(40)
    expect(p.notification.body.length).toBeLessThanOrEqual(80)
  })
})

describe('buildApnsBody (WP-I5)', () => {
  it('property: random text in message/card/sender/subject fields never reaches the APNs body', () => {
    let seed = 0x1234567
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const alphabet =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 <>"\'&;:/\\\u00e9\u4e2d\ud83d\ude00'
    const templates = [
      'reply',
      'needs_you',
      'answer_ready',
      'overnight',
      'session_stopped',
      'device_pinned',
      'schedule_failed',
      'mac_back',
    ] as const
    for (let n = 0; n < 500; n++) {
      const text = `zz${Array.from({ length: 12 + Math.floor(rnd() * 40) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('')}zz`
      const intent = {
        template: templates[n % templates.length],
        thread_id: n % 2 ? 'general' : undefined,
        card_id: n % 3 ? CARD : undefined,
        text,
        message_text: text,
        title: text,
        card_title: text,
        sender: text,
        subject: text,
      } as unknown as PushIntent
      const json = JSON.stringify(buildApnsBody(buildPushPayload(intent, config)))
      expect(json).not.toContain(text)
      expect(json).not.toContain(text.slice(2, 14))
    }
  })

  it('keeps aps small and shaped: fixed alert, badge, a known category, the thread tag', () => {
    const p = buildPushPayload({ template: 'needs_you', thread_id: 'general', card_id: CARD, app_badge: 4 }, config)
    const b = buildApnsBody(p)
    expect(b.aps).toEqual({
      alert: { title: 'Talos', body: 'Needs you in General' },
      badge: 4,
      sound: 'default',
      category: APNS_CATEGORIES.card,
      'thread-id': `card:${CARD}`,
      'interruption-level': 'time-sensitive', // D25: a card breaks through Focus; nothing else does
    })
    expect(b.talos).toMatchObject({ v: 1, kind: 'card', card_id: CARD, navigate: `/card/${CARD}` })
    expect(JSON.stringify(b).length).toBeLessThan(4096)
  })

  it('only a card push with a card id gets the Approve category; everything else is Open', () => {
    const cat = (i: PushIntent) => buildApnsBody(buildPushPayload(i, config)).aps.category
    expect(cat({ template: 'needs_you', card_id: CARD })).toBe('TALOS_CARD')
    expect(cat({ template: 'needs_you', thread_id: 'general' })).toBe('TALOS_OPEN')
    expect(cat({ template: 'reply', thread_id: 'general' })).toBe('TALOS_OPEN')
    expect(cat({ template: 'device_pinned' })).toBe('TALOS_OPEN')
  })

  it('omits the badge when unknown and never sends a negative one', () => {
    expect(buildApnsBody(buildPushPayload({ template: 'reply' }, config)).aps.badge).toBeUndefined()
    expect(buildApnsBody(buildPushPayload({ template: 'reply', app_badge: -3 }, config)).aps.badge).toBe(0)
  })
})

describe('ApnsRegistration', () => {
  const ok = {
    v: 1,
    type: 'push.apns',
    op: 'register',
    device_id: 'd_abcdefghijklmnopqrst',
    token: 'a'.repeat(64),
    env: 'sandbox',
    ts: '2026-10-31T15:00:00.000Z',
    nonce: 'n'.repeat(20),
    osig: 'x'.repeat(86),
  }
  it('accepts the exact shape and an unregister without a token', () => {
    expect(ApnsRegistration.safeParse(ok).success).toBe(true)
    const { token: _t, env: _e, ...rest } = ok
    expect(ApnsRegistration.safeParse({ ...rest, op: 'unregister' }).success).toBe(true)
  })
  it('refuses a register without token or env, unknown fields, unknown env and uppercase tokens', () => {
    const { token: _t, ...noToken } = ok
    expect(ApnsRegistration.safeParse(noToken).success).toBe(false)
    expect(ApnsRegistration.safeParse({ ...ok, extra: 1 }).success).toBe(false)
    expect(ApnsRegistration.safeParse({ ...ok, env: 'staging' }).success).toBe(false)
    expect(ApnsRegistration.safeParse({ ...ok, token: 'A'.repeat(64) }).success).toBe(false)
  })
})
