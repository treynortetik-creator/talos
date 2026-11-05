import { describe, expect, it } from 'vitest'
import { ROUTE_LIST, routes } from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const fixtures = loadFixtures()

// Every row of spec 3.8, expanded (method + path).
const SPEC_ROUTES = [
  'GET /healthz',
  'GET /ws',
  'GET /bridge',
  'POST /api/auth/enroll/options',
  'POST /api/auth/enroll/verify',
  'POST /api/auth/enroll/session', // WP-N0
  'POST /api/auth/login/options',
  'POST /api/auth/login/verify',
  'POST /api/auth/device/verify',
  'POST /api/auth/device/prove/options',
  'POST /api/auth/device/prove',
  'POST /api/auth/stepup/options',
  'POST /api/auth/stepup/verify',
  'POST /api/auth/logout',
  'POST /api/auth/logout-all',
  'GET /api/me',
  'GET /api/devices',
  'POST /api/devices/:id/revoke',
  'POST /api/dictate',
  'POST /api/push/subscribe',
  'DELETE /api/push/subscribe',
  'GET /api/push/apns',
  'GET /api/push/ref/:ref',
  'GET /api/push/thread-ref/:thread',
  'POST /api/push/apns',
  'GET /api/push/grant',
  'POST /api/push/grant',
  'POST /api/native/act',
  'POST /api/push/test',
  'POST /api/media',
  'GET /media/:id',
  'GET /media/:id/page',
  'GET /media/:id/app', // MCP Apps AP2 (spec M3.5)
  'POST /api/voice/session',
  'POST /api/voice/session/:id/close',
  'GET /api/integrations/catalog',
  'GET /api/connections',
  'POST /api/connections',
  'GET /api/connections/:id',
  'PATCH /api/connections/:id',
  'DELETE /api/connections/:id',
  'POST /api/connections/:id/rotate',
  'POST /api/connections/:id/test',
  'POST /api/connections/:id/credentials',
  'GET /api/connections/:id/deliveries',
  'GET /api/inbox',
  'POST /hook/:integration/:connection_id',
  'POST /hook/:integration/:connection_id/claim',
  'POST /bridge/post',
  'PUT /bridge/media/:id',
  'GET /bridge/media/:id',
  'GET /bridge/raw/:event_id',
  'GET /bridge/digest',
  'POST /bridge/enroll',
  'POST /bridge/rotate',
  'POST /bridge/devices/:id/revoke',
  'GET /.well-known/apple-app-site-association',
  // docs/V2-FEATURES.md V1.4
  'GET /api/status',
  'POST /api/health/test',
  'POST /api/problems',
  'GET /api/share/tokens',
  'POST /api/share/tokens',
  'DELETE /api/share/tokens/:id',
  'POST /api/share',
  'POST /bridge/share/tokens',
  'DELETE /bridge/share/tokens/:id',
  'POST /share-target',
]

describe('http route table', () => {
  it('covers every route in spec 3.8 and nothing else', () => {
    const have = ROUTE_LIST.map((r) => `${r.method} ${r.path}`).sort()
    expect(have).toEqual([...SPEC_ROUTES].sort())
  })
  it('has no route for the Mac app terminal: it is a native view and never goes through the relay', () => {
    expect(ROUTE_LIST.filter((r) => /terminal|\bpty\b|tmux/i.test(r.path))).toEqual([])
  })
  it('route ids are unique and match their keys', () => {
    for (const [k, r] of Object.entries(routes)) expect(r.id).toBe(k)
    expect(new Set(ROUTE_LIST.map((r) => r.id)).size).toBe(ROUTE_LIST.length)
  })
  it('every /bridge route uses bridge-sig; every /api route (except auth bootstrap) needs a session', () => {
    for (const r of ROUTE_LIST) {
      if (r.path.startsWith('/bridge/')) expect(r.auth, r.path).toBe('bridge-sig')
    }
    const open = new Set([
      '/api/auth/enroll/options',
      '/api/auth/enroll/verify',
      '/api/auth/enroll/session',
      '/api/auth/login/options',
      '/api/auth/login/verify',
    ])
    // The v2 share bearer has its own auth mode, for exactly one route (docs/V2-FEATURES.md V1.4)
    const bearer: Record<string, string> = { '/api/share': 'share-token', '/api/native/act': 'native-act' }
    for (const r of ROUTE_LIST) {
      if (!r.path.startsWith('/api/') || open.has(r.path)) continue
      if (bearer[r.path]) expect(r.auth, r.path).toBe(bearer[r.path])
      else expect(r.auth, r.path).toMatch(/^session/)
    }
    expect(ROUTE_LIST.filter((r) => r.auth === 'share-token').map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/share',
    ])
    expect(ROUTE_LIST.filter((r) => r.auth === 'native-act').map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/native/act',
    ])
  })
  it('state-changing session routes declare a request schema where there is a body', () => {
    expect(routes.deviceVerify.req.safeParse({ device: {}, binding: 'x', code_auth: 'y' }).success).toBe(false)
    expect(
      routes.pushSubscribe.req.safeParse({ endpoint: 'javascript:1', keys: { p256dh: 'a', auth: 'b' } }).success,
    ).toBe(false)
    expect(
      routes.pushSubscribe.req.safeParse({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } })
        .success,
    ).toBe(true)
  })
  it('enrollSession takes only { code_auth } and is a code_auth route (WP-N0)', () => {
    expect(routes.enrollSession).toMatchObject({ method: 'POST', path: '/api/auth/enroll/session', auth: 'code_auth' })
    expect(routes.enrollSession.req.safeParse({ code_auth: 'x' }).success).toBe(true)
    expect(routes.enrollSession.req.safeParse({}).success).toBe(false)
    expect(routes.enrollSession.res.safeParse({ ok: true }).success).toBe(true)
  })
  it('stepup purposes are the three documented kinds', () => {
    const p = routes.stepupOptions.req
    expect(p.safeParse({ purpose: 'config:work' }).success).toBe(true)
    expect(p.safeParse({ purpose: 'device:revoke' }).success).toBe(true)
    expect(p.safeParse({ purpose: 'card:c_01JBF3V7Q8K2M4N6P8R0S2T4V6' }).success).toBe(true)
    expect(p.safeParse({ purpose: 'everything' }).success).toBe(false)
  })
  it('POST /bridge/post accepts exactly the four durable bridge frames', () => {
    const req = routes.bridgePost.req
    for (const t of ['reply', 'card.create', 'thread.upsert', 'inbox.update'])
      expect(req.safeParse(fixtures[t]).success, t).toBe(true)
    for (const t of ['hook.event', 'message', 'ping']) expect(req.safeParse(fixtures[t]).success, t).toBe(false)
  })
  it('GET /bridge/digest returns a hook.digest frame body', () => {
    expect(routes.bridgeDigest.res.safeParse(fixtures['hook.digest']).success).toBe(true)
  })
  it('POST /bridge/enroll carries only the hash', () => {
    const ok = {
      code_id: '0123456789abcdef',
      code_auth_hash: 'a'.repeat(64),
      expires_at: '2026-10-28T15:42:10.000Z',
      label: 'phone',
    }
    expect(routes.bridgeEnroll.req.safeParse(ok).success).toBe(true)
    expect(routes.bridgeEnroll.req.safeParse({ ...ok, code_auth_hash: 'short' }).success).toBe(false)
    expect(routes.bridgeEnroll.req.safeParse({ ...ok, code_id: 'short' }).success).toBe(false)
    const { label: _label, ...noLabel } = ok
    expect(routes.bridgeEnroll.req.safeParse(noLabel).success).toBe(true) // the label is optional
  })
  it('voice session matches spec 6.2: request {thread_id, sdp}, response {voice_session_id, sdp_answer, max_minutes}', () => {
    const v = routes.voiceSession
    expect(v.req.safeParse({ thread_id: 'general', sdp: 'v=0' }).success).toBe(true)
    expect(v.req.safeParse({ thread_id: 'all', sdp: 'v=0' }).success).toBe(false)
    const res = { voice_session_id: 'v_01JBF3V7Q8K2M4N6P8R0S2T4V6', sdp_answer: 'v=0', max_minutes: 30 }
    expect(v.res.safeParse(res).success).toBe(true)
    expect(v.res.safeParse({ ...res, max_minutes: undefined }).success).toBe(false)
    expect(v.res.safeParse({ ...res, voice_session_id: 'x' }).success).toBe(false)
  })
  it('bridge share token revoke: DELETE /bridge/share/tokens/:id, bridge-sig, no body', () => {
    expect(routes.bridgeShareTokenRevoke).toMatchObject({
      method: 'DELETE',
      path: '/bridge/share/tokens/:id',
      auth: 'bridge-sig',
    })
  })
})
