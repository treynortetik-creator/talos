import { AgentConfig, buildPushPayload } from '@talos-app/protocol'
import readyFixture from '@talos-app/protocol/fixtures/frames/ready.json'
import { describe, expect, it, vi } from 'vitest'
import { nativeNotification } from '../../src/features/native/notify.ts'
import { createDesktopPlatform } from '../../src/lib/native/adapters.ts'
import { createShellBridge } from '../../src/lib/native/bridge.ts'
import { detectShell } from '../../src/lib/native/detect.ts'

const UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 TalosDesktop/1.0'
const handler = () => ({ postMessage: () => {} })
function desktopScope(over: Record<string, unknown> = {}) {
  const s: Record<string, unknown> = {
    webkit: { messageHandlers: { talos: handler() } },
    navigator: { userAgent: UA },
    ...over,
  }
  s.top = s
  return s
}

describe('detectShell', () => {
  it('is none in a plain browser', () => {
    expect(detectShell({})).toBe('none')
    expect(detectShell(undefined)).toBe('none')
    expect(detectShell(null)).toBe('none')
  })
  it('is desktop with the handler AND the UA suffix in the top frame', () => {
    expect(detectShell(desktopScope())).toBe('desktop')
  })
  it('a normal page that defines the handler without the UA suffix stays none', () => {
    expect(detectShell(desktopScope({ navigator: { userAgent: 'Mozilla/5.0 Safari' } }))).toBe('none')
  })
  it('the UA suffix without the handler stays none', () => {
    expect(detectShell(desktopScope({ webkit: undefined }))).toBe('none')
    expect(detectShell(desktopScope({ webkit: { messageHandlers: { talos: {} } } }))).toBe('none')
  })
  it('an iframe (top is another window) is never a shell', () => {
    const s = desktopScope()
    s.top = {}
    expect(detectShell(s)).toBe('none')
    const cap = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' }, top: {} }
    expect(detectShell(cap)).toBe('none')
  })
  it('a hostile top getter does not throw', () => {
    const s = desktopScope()
    Object.defineProperty(s, 'top', {
      get() {
        throw new Error('cross-origin')
      },
    })
    expect(detectShell(s)).toBe('none')
  })
  it('the iPhone shell is not this detector (lib/native.ts owns it)', () => {
    const s: Record<string, unknown> = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' } }
    s.top = s
    expect(detectShell(s)).toBe('none')
  })
})

describe('shell bridge', () => {
  it('posts only valid web -> native messages', () => {
    const post = vi.fn()
    const b = createShellBridge({ post })
    expect(b.send({ type: 'badge', count: 2 })).toBe(true)
    expect(post).toHaveBeenCalledWith({ type: 'badge', count: 2 })
    expect(b.send({ type: 'open_external', url: 'javascript:alert(1)' } as never)).toBe(false)
    expect(post).toHaveBeenCalledTimes(1)
  })
  it('a throwing transport reports false', () => {
    const b = createShellBridge({
      post() {
        throw new Error('x')
      },
    })
    expect(b.send({ type: 'badge', count: 1 })).toBe(false)
  })
  it('dispatches valid native -> web messages and drops the rest', () => {
    const b = createShellBridge({ post() {} })
    const compose = vi.fn()
    const navigate = vi.fn()
    b.setHandlers({ compose, navigate })
    expect(b.receive(JSON.stringify({ type: 'compose', thread_id: 'general', text: 'hi' }))).toBe(true)
    expect(compose).toHaveBeenCalledTimes(1)
    expect(b.receive({ type: 'navigate', path: '/t/general' })).toBe(true)
    // the media space, protocol-relative and absolute targets never navigate
    for (const path of ['/media/x', '//evil.com', 'https://evil.com', '/%6dedia/x', '/\\evil.com'])
      expect(b.receive({ type: 'navigate', path })).toBe(false)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(b.receive('not json')).toBe(false)
    expect(b.receive({ type: 'eval', js: '1' })).toBe(false)
    expect(b.receive({ type: 'compose', thread_id: 'general', text: 'hi', extra: 1 })).toBe(false)
    expect(compose).toHaveBeenCalledTimes(1)
  })
  it('a handler that returns a promise makes receive answer with that promise: true when it resolves, false when it rejects', async () => {
    const b = createShellBridge({ post() {} })
    const compose = vi.fn(async () => {})
    b.setHandlers({ compose })
    const msg = { type: 'compose', thread_id: 'general', text: 'hi' }
    expect(await b.receive(msg)).toBe(true)
    compose.mockRejectedValueOnce(new Error('no'))
    expect(await b.receive(msg)).toBe(false)
  })
  it('a message with no handler is dropped', () => {
    const b = createShellBridge({ post() {} })
    expect(b.receive({ type: 'navigate', path: '/x' })).toBe(false)
  })
})

describe('adapters', () => {
  it('desktop: external links go to the shell, only http(s) and mailto', () => {
    const post = vi.fn()
    const p = createDesktopPlatform(createShellBridge({ post }))
    expect(p.openExternal('https://example.com/a')).toBe(true)
    expect(p.openExternal('javascript:alert(1)')).toBe(false)
    expect(p.openExternal('file:///etc/passwd')).toBe(false)
    expect(post).toHaveBeenCalledTimes(1)
    expect(p.installState()).toBe('installed')
    expect(p.isIos()).toBe(false)
    expect(p.push.permission()).toBe('unsupported')
    // V3 additions survive the spread
    expect(typeof p.audioSession.set).toBe('function')
    expect(typeof p.wakeLock.acquire).toBe('function')
    expect(typeof p.mediaSession.set).toBe('function')
    expect(typeof p.speech.speak).toBe('function')
  })
  it('desktop: http is refused like the browser adapter, https and mailto pass', () => {
    const post = vi.fn()
    const p = createDesktopPlatform(createShellBridge({ post }))
    expect(p.openExternal('http://example.com')).toBe(false)
    expect(p.openExternal('mailto:a@example.com')).toBe(true)
    expect(post).toHaveBeenCalledTimes(1)
  })
})

describe('nativeNotification', () => {
  const cfg = AgentConfig.parse(readyFixture.agent_config)
  const tid = cfg.threads[0]?.id ?? 'general'
  it('equals the push builder output and carries no message text', () => {
    const n = nativeNotification({ template: 'reply', thread_id: tid }, cfg, new Date('2026-01-05T18:00:00Z'))
    const b = buildPushPayload({ template: 'reply', thread_id: tid }, cfg).notification
    expect(n).toEqual({ title: b.title, body: b.body, navigate: b.navigate, ...(b.tag ? { tag: b.tag } : {}) })
  })
  it('respects master off, thread off and needs_you-only', () => {
    const now = new Date('2026-01-05T18:00:00Z')
    expect(
      nativeNotification(
        { template: 'reply' },
        { ...cfg, notifications: { ...cfg.notifications, master: false } },
        now,
      ),
    ).toBeNull()
    const off = { ...cfg, threads: cfg.threads.map((t) => ({ ...t, notify: 'off' as const })) }
    expect(nativeNotification({ template: 'reply', thread_id: tid }, off, now)).toBeNull()
    const ny = { ...cfg, threads: cfg.threads.map((t) => ({ ...t, notify: 'needs_you' as const })) }
    expect(nativeNotification({ template: 'reply', thread_id: tid }, ny, now)).toBeNull()
    expect(nativeNotification({ template: 'needs_you', thread_id: tid }, ny, now)).not.toBeNull()
    expect(nativeNotification({ template: 'reply' }, null, now)).toBeNull()
  })
})
