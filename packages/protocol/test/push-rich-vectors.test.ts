// The fixed bytes the phone's Swift code is checked against (apps/mobile/ios/TalosPushCore RichPushTests reads the same
// file). If the seal format, the signing input or the shown-text hash changes here, this goes red and the file must be
// regenerated (`node scripts/gen-push-rich-vectors.ts`), which in turn makes the Swift tests fail until the phone matches.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  actSigningInput,
  b64urlDecode,
  checkNativeAct,
  importRawP256,
  NativeActWire,
  openPush,
  shownHash,
} from '../src/index.ts'

const V = JSON.parse(readFileSync(new URL('../fixtures/push-rich/vectors.json', import.meta.url), 'utf8'))

async function encPrivate(): Promise<CryptoKey> {
  // JWK needs x and y too; derive them from the published raw point
  const pub = b64urlDecode(V.enc_pub)
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: V.enc_priv_d,
    x: Buffer.from(pub.slice(1, 33)).toString('base64url'),
    y: Buffer.from(pub.slice(33)).toString('base64url'),
  }
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
}

describe('captured seals and actions', () => {
  it('opens the captured reply seal and the captured card seal with the phone key', async () => {
    const key = await encPrivate()
    const r = await openPush({ envelope: V.reply.envelope, encPrivate: key, deviceId: V.device_id, kind: 'reply' })
    expect(r).toMatchObject(V.reply.shows)
    const c = await openPush({
      envelope: V.approve.envelope,
      encPrivate: key,
      deviceId: V.device_id,
      kind: 'card',
      cardId: V.approve.card_id,
    })
    expect(c?.b).toBe(V.approve.notice)
    expect(c?.c).toBe(V.approve.card_id)
    expect(c?.s).toBe(V.approve.subtitle)
    expect(shownHash(V.approve.notice, V.approve.subtitle)).toBe(V.approve.shown)
    expect(shownHash(V.approve.notice)).not.toBe(V.approve.shown) // the subtitle is part of what was shown
  })

  it('the captured action passes the whole chain, and its signing input is the documented string', async () => {
    const wire = NativeActWire.parse(V.act.wire)
    const grant = JSON.parse(wire.grant)
    expect(
      actSigningInput({ device_id: wire.device_id, id: wire.id, ts: wire.ts, grant_osig: grant.osig, body: wire.body }),
    ).toBe(`talos-act/v1\n${wire.device_id}\n${wire.id}\n${wire.ts}\n${grant.osig}\n${wire.body}`)
    expect(await importRawP256(V.act_pub, 'verify')).toBeTruthy()
    // The whole chain on the captured action itself: device key -> grant -> action key -> body.
    const checked = await checkNativeAct(V.act.wire, V.device_public_jwk, V.now_ms)
    expect(checked.ok).toBe(true)
    // A corrupted action signature in the capture is refused, so the vector cannot rot unnoticed.
    const bad = {
      ...V.act.wire,
      asig: `${V.act.wire.asig.slice(0, -2)}${V.act.wire.asig.endsWith('AA') ? 'BB' : 'AA'}`,
    }
    expect((await checkNativeAct(bad, V.device_public_jwk, V.now_ms)).ok).toBe(false)
  })
})

describe('an action signed by the Swift code', () => {
  const S = JSON.parse(readFileSync(new URL('../fixtures/push-rich/swift-act.json', import.meta.url), 'utf8'))
  it('passes the full chain the relay and the Mac run (device key -> grant -> action key), at the time it was tapped', async () => {
    const r = await checkNativeAct(S.wire, V.device_public_jwk, V.now_ms + 120_000)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.act).toMatchObject({ a: 'reply', thread_id: 'general' })
  })
  it('verifies under the action key in its grant, byte for byte (CryptoKit raw r||s against WebCrypto)', async () => {
    const wire = NativeActWire.parse(S.wire)
    const grant = JSON.parse(wire.grant)
    const key = await importRawP256(grant.act_pub, 'verify')
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64urlDecode(wire.asig),
      new TextEncoder().encode(
        actSigningInput({
          device_id: wire.device_id,
          id: wire.id,
          ts: wire.ts,
          grant_osig: grant.osig,
          body: wire.body,
        }),
      ),
    )
    expect(ok).toBe(true)
  })
  it('is refused if one byte of the body changes', async () => {
    const wire = NativeActWire.parse({ ...S.wire, body: S.wire.body.replace('"reply"', '"repla"') })
    const grant = JSON.parse(wire.grant)
    const key = await importRawP256(grant.act_pub, 'verify')
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64urlDecode(wire.asig),
      new TextEncoder().encode(
        actSigningInput({
          device_id: wire.device_id,
          id: wire.id,
          ts: wire.ts,
          grant_osig: grant.osig,
          body: wire.body,
        }),
      ),
    )
    expect(ok).toBe(false)
  })
})
