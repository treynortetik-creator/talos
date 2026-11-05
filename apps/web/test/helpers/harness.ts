// Test harness for the relay-backed specs. One instance per test:
//   - serves the production build (`dist/`) on http://localhost:<port> (same origin as the API, like the real relay),
//   - fakes the auth routes (`/api/auth/*`, `/api/me`, `/api/devices`, `/api/push/*`) with the CSRF, Origin and session
//     rules of spec 5.4, and WebAuthn ceremonies that check challenge, type and origin but not attestations,
//   - tunnels `/ws`, `/api/media` and `/media/*` to the testkit FakeRelay (the same code the contract tests use),
//   - serves `/media/:id/page` with the sandbox CSP of spec 5.4, and `/media/:id/app` (MCP Apps, M3.5) from a media row
//     plus the `appCsp` the test registered for it: 404 without one, the session cookie required, the spec's headers.
// The test plays the Mac: `pinDevice()` sends the `device.pinned` frame the live bridge would produce.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Page } from '@playwright/test'
import {
  type AppCspT,
  buildAppCsp,
  createExtractableDeviceKeyForTests,
  deriveEnrollAuth,
  enrollAuthHash,
  enrollCodeId,
  loginProofCodeId,
  newEnrollCode,
  routes,
  verifyDeviceProof,
  verifyEnrollment,
} from '@talos-app/protocol'
import { FakeRelay, type FakeRelayOptions, mkFrame } from '@talos-app/testkit'

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

const b64url = (b: Buffer) => b.toString('base64url')
const rand = (n = 32) => b64url(Buffer.from(crypto.getRandomValues(new Uint8Array(n))))

type Session = { id: string; deviceId?: string; pinned: boolean }
type EnrolledDevice = { id: string; name: string; pubkey_jwk: Record<string, string>; binding: string; pinned: boolean }

export type Harness = Awaited<ReturnType<typeof startHarness>>

export async function startHarness(relayOpts: FakeRelayOptions = {}) {
  if (!existsSync(join(DIST, 'index.html')))
    throw new Error('apps/web/dist is missing: run `pnpm --filter @talos-app/web build`')
  const sessions = new Map<string, Session>()
  const challenges = new Map<string, { kind: 'create' | 'get'; purpose?: string }>()
  const credentials = new Set<string>()
  const armed = new Map<string, string>() // enrollAuthHash -> code
  const devices = new Map<string, EnrolledDevice>()
  const pushSubs: unknown[] = []
  const appCsp = new Map<string, AppCspT>()
  const authCalls: string[] = []
  const loginProofs: string[] = [] // device ids whose sign-in proof checked out
  const provenLogin = new Set<string>() // devices that proved once: a later sign-in naming them must prove again
  let sharedPasskey = false
  let failures = 0
  let wsBlocked = false
  let vapid = ''
  let relayPort = 0
  let origin = ''
  let relay!: FakeRelay
  const sockets = new Set<Socket>()

  const cookieOf = (req: IncomingMessage) => /(?:^|;\s*)talos_s=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
  const sessionOf = (req: IncomingMessage) => {
    const id = cookieOf(req)
    return id ? sessions.get(id) : undefined
  }
  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    return Buffer.concat(chunks)
  }
  const fail = (res: ServerResponse, body: unknown) => {
    failures++
    send(res, 401, body)
  }
  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    if (body === undefined) return void res.writeHead(status, headers).end()
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
  }
  const newSession = (init: Partial<Session> = {}) => {
    const s: Session = { id: rand(), pinned: false, ...init }
    sessions.set(s.id, s)
    return s
  }
  const cookieHeader = (s: Session) => ({ 'set-cookie': `talos_s=${s.id}; Path=/; HttpOnly; SameSite=Strict` })
  const rpId = () => new URL(origin).hostname

  function clientData(response: unknown): { type?: string; challenge?: string; origin?: string } | null {
    try {
      const r = response as { response?: { clientDataJSON?: string } }
      return JSON.parse(Buffer.from(r.response?.clientDataJSON ?? '', 'base64url').toString('utf8'))
    } catch {
      return null
    }
  }
  function checkCeremony(response: unknown, kind: 'create' | 'get', purpose?: string): boolean {
    const cd = clientData(response)
    if (!cd?.challenge || cd.origin !== origin) return false
    const pending = challenges.get(cd.challenge)
    challenges.delete(cd.challenge)
    return Boolean(
      pending &&
        pending.kind === kind &&
        pending.purpose === purpose &&
        cd.type === (kind === 'create' ? 'webauthn.create' : 'webauthn.get'),
    )
  }
  const codeFor = (codeAuth: unknown) =>
    typeof codeAuth === 'string' ? armed.get(enrollAuthHash(codeAuth)) : undefined

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? 'GET'
    authCalls.push(`${method} ${path}`)
    if (method !== 'GET') {
      // CSRF (5.4): Origin, header and JSON content type on every non-GET /api request.
      const ct = String(req.headers['content-type'] ?? '')
      if (
        req.headers.origin !== origin ||
        req.headers['x-talos-csrf'] !== '1' ||
        (path !== '/api/media' && !ct.startsWith('application/json'))
      )
        return send(res, 403, { error: 'csrf' })
    }
    const bodyBuf = method === 'GET' ? Buffer.alloc(0) : await readBody(req)
    let body: Record<string, unknown> = {}
    try {
      body = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {}
    } catch {
      return send(res, 400, { error: 'bad_json' })
    }
    const session = sessionOf(req)

    if (path === '/api/auth/enroll/options' && method === 'POST') {
      if (!codeFor(body.code_auth)) return fail(res, { error: 'code' })
      const challenge = rand()
      challenges.set(challenge, { kind: 'create' })
      return send(res, 200, {
        challenge,
        rp: { name: 'Talos', id: rpId() },
        user: { id: rand(16), name: 'owner', displayName: 'owner' },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        timeout: 60_000,
        attestation: 'none',
        excludeCredentials: [...credentials].map((id) => ({ id, type: 'public-key' })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      })
    }
    if (path === '/api/auth/enroll/verify' && method === 'POST') {
      const id = (body.response as { id?: string } | undefined)?.id
      if (!codeFor(body.code_auth) || !id || !checkCeremony(body.response, 'create'))
        return fail(res, { error: 'verify' })
      credentials.add(id)
      return send(res, 200, { ok: true }, cookieHeader(newSession()))
    }
    if (path === '/api/auth/enroll/session' && method === 'POST') {
      // WP-N0: a native shell trades a live code for an unpinned session; the code is not burned here.
      if (!codeFor(body.code_auth)) return fail(res, { error: 'code' })
      return send(res, 200, { ok: true }, cookieHeader(newSession()))
    }
    if (path === '/api/auth/login/options' && method === 'POST') {
      const challenge = rand()
      challenges.set(challenge, { kind: 'get' })
      return send(res, 200, {
        challenge,
        rpId: rpId(),
        userVerification: 'required',
        timeout: 60_000,
        allowCredentials: [],
      })
    }
    if (path === '/api/auth/login/verify' && method === 'POST') {
      const id = (body.response as { id?: string } | undefined)?.id
      if (!id || !credentials.has(id) || !checkCeremony(body.response, 'get'))
        return send(res, 401, { error: 'verify' })
      // Like the real relay (item 3): a device id in the body attaches the new session to that enrolled device only with a
      // valid proof, the device's signature over the login challenge. A device that proved once may not leave it out.
      const claimed = typeof body.device_id === 'string' ? devices.get(body.device_id) : undefined
      let attach = false
      if (claimed) {
        const p = body.device_proof as { nonce?: unknown; sig?: unknown } | undefined
        const nonce = clientData(body.response)?.challenge
        if (p && typeof p.sig === 'string') {
          const ok =
            p.nonce === nonce &&
            (await verifyDeviceProof(claimed.pubkey_jwk as never, {
              nonce: String(p.nonce),
              codeId: loginProofCodeId(id),
              deviceId: claimed.id,
              sig: p.sig,
            }))
          if (!ok) return send(res, 401, { error: 'device_proof_invalid' })
          provenLogin.add(claimed.id)
          loginProofs.push(claimed.id)
          attach = true
        } else if (provenLogin.has(claimed.id)) {
          return send(res, 403, { error: 'device_proof_required' })
        } else attach = true
      }
      return send(res, 200, { ok: true }, cookieHeader(newSession(attach && claimed ? { deviceId: claimed.id } : {})))
    }
    if (path === '/api/auth/stepup/options' && method === 'POST') {
      if (!session) return send(res, 401, { error: 'session' })
      const challenge = rand()
      challenges.set(challenge, { kind: 'get', purpose: String(body.purpose) })
      return send(res, 200, {
        challenge,
        rpId: rpId(),
        userVerification: 'required',
        timeout: 60_000,
        allowCredentials: [],
      })
    }
    if (path === '/api/auth/stepup/verify' && method === 'POST') {
      if (!session) return send(res, 401, { error: 'session' })
      if (!checkCeremony(body.response, 'get', String(body.purpose))) return send(res, 401, { error: 'verify' })
      return send(res, 200, { stepup_token: relay.mintStepup(String(body.purpose)) })
    }
    if (path === '/api/auth/device/verify' && method === 'POST') {
      if (!session) return send(res, 401, { error: 'session' })
      const parsed = routes.deviceVerify.req.safeParse(body)
      const code = parsed.success ? codeFor(parsed.data.code_auth) : undefined
      if (!parsed.success || !code) return fail(res, { error: 'code' })
      const { device, binding } = parsed.data
      if (!(await verifyEnrollment(code, device.id, device.pubkey_jwk, binding))) return fail(res, { error: 'binding' })
      devices.set(device.id, { ...device, binding, pinned: false })
      session.deviceId = device.id
      relay.sendToBridge({
        type: 'device.enrolled',
        device,
        binding,
        code_id: enrollCodeId(enrollAuthHash(parsed.data.code_auth)),
        credential_id: [...credentials][0] ?? 'cred',
      })
      return send(res, 202, { accepted: true })
    }
    if (path === '/api/auth/logout' && method === 'POST') return send(res, 204)
    if (path === '/api/auth/logout-all' && method === 'POST') {
      sessions.clear()
      return send(res, 204)
    }
    if (path === '/api/me' && method === 'GET') {
      if (!session) return send(res, 401, { error: 'session' })
      const dev = session.deviceId ? devices.get(session.deviceId) : undefined
      return send(res, 200, {
        ...(session.deviceId ? { device_id: session.deviceId } : {}),
        device_pinned: session.pinned || Boolean(dev?.pinned),
        has_passkey: credentials.size > 0,
        rp_id: rpId(),
        version: 'test',
        bridge_online: relay.bridgeConnected,
        vapid_public_key: vapid,
      })
    }
    if (path === '/api/devices' && method === 'GET') {
      if (!session) return send(res, 401, { error: 'session' })
      return send(
        res,
        200,
        [...devices.values()].map((d) => ({
          id: d.id,
          name: d.name,
          pubkey_jwk: d.pubkey_jwk,
          pinned: d.pinned,
          revoked: false,
          created_at: new Date().toISOString(),
          last_used_at: null,
          ...(sharedPasskey ? { shared_passkey: true } : {}),
        })),
      )
    }
    if (path === '/api/push/subscribe') {
      if (!session) return send(res, 401, { error: 'session' })
      if (method === 'POST') pushSubs.push(body)
      return send(res, 204)
    }
    if (path === '/api/push/test') return send(res, session ? 204 : 401)
    return send(res, 404, { error: 'not found' })
  }

  function serveStatic(res: ServerResponse, path: string) {
    let file = normalize(join(DIST, path === '/' ? 'index.html' : path))
    if (!file.startsWith(DIST)) return send(res, 403)
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(path)) return send(res, 404)
      file = join(DIST, 'index.html') // SPA fallback
    }
    const headers: Record<string, string> = {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    }
    if (file.endsWith('sw.js')) headers['service-worker-allowed'] = '/'
    res.writeHead(200, headers).end(readFileSync(file))
  }

  function proxyHttp(req: IncomingMessage, res: ServerResponse) {
    const sock = connect(relayPort, '127.0.0.1')
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    const head = `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries({
      ...req.headers,
      connection: 'close',
      host: `127.0.0.1:${relayPort}`,
    })
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n')}\r\n\r\n`
    sock.write(head)
    req.pipe(sock)
    sock.pipe(res.socket as Socket)
  }

  const server: Server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0] as string
      if (path.startsWith('/api/media') || /^\/media\/md_[0-9A-HJKMNP-TV-Z]{26}$/.test(path)) {
        if (!sessionOf(req)) return send(res, 401, { error: 'session' })
        if (
          req.method !== 'GET' &&
          req.method !== 'HEAD' &&
          (req.headers.origin !== origin || req.headers['x-talos-csrf'] !== '1')
        )
          return send(res, 403, { error: 'csrf' })
        return proxyHttp(req, res)
      }
      const page = /^\/media\/(md_[0-9A-HJKMNP-TV-Z]{26})\/page$/.exec(path)
      if (page) {
        const m = relay.media.get(page[1] as string)
        if (!m) return send(res, 404)
        res
          .writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy':
              "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:",
            'x-content-type-options': 'nosniff',
          })
          .end(m.bytes)
        return
      }
      const appPage = /^\/media\/(md_[0-9A-HJKMNP-TV-Z]{26})\/app$/.exec(path)
      if (appPage) {
        if (!sessionOf(req)) return send(res, 401, { error: 'session' })
        const id = appPage[1] as string
        const m = relay.media.get(id)
        const csp = appCsp.get(id)
        if (!m || !csp || m.mime !== 'text/html') return send(res, 404)
        res
          .writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': `sandbox allow-scripts; ${buildAppCsp(csp)}`,
            'permissions-policy':
              'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=(), fullscreen=()',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
            'cross-origin-resource-policy': 'same-origin',
            'cache-control': 'private, no-store',
          })
          .end(m.bytes)
        return
      }
      if (path.startsWith('/api/')) return await handleApi(req, res, path)
      if (path === '/healthz') return send(res, 200, { ok: true, version: 'test' })
      serveStatic(res, path)
    } catch (e) {
      send(res, 500, { error: String(e) })
    }
  })

  // WebSocket upgrade: session cookie required (401 before upgrade), then a raw TCP tunnel to the FakeRelay.
  server.on('upgrade', (req, socket, head) => {
    if (wsBlocked) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return void socket.destroy()
    }
    if ((req.url ?? '').split('?')[0] !== '/ws' || !sessionOf(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return void socket.destroy()
    }
    const up = connect(relayPort, '127.0.0.1')
    sockets.add(up)
    sockets.add(socket as Socket)
    up.on('close', () => {
      sockets.delete(up)
      socket.destroy()
    })
    socket.on('close', () => {
      sockets.delete(socket as Socket)
      up.destroy()
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
    up.write(
      `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries({ ...req.headers, host: `127.0.0.1:${relayPort}` })
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n')}\r\n\r\n`,
    )
    if (head.length) up.write(head)
    socket.pipe(up)
    up.pipe(socket)
  })

  {
    // A well-formed VAPID public key (uncompressed P-256 point). The browser never reaches a push service in tests.
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    vapid = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')
  }
  await new Promise<void>((r) => server.listen(0, () => r()))
  const port = (server.address() as { port: number }).port
  origin = `http://localhost:${port}`
  relay = new FakeRelay({ ...relayOpts, host: 'localhost', origin })
  await relay.start()
  relayPort = Number(new URL(relay.httpUrl).port)

  const h = {
    url: origin,
    relay,
    authCalls,
    loginProofs,
    /** Make /api/devices report every device as sharing a passkey with another (the relay's `shared_passkey`). */
    setSharedPasskey(on: boolean) {
      sharedPasskey = on
    },
    pushSubs,
    devices,
    sessions,
    get failedAuthCalls() {
      return failures
    },
    /** What `talos-app enroll` does on the Mac: makes a code and registers its hash. Returns the code and the link. */
    armEnroll() {
      const code = newEnrollCode()
      armed.set(enrollAuthHash(deriveEnrollAuth(code)), code)
      return { code, link: `${origin}/enroll#${code}` }
    },
    /** What the Mac's y/N does: pin (or refuse) a device and tell the apps. */
    pinDevice(deviceId: string, ok = true, reason?: string) {
      const d = devices.get(deviceId)
      if (d) d.pinned = ok
      for (const s of sessions.values()) if (s.deviceId === deviceId) s.pinned = ok
      relay.sendToApps(mkFrame('device.pinned', { device_id: deviceId, ok, ...(reason ? { reason } : {}) }))
    },
    /** A signed-in session with a seeded device key (skips enrollment; used on WebKit where passkeys cannot be automated). */
    async seedDevice(context: BrowserContext, page: Page, opts: { pinned?: boolean } = {}) {
      const key = await createExtractableDeviceKeyForTests()
      const session = newSession({ deviceId: key.deviceId, pinned: opts.pinned ?? true })
      await context.addCookies([{ name: 'talos_s', value: session.id, url: origin }])
      await page.goto(`${origin}/manifest.webmanifest`)
      await page.evaluate(
        async ({ privateJwk, publicJwk, deviceId }) => {
          const alg = { name: 'ECDSA', namedCurve: 'P-256' }
          const privateKey = await crypto.subtle.importKey('jwk', privateJwk, alg, false, ['sign'])
          const publicKey = await crypto.subtle.importKey('jwk', { ...publicJwk, ext: true }, alg, true, ['verify'])
          const db: IDBDatabase = await new Promise((resolve, reject) => {
            const open = indexedDB.open('talos-app', 1)
            open.onupgradeneeded = () => {
              for (const n of ['keys', 'outbox', 'blobs', 'cache', 'drafts']) open.result.createObjectStore(n)
            }
            open.onsuccess = () => resolve(open.result)
            open.onerror = () => reject(open.error)
          })
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('keys', 'readwrite')
            tx.objectStore('keys').put({ privateKey, publicKey, publicJwk, deviceId }, 'device')
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
          })
          db.close()
        },
        { privateJwk: key.privateJwk, publicJwk: key.publicJwk, deviceId: key.deviceId },
      )
      return { deviceId: key.deviceId, publicJwk: key.publicJwk, session }
    },
    /** Refuse (or allow again) new `/ws` upgrades, to simulate an unreachable server. */
    blockWs(blocked: boolean) {
      wsBlocked = blocked
    },
    /** Forget every session, as an expired cookie would: `/api/me` and `/ws` answer 401 from now on. */
    expireSessions() {
      sessions.clear()
    },
    /** Cut every open app socket without a close handshake. */
    dropAppSockets() {
      for (const s of [...sockets]) s.destroy()
    },
    /** CSP the harness serves `/media/:id/app` with, by media id (MCP Apps). */
    appCsp,
    /** Frames the relay received from apps, as the raw JSON text on the wire. */
    appFrames() {
      return relay.frames.filter((f) => f.direction === 'from_app')
    },
    async stop() {
      for (const s of sockets) s.destroy()
      await relay.stop()
      await new Promise<void>((r) => {
        server.close(() => r())
        server.closeAllConnections?.()
      })
    },
  }
  return h
}
