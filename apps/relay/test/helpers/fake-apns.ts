// A local HTTP/2 stand-in for api.push.apple.com (WP-I5). Real `node:http2`, and it checks the provider token the way
// Apple does: ES256, `kid` and `iss` present, signature valid for the key pair the test generated. It records every
// request and answers per device token, so a test can ask for a 410 or a 429 for one phone and a 200 for another.
import { createPublicKey, generateKeyPairSync, type KeyObject, verify } from 'node:crypto'
import { createServer, type Http2Server, type ServerHttp2Session } from 'node:http2'
import type { AddressInfo } from 'node:net'

export type ApnsRequest = {
  token: string
  topic: string | undefined
  pushType: string | undefined
  priority: string | undefined
  collapseId: string | undefined
  expiration: string | undefined
  bearer: string
  jwt: { ok: boolean; kid?: string; iss?: string; iat?: number }
  body: Record<string, unknown>
  rawBody: string
}
export type Reply = { status: number; reason?: string; delayMs?: number } | 'hang'

export function testKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    privateKey,
    publicKey,
    p8: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

function checkJwt(bearer: string, pub: KeyObject): ApnsRequest['jwt'] {
  const m = /^bearer (.+)$/.exec(bearer)
  const parts = m?.[1]?.split('.') ?? []
  if (parts.length !== 3) return { ok: false }
  try {
    const [h, p, s] = parts as [string, string, string]
    const head = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg?: string; kid?: string }
    const pay = JSON.parse(Buffer.from(p, 'base64url').toString()) as { iss?: string; iat?: number }
    const ok =
      head.alg === 'ES256' &&
      verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))
    return { ok, ...(head.kid ? { kid: head.kid } : {}), ...(pay.iss ? { iss: pay.iss } : {}), iat: pay.iat as number }
  } catch {
    return { ok: false }
  }
}

export async function startFakeApns(publicKey: KeyObject | string) {
  const pub = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey
  const requests: ApnsRequest[] = []
  const replies = new Map<string, Reply[] | Reply>()
  const sessions = new Set<ServerHttp2Session>()
  let connections = 0
  let defaultReply: Reply = { status: 200 }
  let seen: ((r: ApnsRequest) => void) | null = null
  const server: Http2Server = createServer()
  server.on('session', (s) => {
    connections++
    sessions.add(s)
    s.on('close', () => sessions.delete(s))
    s.on('error', () => {})
  })
  server.on('stream', (stream, headers) => {
    let raw = ''
    stream.setEncoding('utf8')
    stream.on('data', (c: string) => {
      raw += c
    })
    stream.on('error', () => {})
    stream.on('end', () => {
      const path = String(headers[':path'] ?? '')
      const token = path.startsWith('/3/device/') ? path.slice('/3/device/'.length) : ''
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        /* recorded as {} */
      }
      const bearer = String(headers.authorization ?? '')
      requests.push({
        token,
        topic: headers['apns-topic'] as string | undefined,
        pushType: headers['apns-push-type'] as string | undefined,
        priority: headers['apns-priority'] as string | undefined,
        collapseId: headers['apns-collapse-id'] as string | undefined,
        expiration: headers['apns-expiration'] as string | undefined,
        bearer,
        jwt: checkJwt(bearer, pub),
        body,
        rawBody: raw,
      })
      seen?.(requests[requests.length - 1] as ApnsRequest)
      const q = replies.get(token)
      let r: Reply = defaultReply
      if (Array.isArray(q)) r = q.length > 1 ? (q.shift() as Reply) : (q[0] ?? defaultReply)
      else if (q) r = q
      if (r === 'hang') return
      const jwtBad = !requests[requests.length - 1]?.jwt.ok
      const out = jwtBad ? { status: 403, reason: 'InvalidProviderToken' } : r
      const answer = () => {
        if (stream.destroyed) return
        stream.respond({ ':status': out.status, 'content-type': 'application/json' })
        stream.end(out.reason ? JSON.stringify({ reason: out.reason }) : '')
      }
      if (typeof r.delayMs === 'number') setTimeout(answer, r.delayMs)
      else answer()
    })
  })
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get connections() {
      return connections
    },
    /** What `token` gets back: one reply, or a list (the last one repeats). */
    reply(token: string, r: Reply | Reply[]) {
      replies.set(token, r)
    },
    /** Called for every request the moment it has been recorded, before the reply goes out (a test can act between the two). */
    onRequest(fn: ((r: ApnsRequest) => void) | null) {
      seen = fn
    },
    replyAll(r: Reply) {
      defaultReply = r
    },
    /** A graceful GOAWAY on every open session: requests already running finish, new ones need a new connection. */
    goaway() {
      for (const s of sessions) s.goaway(0, 2 ** 31 - 1)
    },
    /** Hangs up every open HTTP/2 session (Apple closing an idle connection). */
    dropSessions() {
      for (const s of sessions) s.destroy()
    },
    async close() {
      for (const s of sessions) s.destroy()
      await new Promise<void>((res) => server.close(() => res()))
    },
  }
}
export type FakeApns = Awaited<ReturnType<typeof startFakeApns>>
