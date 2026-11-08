import { describe, expect, it } from 'vitest'
import {
  NATIVE_FEATURES_MAX,
  NATIVE_TO_WEB,
  NATIVE_VOICE_NOTE_MAX_BYTES,
  NativeToWeb,
  WEB_TO_NATIVE,
  WebToNative,
} from '../src/native.ts'

const ok = {
  ready: { type: 'ready', shell_api: 1, features: ['notify', 'badge'], signed_in: false },
  notify: { type: 'notify', title: 'Talos', body: 'hi', navigate: '/t/general', tag: 'general' },
  badge: { type: 'badge', count: 3 },
  open_external: { type: 'open_external', url: 'https://example.com/a?b=1' },
  haptic: { type: 'haptic', kind: 'success' },
  threads: { type: 'threads', items: [{ id: 'general', name: 'General' }] },
  pair_status: { type: 'pair_status', state: 'waiting_pin' },
  companion_state: {
    type: 'companion_state',
    link: 'online',
    mac_online: true,
    busy: false,
    needs: 1,
    working: 2,
    queued: 0,
    on_call: 0,
    unread: 3,
    failed: 0,
    rows: [{ thread_id: 'general', state: 'needs_you' }],
    last_reply: { thread_id: 'general', seq: 48123 },
  },
  companion_reply: {
    type: 'companion_reply',
    req: 'r12',
    thread_id: 'general',
    text: 'Plain text here.',
    truncated: false,
  },
  terminal_view: { type: 'terminal_view', rect: { x: 240, y: 0, width: 880, height: 780 }, session: 'trip' },
  terminal_resume: { type: 'terminal_resume', thread_id: 'trip' },
  terminal_leave: { type: 'terminal_leave' },
} as const

describe('web -> native bridge messages', () => {
  it('accepts every documented message', () => {
    for (const [k, m] of Object.entries(ok)) expect(WebToNative.safeParse(m).success, k).toBe(true)
    expect(Object.keys(WEB_TO_NATIVE).sort()).toEqual(Object.keys(ok).sort())
  })
  it('is strict: unknown fields and unknown types are refused', () => {
    expect(WebToNative.safeParse({ ...ok.badge, extra: 1 }).success).toBe(false)
    expect(WebToNative.safeParse({ type: 'eval', js: 'alert(1)' }).success).toBe(false)
    expect(WebToNative.safeParse({ ...ok.ready, shell_api: 2 }).success).toBe(false)
    expect(WebToNative.safeParse({ ...ok.pair_status, state: 'pinned!' }).success).toBe(false)
    expect(WebToNative.safeParse({ ...ok.badge, count: -1 }).success).toBe(false)
    expect(WebToNative.safeParse({ ...ok.badge, count: 1.5 }).success).toBe(false)
  })
  it('notify.tag is optional; navigate must be an in-app path', () => {
    const { tag: _t, ...noTag } = ok.notify
    expect(WebToNative.safeParse(noTag).success).toBe(true)
    expect(WebToNative.safeParse({ ...ok.notify, navigate: 'https://evil.example.net' }).success).toBe(false)
    expect(WebToNative.safeParse({ ...ok.notify, navigate: '//evil.example.net' }).success).toBe(false)
  })
  it('open_external allows http(s) and mailto only', () => {
    for (const url of ['http://a.example', 'https://a.example/x', 'mailto:me@example.com'])
      expect(WebToNative.safeParse({ type: 'open_external', url }).success, url).toBe(true)
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'tel:123',
      'data:text/html,hi',
      'intent://x',
      '//a.example',
      '',
    ])
      expect(WebToNative.safeParse({ type: 'open_external', url }).success, url).toBe(false)
  })
  it('caps feature lists', () => {
    const features = Array.from({ length: NATIVE_FEATURES_MAX + 1 }, (_, i) => `f${i}`)
    expect(WebToNative.safeParse({ ...ok.ready, features }).success).toBe(false)
  })
})

describe('companion feed messages', () => {
  const state = ok.companion_state
  it('companion_state is counts and ids only: any extra field, name or text is refused', () => {
    expect(WebToNative.safeParse({ ...state, text: 'hello' }).success).toBe(false)
    expect(
      WebToNative.safeParse({ ...state, rows: [{ thread_id: 'general', state: 'ready', name: 'General' }] }).success,
    ).toBe(false)
    expect(WebToNative.safeParse({ ...state, last_reply: { thread_id: 'general', seq: 1, text: 'hi' } }).success).toBe(
      false,
    )
  })
  it('refuses a bad count, row state, thread id, link and an oversize row list', () => {
    expect(WebToNative.safeParse({ ...state, needs: -1 }).success).toBe(false)
    expect(WebToNative.safeParse({ ...state, needs: 1.5 }).success).toBe(false)
    expect(WebToNative.safeParse({ ...state, working: 100_000 }).success).toBe(false)
    expect(WebToNative.safeParse({ ...state, link: 'sleeping' }).success).toBe(false)
    expect(WebToNative.safeParse({ ...state, rows: [{ thread_id: 'general', state: 'angry' }] }).success).toBe(false)
    expect(WebToNative.safeParse({ ...state, rows: [{ thread_id: 'All', state: 'ready' }] }).success).toBe(false)
    const row = { thread_id: 'general', state: 'ready' }
    expect(WebToNative.safeParse({ ...state, rows: Array.from({ length: 12 }, () => row) }).success).toBe(true)
    expect(WebToNative.safeParse({ ...state, rows: Array.from({ length: 13 }, () => row) }).success).toBe(false)
  })
  it('last_reply may be null; a negative or fractional seq is refused', () => {
    expect(WebToNative.safeParse({ ...state, last_reply: null }).success).toBe(true)
    expect(WebToNative.safeParse({ ...state, last_reply: { thread_id: 'general', seq: -1 } }).success).toBe(false)
    expect(WebToNative.safeParse({ ...state, last_reply: { thread_id: 'general', seq: 1.5 } }).success).toBe(false)
  })
  it('companion_reply is plain text of at most 500 characters, or null', () => {
    const r = ok.companion_reply
    expect(WebToNative.safeParse({ ...r, text: null }).success).toBe(true)
    expect(WebToNative.safeParse({ ...r, text: 'a'.repeat(500) }).success).toBe(true)
    expect(WebToNative.safeParse({ ...r, text: 'a'.repeat(501) }).success).toBe(false)
    expect(WebToNative.safeParse({ ...r, req: '' }).success).toBe(false)
    expect(WebToNative.safeParse({ ...r, req: 'r 1' }).success).toBe(false)
  })
  it('companion_reply_request is native -> web only, with a request id and a thread id', () => {
    const q = { type: 'companion_reply_request', req: 'r12', thread_id: 'general' }
    expect(NativeToWeb.safeParse(q).success).toBe(true)
    expect(WebToNative.safeParse(q).success).toBe(false)
    expect(NativeToWeb.safeParse({ ...q, thread_id: 'all' }).success).toBe(false)
    expect(NativeToWeb.safeParse({ ...q, req: 'x'.repeat(33) }).success).toBe(false)
    expect(NativeToWeb.safeParse({ ...q, text: 'hi' }).success).toBe(false)
    expect(NativeToWeb.safeParse(ok.companion_state).success).toBe(false)
  })
})

describe('terminal_view', () => {
  const open = ok.terminal_view
  it('carries one rectangle in whole page pixels, or null to close the view', () => {
    expect(WebToNative.safeParse({ type: 'terminal_view', rect: null }).success).toBe(true)
    expect(WebToNative.safeParse({ type: 'terminal_view' }).success).toBe(false)
    expect(WebToNative.safeParse({ ...open, rect: { ...open.rect, x: 0.5 } }).success).toBe(false)
    expect(WebToNative.safeParse({ ...open, rect: { ...open.rect, width: -1 } }).success).toBe(false)
    expect(WebToNative.safeParse({ ...open, rect: { ...open.rect, height: 20_001 } }).success).toBe(false)
    expect(WebToNative.safeParse({ ...open, rect: { x: 0, y: 0, width: 1 } }).success).toBe(false)
  })
  it('is strict: no extra field, and it only travels web -> native', () => {
    expect(WebToNative.safeParse({ ...open, text: 'ls' }).success).toBe(false)
    expect(WebToNative.safeParse({ ...open, rect: { ...open.rect, keys: 'ls' } }).success).toBe(false)
    expect(NativeToWeb.safeParse(open).success).toBe(false)
  })
})

const HOSTILE_IDS = [
  '../etc',
  'Trip',
  't-trip',
  '=agent',
  'a;b',
  'a b',
  'trip\n',
  '',
  'all',
  '1trip',
  'x'.repeat(33),
  'trip:0',
  '$(id)',
]

describe('terminal_view session and terminal_resume (page -> shell, untrusted)', () => {
  const view = (session: unknown) => ({ type: 'terminal_view', rect: null, session })
  it('session is optional, "main" or a thread id', () => {
    expect(WebToNative.safeParse({ type: 'terminal_view', rect: null }).success).toBe(true)
    expect(WebToNative.safeParse(view('main')).success).toBe(true)
    expect(WebToNative.safeParse(view('trip')).success).toBe(true)
  })
  it('a hostile session or thread id is refused, not clamped', () => {
    for (const id of HOSTILE_IDS) {
      if (id === 'all' || id === '') expect(WebToNative.safeParse(view(id)).success, id).toBe(false)
      else expect(WebToNative.safeParse(view(id)).success, id).toBe(false)
      expect(WebToNative.safeParse({ type: 'terminal_resume', thread_id: id }).success, `resume ${id}`).toBe(false)
    }
    for (const bad of [null, 7, ['trip'], { id: 'trip' }]) expect(WebToNative.safeParse(view(bad)).success).toBe(false)
  })
  it('terminal_resume names a thread, never main, and takes nothing else', () => {
    expect(WebToNative.safeParse({ type: 'terminal_resume', thread_id: 'trip' }).success).toBe(true)
    expect(WebToNative.safeParse({ type: 'terminal_resume' }).success).toBe(false)
    expect(WebToNative.safeParse({ type: 'terminal_resume', thread_id: 'trip', keys: 'ls' }).success).toBe(false)
    expect(NativeToWeb.safeParse({ type: 'terminal_resume', thread_id: 'trip' }).success).toBe(false)
  })
})

describe('terminal_leave and terminal_select', () => {
  it('terminal_leave is page -> shell only and carries nothing', () => {
    expect(WebToNative.safeParse({ type: 'terminal_leave' }).success).toBe(true)
    expect(WebToNative.safeParse({ type: 'terminal_leave', rect: null }).success).toBe(false)
    expect(NativeToWeb.safeParse({ type: 'terminal_leave' }).success).toBe(false)
  })
  it('terminal_select names main or a thread id, and refuses anything else', () => {
    expect(NativeToWeb.safeParse({ type: 'terminal_select', session: 'main' }).success).toBe(true)
    for (const id of HOSTILE_IDS)
      expect(NativeToWeb.safeParse({ type: 'terminal_select', session: id }).success, id).toBe(false)
    expect(WebToNative.safeParse({ type: 'terminal_select', session: 'main' }).success).toBe(false)
  })
})

describe('terminal_sessions (shell -> page)', () => {
  const item = (o: Record<string, unknown> = {}) => ({
    id: 'trip',
    name: 'OC Test',
    state: 'working',
    key: '2',
    panel: 'terminal',
    action: null,
    detail: '',
    ...o,
  })
  const parse = (items: unknown[]) => {
    const r = NativeToWeb.safeParse({ type: 'terminal_sessions', items })
    if (!r.success || r.data.type !== 'terminal_sessions') throw new Error('refused')
    return r.data.items
  }
  it('an unknown state or panel degrades that one tab; the others stay', () => {
    const got = parse([
      item({ id: 'main', name: 'Main', state: 'live', key: '1' }),
      item({ state: 'levitating', panel: 'hologram', action: 'dance' }),
    ])
    expect(got.map((g) => g.id)).toEqual(['main', 'trip'])
    expect(got[1]).toMatchObject({ state: 'unknown', panel: 'note', action: null })
    expect(got[0]?.state).toBe('live')
  })
  it('an item with a hostile id or no name is dropped, not the frame', () => {
    const got = parse([
      item({ id: 'main', name: 'Main' }),
      ...HOSTILE_IDS.map((id) => item({ id })),
      item({ name: '' }),
      'junk',
      null,
      item({ id: 'ok2' }),
    ])
    expect(got.map((g) => g.id)).toEqual(['main', 'ok2'])
  })
  it('a field a newer shell adds is ignored; an older frame without key or detail still reads', () => {
    expect(parse([{ ...item(), badge_color: 'red' }])).toHaveLength(1)
    const old = parse([{ id: 'main', name: 'Main', state: 'live' }])
    expect(old[0]).toMatchObject({ id: 'main', key: null, panel: 'note', detail: '' })
  })
  it('more than 101 items is refused (a bug, not a list)', () => {
    expect(
      NativeToWeb.safeParse({ type: 'terminal_sessions', items: Array.from({ length: 102 }, () => item()) }).success,
    ).toBe(false)
    expect(WebToNative.safeParse({ type: 'terminal_sessions', items: [] }).success).toBe(false)
  })
  it('terminal_resume_result refuses an outcome it does not know and a hostile id', () => {
    const r = { type: 'terminal_resume_result', thread_id: 'trip', outcome: 'asked' }
    expect(NativeToWeb.safeParse(r).success).toBe(true)
    expect(NativeToWeb.safeParse({ ...r, outcome: 'maybe' }).success).toBe(false)
    expect(NativeToWeb.safeParse({ ...r, thread_id: '../x' }).success).toBe(false)
  })
})

describe('native -> web bridge messages', () => {
  const good = {
    navigate: { type: 'navigate', path: '/t/general' },
    compose: { type: 'compose', thread_id: 'general', text: 'hello' },
    voice_note: { type: 'voice_note', thread_id: 'general', mime: 'audio/mp4', duration_ms: 1200, bytes_b64: 'AAAA' },
    enroll_code: { type: 'enroll_code', code: '0123456789ABCDEFGHJKMNPQRS' },
    companion_reply_request: { type: 'companion_reply_request', req: 'r12', thread_id: 'general' },
    companion_replies: { type: 'companion_replies', on: true },
    notify_permission: { type: 'notify_permission', state: 'denied' },
    terminal_sessions: {
      type: 'terminal_sessions',
      items: [
        {
          id: 'main',
          name: 'Main',
          state: 'live',
          key: '1',
          panel: 'terminal',
          action: null,
          detail: 'Main is running.',
        },
      ],
    },
    terminal_resume_result: { type: 'terminal_resume_result', thread_id: 'trip', outcome: 'asked' },
    terminal_select: { type: 'terminal_select', session: 'trip' },
  } as const
  it('companion_replies is native -> web only, a boolean and an optional list of what he showed', () => {
    expect(WebToNative.safeParse(good.companion_replies).success).toBe(false)
    for (const bad of [{ on: 1 }, { on: 'true' }, {}, { on: true, extra: 1 }])
      expect(NativeToWeb.safeParse({ type: 'companion_replies', ...bad }).success).toBe(false)
    expect(NativeToWeb.safeParse({ type: 'companion_replies', on: false }).success).toBe(true)
    const shown = [{ thread_id: 'ops', seq: 7 }]
    expect(NativeToWeb.safeParse({ type: 'companion_replies', on: true, shown, epoch: 3 }).success).toBe(true)
    for (const epoch of [-1, 1.5, '3'])
      expect(NativeToWeb.safeParse({ type: 'companion_replies', on: true, epoch }).success).toBe(false)
    for (const bad of [
      [{ thread_id: 'ops' }],
      [{ thread_id: 'ops', seq: -1 }],
      [{ thread_id: 'all', seq: 1 }],
      [{ thread_id: 'ops', seq: 1, extra: 1 }],
      Array.from({ length: 13 }, (_, i) => ({ thread_id: `t${i}`, seq: i })),
    ])
      expect(NativeToWeb.safeParse({ type: 'companion_replies', on: true, shown: bad }).success).toBe(false)
  })
  it('companion_state carries the thread on screen and the replies it holds, both optional', () => {
    const frame = ok.companion_state as Record<string, unknown>
    expect(WebToNative.safeParse({ ...frame, viewing: 'general', held: [{ thread_id: 'ops', seq: 4 }] }).success).toBe(
      true,
    )
    expect(WebToNative.safeParse({ ...frame, viewing: null, held: [] }).success).toBe(true)
    expect(WebToNative.safeParse(frame).success).toBe(true)
    expect(WebToNative.safeParse({ ...frame, replies_epoch: 3 }).success).toBe(true)
    expect(WebToNative.safeParse({ ...frame, replies_epoch: null }).success).toBe(true)
    for (const bad of [
      { viewing: 'All' },
      { viewing: 5 },
      { held: [{ thread_id: 'ops' }] },
      { held: 'ops' },
      { replies_epoch: -1 },
      { replies_epoch: '3' },
    ])
      expect(WebToNative.safeParse({ ...frame, ...bad }).success, JSON.stringify(bad)).toBe(false)
  })
  it('notify_permission refuses a state it does not know', () => {
    expect(NativeToWeb.safeParse({ type: 'notify_permission', state: 'maybe' }).success).toBe(false)
    expect(NativeToWeb.safeParse({ ...good.notify_permission, extra: 1 }).success).toBe(false)
  })
  it('accepts every documented message', () => {
    for (const [k, m] of Object.entries(good)) expect(NativeToWeb.safeParse(m).success, k).toBe(true)
    expect(Object.keys(NATIVE_TO_WEB).sort()).toEqual(Object.keys(good).sort())
  })
  it('is strict and directional', () => {
    expect(NativeToWeb.safeParse({ ...good.compose, extra: 1 }).success).toBe(false)
    expect(NativeToWeb.safeParse({ type: 'badge', count: 1 }).success).toBe(false)
    expect(WebToNative.safeParse(good.compose).success).toBe(false)
  })
  it('voice_note is capped at 25 MB decoded', () => {
    const fit = Math.floor(NATIVE_VOICE_NOTE_MAX_BYTES / 3) * 4
    expect(NativeToWeb.safeParse({ ...good.voice_note, bytes_b64: 'A'.repeat(fit) }).success).toBe(true)
    expect(NativeToWeb.safeParse({ ...good.voice_note, bytes_b64: 'A'.repeat(fit + 8) }).success).toBe(false)
    expect(NativeToWeb.safeParse({ ...good.voice_note, bytes_b64: 'not base64!' }).success).toBe(false)
  })
})

describe('in-app paths (notify.navigate and native navigate)', () => {
  const bad = [
    '/\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    '/\\/evil.example',
    '/\u0000x',
    '/a b',
    '//evil.example',
    '/.//evil.example',
    'https://evil.example',
    'evil',
    '',
    '/media/med_x',
    '/%6dedia/x',
    '/%61pi/devices',
    '/%256dedia/x',
    '/%2fevil.example',
    '/%5cevil.example',
    '/%0a',
    '/api/devices',
    '/x\'"<',
  ]
  const good = ['/', '/t/general', '/t/general?m=1#top', '/settings/devices', '/a/../b']
  it('notify.navigate and navigate {path} accept only a safe in-app path', () => {
    for (const p of bad) {
      expect(
        WebToNative.safeParse({ type: 'notify', title: 't', body: 'b', navigate: p }).success,
        JSON.stringify(p),
      ).toBe(false)
      expect(NativeToWeb.safeParse({ type: 'navigate', path: p }).success, JSON.stringify(p)).toBe(false)
    }
    for (const p of good) {
      expect(WebToNative.safeParse({ type: 'notify', title: 't', body: 'b', navigate: p }).success, p).toBe(true)
      expect(NativeToWeb.safeParse({ type: 'navigate', path: p }).success, p).toBe(true)
    }
  })
  it('nothing the schema accepts resolves off-origin', () => {
    for (const p of good) expect(new URL(p, 'https://relay.example.com').origin).toBe('https://relay.example.com')
  })
})
