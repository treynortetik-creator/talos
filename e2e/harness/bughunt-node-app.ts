// Bughunt harness: a browserless "phone" against the REAL stack (built relay + real bridge behind FakeClaude).
// A software passkey (attestation 'none', ES256) registers through the real /api/auth/* routes, a FakeApp device key
// binds through /api/auth/device/verify, and the real `talos-app enroll` CLI answers the y/N prompt. The result is a
// session cookie plus a FakeApp whose frames go through the real /ws seam.
import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import {
  b64urlEncode,
  bindingMac,
  createDeviceKey,
  type DeviceKey,
  deriveEnrollAuth,
  deriveEnrollBind,
} from '@talos-app/protocol'
import { FakeApp } from '@talos-app/testkit'
import type { Stack } from './stack.ts'

const sha = (b: Uint8Array | string) => new Uint8Array(createHash('sha256').update(b).digest())
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}
/** Minimal CBOR (RFC 8949) for the attestation object: maps, byte strings, text, small ints. */
function cbor(v: unknown): Uint8Array {
  const head = (major: number, n: number): Uint8Array => {
    if (n < 24) return new Uint8Array([(major << 5) | n])
    if (n < 256) return new Uint8Array([(major << 5) | 24, n])
    if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff])
    return new Uint8Array([(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
  }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (typeof v === 'string') {
    const b = new TextEncoder().encode(v)
    return concat(head(3, b.length), b)
  }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v)
  if (v instanceof Map) {
    const parts: Uint8Array[] = [head(5, v.size)]
    for (const [k, x] of v) parts.push(cbor(k), cbor(x))
    return concat(...parts)
  }
  throw new Error('cbor: unsupported value')
}
const b64uToBytes = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))

export type SoftPasskey = ReturnType<typeof softAuthenticator>

export function softAuthenticator(origin: string) {
  const rpId = new URL(origin).hostname
  const credIdBytes = crypto.getRandomValues(new Uint8Array(16))
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const cose = new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, b64uToBytes(jwk.x)],
    [-3, b64uToBytes(jwk.y)],
  ])
  const credId = b64urlEncode(credIdBytes)
  let counter = 0
  const counterBytes = () => {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, counter)
    return b
  }
  return {
    credId,
    register(challenge: string) {
      const clientData = JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false })
      const len = new Uint8Array([credIdBytes.length >> 8, credIdBytes.length & 0xff])
      const authData = concat(
        sha(rpId),
        new Uint8Array([0x45]),
        counterBytes(),
        new Uint8Array(16),
        len,
        credIdBytes,
        cbor(cose),
      )
      const att = cbor(
        new Map<string, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      )
      return {
        id: credId,
        rawId: credId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64urlEncode(new TextEncoder().encode(clientData)),
          attestationObject: b64urlEncode(att),
          transports: ['internal'],
        },
      }
    },
    assert(challenge: string, key: KeyObject = privateKey) {
      counter++
      const clientData = JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false })
      const cd = new TextEncoder().encode(clientData)
      const authData = concat(sha(rpId), new Uint8Array([0x05]), counterBytes())
      const sig = sign('sha256', concat(authData, sha(cd)), { key, dsaEncoding: 'der' })
      return {
        id: credId,
        rawId: credId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64urlEncode(cd),
          authenticatorData: b64urlEncode(authData),
          signature: b64urlEncode(new Uint8Array(sig)),
        },
      }
    },
  }
}

export const cookieFrom = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] as string

/** A JSON POST the way the PWA sends it (Origin, CSRF header, JSON type). */
export async function apiPost(stack: Stack, path: string, body: unknown, cookie = ''): Promise<Response> {
  return fetch(`${stack.origin}${path}`, {
    method: 'POST',
    headers: {
      origin: stack.origin,
      'x-talos-csrf': '1',
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })
}

export async function apiGet(stack: Stack, path: string, cookie = ''): Promise<Response> {
  return fetch(`${stack.origin}${path}`, { headers: cookie ? { cookie } : {} })
}

export async function loginWith(stack: Stack, passkey: SoftPasskey, extra: Record<string, unknown> = {}) {
  const opts = await apiPost(stack, '/api/auth/login/options', {})
  const { challenge } = (await opts.json()) as { challenge: string }
  const res = await apiPost(stack, '/api/auth/login/verify', { response: passkey.assert(challenge), ...extra })
  return { res, cookie: cookieFrom(res) }
}

export async function stepup(stack: Stack, passkey: SoftPasskey, cookie: string, purpose: string): Promise<string> {
  const o = await apiPost(stack, '/api/auth/stepup/options', { purpose }, cookie)
  if (o.status !== 200) throw new Error(`stepup/options ${o.status} ${await o.text()}`)
  const { challenge } = (await o.json()) as { challenge: string }
  const v = await apiPost(stack, '/api/auth/stepup/verify', { purpose, response: passkey.assert(challenge) }, cookie)
  if (v.status !== 200) throw new Error(`stepup/verify ${v.status} ${await v.text()}`)
  return ((await v.json()) as { stepup_token: string }).stepup_token
}

export type NodePhone = {
  passkey: SoftPasskey
  cookie: string
  device: DeviceKey
  app: FakeApp
  cli: ReturnType<Stack['cli']>
  code: string
}

/**
 * The whole enrollment through the real seams: `talos-app enroll` prints the link; the code in its fragment opens
 * passkey registration (or sign-in with `passkey` when one exists); the device key binds; the CLI's y/N is answered.
 * The bridge must be running (the prompt comes from the live bridge).
 */
export async function enrollNodePhone(
  stack: Stack,
  opts: { answer?: 'y' | 'N'; passkey?: SoftPasskey; label?: string; waitPinned?: boolean } = {},
): Promise<NodePhone> {
  const cli = stack.cli(['enroll', '--label', opts.label ?? 'phone'])
  const [link] = await cli.waitFor(/https?:\/\/\S+\/enroll#\S+/)
  const code = (link as string).split('#')[1] as string
  const codeAuth = deriveEnrollAuth(code)
  const passkey = opts.passkey ?? softAuthenticator(stack.origin)
  let cookie: string
  if (opts.passkey) {
    const r = await loginWith(stack, passkey)
    if (r.res.status !== 200) throw new Error(`login ${r.res.status}`)
    cookie = r.cookie
  } else {
    const o = await apiPost(stack, '/api/auth/enroll/options', { code_auth: codeAuth })
    if (o.status !== 200) throw new Error(`enroll/options ${o.status} ${await o.text()}`)
    const { challenge } = (await o.json()) as { challenge: string }
    const v = await apiPost(stack, '/api/auth/enroll/verify', {
      code_auth: codeAuth,
      response: passkey.register(challenge),
    })
    if (v.status !== 200) throw new Error(`enroll/verify ${v.status} ${await v.text()}`)
    cookie = cookieFrom(v)
  }
  const device = await createDeviceKey()
  const binding = bindingMac(deriveEnrollBind(code), device.deviceId, device.publicJwk)
  const dv = await apiPost(
    stack,
    '/api/auth/device/verify',
    {
      device: { id: device.deviceId, name: opts.label ?? 'phone', pubkey_jwk: device.publicJwk },
      binding,
      code_auth: codeAuth,
    },
    cookie,
  )
  if (dv.status !== 202) throw new Error(`device/verify ${dv.status} ${await dv.text()}`)
  await cli.waitFor(/\[y\/N\]/)
  cli.write(`${opts.answer ?? 'y'}\n`)
  if ((opts.answer ?? 'y') === 'y' && opts.waitPinned !== false) {
    const deadline = Date.now() + 15_000
    for (;;) {
      const me = (await (await apiGet(stack, '/api/me', cookie)).json()) as { device_pinned?: boolean }
      if (me.device_pinned) break
      if (Date.now() > deadline) throw new Error('device never pinned')
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  const app = new FakeApp({
    relayWs: stack.origin.replace(/^http/, 'ws'),
    deviceKey: device,
    headers: { cookie, origin: stack.origin },
  })
  return { passkey, cookie, device, app, cli, code }
}
