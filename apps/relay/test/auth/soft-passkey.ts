// A software WebAuthn authenticator (attestation 'none', ES256) so tests drive the real /api/auth/* routes.
import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { b64urlEncode } from '@talos-app/protocol'
import { ORIGIN } from './helpers.ts'

const RP_ID = new URL(ORIGIN).hostname
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
const b64uToBytes = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))

/** A software passkey. `credId` can be chosen: a real attacker controls it too. */
export function softAuthenticator(credIdBytes: Uint8Array = crypto.getRandomValues(new Uint8Array(16))) {
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
  const counter = 0
  const counterBytes = () => {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, counter)
    return b
  }
  return {
    credId,
    register(challenge: string) {
      const clientData = JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false })
      const len = new Uint8Array([credIdBytes.length >> 8, credIdBytes.length & 0xff])
      const authData = concat(
        sha(RP_ID),
        new Uint8Array([0x45]), // UP | UV | AT
        counterBytes(),
        new Uint8Array(16),
        len,
        credIdBytes,
        isoCBOR.encode(cose as never),
      )
      const att = isoCBOR.encode(
        new Map<string, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]) as never,
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
      const clientData = JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false })
      const cd = new TextEncoder().encode(clientData)
      const authData = concat(sha(RP_ID), new Uint8Array([0x05]), counterBytes())
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
