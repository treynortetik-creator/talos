// Security surface of the BUILT relay, over real HTTP and real sockets (spec 10.4). Unit tests cover each rule in
// isolation; these check that the assembled product enforces them.
import { mkdirSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { ROUTE_LIST } from '@talos-app/protocol'
import { expect, openThread, sendHook, signedIn, test } from '../harness/fixtures.ts'
import type { Stack } from '../harness/stack.ts'

const JSON_HEADERS = (stack: Stack) => ({
  origin: stack.origin,
  'x-talos-csrf': '1',
  'content-type': 'application/json',
})

const fill = (path: string) =>
  path
    .replace(':integration', 'generic')
    .replace(':connection_id', 'cn_01HZZZZZZZZZZZZZZZZZZZZZZZ')
    .replace(':event_id', 'ev_01HZZZZZZZZZZZZZZZZZZZZZZZ')
    .replace(':id', 'x0')

/** Sends a hand-written HTTP upgrade request and returns the status line. */
function upgradeStatus(stack: Stack, path: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(stack.port, '127.0.0.1')
    let data = ''
    sock.on('data', (d) => {
      data += d.toString()
      if (data.includes('\r\n')) {
        sock.destroy()
        resolve(data.split('\r\n')[0] as string)
      }
    })
    sock.on('error', reject)
    sock.on('close', () => resolve(data.split('\r\n')[0] ?? ''))
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: localhost:${stack.port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      '',
      '',
    ]
    sock.write(lines.join('\r\n'))
  })
}

test('default-deny: every route in the table refuses an anonymous caller, and nothing else is served under /api', async ({
  stack,
}) => {
  const headers = JSON_HEADERS(stack)
  let checked = 0
  for (const r of ROUTE_LIST) {
    if (r.path === '/ws' || r.path === '/bridge') continue // upgrades: below
    if (r.auth === 'none' || r.auth === 'code_auth') continue // public by design (healthz, login, enroll)
    const res = await fetch(`${stack.origin}${fill(r.path)}`, {
      method: r.method,
      headers,
      ...(r.method === 'GET' ? {} : { body: '{}' }),
    })
    // Session routes: exactly 401 (a 404 would mean the guard sits behind a lookup). Signed routes: 401. Hook receivers:
    // the connection is unknown, so 404/401, never 200.
    if (r.auth === 'session') expect(res.status, `${r.method} ${r.path}`).toBe(401)
    else expect([401, 404], `${r.method} ${r.path} -> ${res.status}`).toContain(res.status)
    expect(res.status, `${r.method} ${r.path}`).not.toBe(200)
    checked++
  }
  expect(checked).toBeGreaterThan(30)
  for (const path of ['/api/nope', '/api/auth/nope', '/bridge/nope', '/api/connections/x0/nope']) {
    const res = await fetch(`${stack.origin}${path}`, { headers })
    expect([401, 404], path).toContain(res.status)
    expect(res.headers.get('content-type') ?? '', path).not.toContain('text/html')
  }
  const aasa = await fetch(`${stack.origin}/.well-known/apple-app-site-association`)
  expect(aasa.status).toBe(404)
})

test('the test-auth header does nothing in the built relay', async ({ stack }) => {
  const attempts: Array<Record<string, string>> = [
    { 'x-test-session': 'none' },
    { 'X-Test-Session': 'd_aaaaaaaaaaaaaaaaaaaa' },
    { 'x-test-bridge': '1' },
  ]
  for (const h of attempts) {
    const res = await fetch(`${stack.origin}/api/me`, { headers: h })
    expect(res.status).toBe(401)
    const ws = await upgradeStatus(stack, '/ws', { ...h, Origin: stack.origin })
    expect(ws).toContain('401')
  }
})

test('/ws and /bridge upgrades: no cookie, bad Origin and a forged cookie never upgrade', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  expect(await upgradeStatus(stack, '/ws', { Origin: stack.origin })).toContain('401')
  expect(await upgradeStatus(stack, '/ws', { Origin: 'https://evil.example.net' })).toMatch(/40[13]/)
  expect(await upgradeStatus(stack, '/ws', { Origin: stack.origin, Cookie: '__Host-talos_s=forged' })).toContain('401')
  const real = (await context.cookies()).find((c) => c.name === '__Host-talos_s')
  expect(real).toBeTruthy()
  // The real cookie from the wrong Origin is refused as well.
  expect(
    await upgradeStatus(stack, '/ws', { Origin: 'https://evil.example.net', Cookie: `__Host-talos_s=${real?.value}` }),
  ).toContain('403')
  expect(
    await upgradeStatus(stack, '/ws', { Origin: stack.origin, Cookie: `__Host-talos_s=${real?.value}` }),
  ).toContain('101')
})

test('CSRF: a missing header, a foreign Origin and a form body are all refused, even with a valid session', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
  const body = JSON.stringify({ integration: 'generic', name: 'x' })
  const base = { cookie, origin: stack.origin, 'x-talos-csrf': '1', 'content-type': 'application/json' }
  const post = (headers: Record<string, string>, b: string = body) =>
    fetch(`${stack.origin}/api/connections`, { method: 'POST', headers, body: b })
  expect((await post({ ...base, 'x-talos-csrf': '' })).status).toBe(403)
  expect((await post({ ...base, origin: 'https://evil.example.net' })).status).toBe(403)
  expect(
    (await post({ ...base, 'content-type': 'application/x-www-form-urlencoded' }, 'integration=generic&name=x')).status,
  ).toBe(403)
  expect((await post(base)).status).toBe(201) // the control: the same request, done properly
})

test('rate limits: /bridge/* and the auth routes answer 429 when hammered', async ({ stack }) => {
  let last = 0
  for (let i = 0; i < 640 && last !== 429; i++) {
    last = (await fetch(`${stack.origin}/bridge/post`, { method: 'POST', body: '{}' })).status
  }
  expect(last).toBe(429)
  let auth = 0
  for (let i = 0; i < 15 && auth !== 429; i++) {
    auth = (
      await fetch(`${stack.origin}/api/auth/login/options`, {
        method: 'POST',
        headers: JSON_HEADERS(stack),
        body: '{}',
      })
    ).status
  }
  expect(auth).toBe(429)
})

test('a work integration is off until the owner switches it on: creating one is refused and nothing is stored', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const res = await page.request.post(`${stack.origin}/api/connections`, {
    headers: JSON_HEADERS(stack),
    data: { integration: 'slack', name: 'Work chat' },
  })
  expect(res.status()).toBe(403)
  const n = stack.relay.services.db.prepare('select count(*) as n from hooks_connections').get() as { n: number }
  expect(n.n).toBe(0)
})

test('/api/me carries the push key, so alerts can be switched on', async ({ stack, page, context }) => {
  await signedIn(stack, page, context)
  const me = (await (await page.request.get(`${stack.origin}/api/me`)).json()) as Record<string, unknown>
  expect(me).toMatchObject({
    device_pinned: true,
    has_passkey: true,
    rp_id: 'localhost',
    vapid_public_key: stack.vapidPublicKey,
  })
  // A subscription is accepted, and the owner's "test notification" button reaches the transport without error.
  const sub = await page.request.post(`${stack.origin}/api/push/subscribe`, {
    headers: JSON_HEADERS(stack),
    data: {
      endpoint: 'https://push.example.com/sub/1',
      keys: {
        p256dh:
          'BPaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        auth: 'authsecretaaaaaaaaaaaa',
      },
    },
  })
  expect(sub.status()).toBe(204)
})

test('the composer hides the live-call button once there is text, and shows it again when the text is cleared', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const call = page.getByRole('button', { name: 'Start a live call' })
  await expect(call).toBeVisible()
  await page.getByLabel('Message', { exact: true }).fill('typing')
  await expect(call).toHaveCount(0)
  await page.getByLabel('Message', { exact: true }).fill('')
  await expect(call).toBeVisible()
})

test('agent-made pages and SVGs are sandboxed: no cookies, no /api, never inline', async ({ stack, page, context }) => {
  await signedIn(stack, page, context)
  const dir = join(stack.root, 'files')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'page.html'),
    `<!doctype html><title>start</title><script>
      // In an opaque origin even reading document.cookie throws, which is the point.
      let out = '';
      try { out = 'cookie=[' + document.cookie + ']' } catch (e) { out = 'cookie=[]' }
      try { indexedDB.open('talos-app'); out += ' idb=allowed' } catch (e) { out += ' idb=blocked' }
      document.title = out;
      fetch('/api/me').then((r) => { document.title = out + ' me=' + r.status }).catch(() => { document.title = out + ' me=blocked' });
    </script>`,
  )
  writeFileSync(
    join(dir, 'pic.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="5"/></svg>',
  )
  for (const f of ['page.html', 'pic.svg']) {
    const res = await stack.claude.callTool('attach', { thread_id: 'general', path: join(dir, f) })
    expect(res.isError, f).toBeFalsy()
  }
  await expect
    .poll(() => (stack.relay.services.db.prepare('select count(*) as n from core_media').get() as { n: number }).n)
    .toBe(2)
  const rows = stack.relay.services.db.prepare('select media_id as id, mime from core_media').all() as Array<{
    id: string
    mime: string
  }>
  const html = rows.find((r) => r.mime === 'text/html')
  const svg = rows.find((r) => r.mime.includes('svg'))
  expect(html && svg).toBeTruthy()

  // The page runs script, in an opaque origin.
  await page.goto(`${stack.origin}/media/${html?.id}/page`)
  await expect(page).toHaveTitle(/cookie=\[\] idb=blocked me=blocked/, { timeout: 10_000 })

  // The SVG is only ever a download: attachment, nosniff, sandbox CSP.
  const res = await page.request.get(`${stack.origin}/media/${svg?.id}`)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-disposition']).toMatch(/^attachment/)
  expect(res.headers()['content-security-policy']).toContain('sandbox')
  expect(res.headers()['x-content-type-options']).toBe('nosniff')
  // Errors carry the sandbox too (nothing here can be turned into a page).
  const missing = await fetch(`${stack.origin}/media/md_01HZZZZZZZZZZZZZZZZZZZZZZZ`)
  expect(missing.status).toBe(401)
  expect(missing.headers.get('content-security-policy')).toContain('sandbox')
})

test('logs hold no message text, tokens, codes or cookies after a full session', async ({ stack, page, context }) => {
  const MARK = 'zq-private-marker-8841'
  await signedIn(stack, page, context)
  const enrolled = stack.cli(['status']) // reads the home folder; also exercises a second process
  await enrolled.done()
  await openThread(page, 'General')
  await page.getByLabel('Message', { exact: true }).fill(`${MARK} message`)
  await page.getByTestId('composer').getByRole('button', { name: 'Send', exact: true }).click()
  await stack.claude.waitForNotification((n) => n.content.includes(MARK))
  const conn = await (
    await page.request.post(`${stack.origin}/api/connections`, {
      headers: JSON_HEADERS(stack),
      data: { integration: 'generic', name: 'Bot' },
    })
  ).json()
  await sendHook(stack, conn, { title: `${MARK} hook`, summary: `${MARK} body`, priority: 'normal' })
  await stack.claude.waitForNotification((n) => n.meta.kind === 'hook_event')
  await stack.claude.callTool('reply', { thread_id: 'general', text: `${MARK} reply`, voice: true })
  await page.waitForTimeout(800)

  const cookie = (await context.cookies()).find((c) => c.name === '__Host-talos_s')?.value ?? ''
  const code = /enroll#(\S+)/.exec(stack.cli(['status']).out)?.[1]
  const relay = stack.relayLog.join('\n')
  const bridge = stack.bridgeLog()
  for (const [name, log] of [
    ['relay log', relay],
    ['bridge log', bridge],
  ] as const) {
    expect(log.length, name).toBeGreaterThan(100)
    expect(log, name).not.toContain(MARK)
    expect(log, name).not.toContain(cookie)
    expect(log, name).not.toContain(conn.secret)
    if (code) expect(log, name).not.toContain(code)
    expect(log, name).not.toMatch(/stepup_token|"osig"|code_auth|talos-rotate|BEGIN PRIVATE/)
  }
})
