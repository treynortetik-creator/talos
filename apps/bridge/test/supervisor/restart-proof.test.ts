// The owner's restart proof on Linux (restart-proof.ts), on the fixtures shared with the Mac's RestartProofTests.swift
// (packages/protocol/fixtures/agent-request): a real `agent.recover` signed with the committed test device key.
import { describe, expect, it } from 'bun:test'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  b64urlDecode,
  b64urlEncode,
  createExtractableDeviceKeyForTests,
  importDevicePrivateKey,
  type JwkP256T,
  ownerSigningInputFor,
  signOwnerFrame,
} from '@talos-app/protocol'
import { proofUsedKey, type RestartProof, verifyRestartProof } from '../../src/supervisor/restart-proof.ts'

const PROTO = join(import.meta.dir, '../../../../packages/protocol/fixtures')
const KEY = JSON.parse(readFileSync(join(PROTO, 'test-device-key.json'), 'utf8')) as {
  deviceId: string
  publicJwk: JwkP256T
  privateJwk: JsonWebKey
}
const OWNER = JSON.parse(readFileSync(join(PROTO, 'agent-request', 'agent-request-owner.json'), 'utf8')) as {
  control_id: string
  proof: { device_id: string; osig: string; signed_b64url: string }
}
const SIGNED_AT = Date.parse('2026-11-12T17:00:00.000Z')
const fixtureProof = (): RestartProof => ({
  deviceId: OWNER.proof.device_id,
  osig: OWNER.proof.osig,
  signed: b64urlDecode(OWNER.proof.signed_b64url),
})
const env = (over: Partial<Parameters<typeof verifyRestartProof>[1]> = {}) => ({
  controlId: OWNER.control_id,
  nowMs: SIGNED_AT + 30_000,
  launchedAtMs: SIGNED_AT - 60_000,
  markMs: 0,
  pinnedKey: (id: string) => (id === KEY.deviceId ? KEY.publicJwk : undefined),
  isUsed: () => false,
  ...over,
})

/** Signs `text` exactly as given (canonical or not) with the test key. */
async function signText(text: string): Promise<RestartProof> {
  const priv = await importDevicePrivateKey(KEY.privateJwk)
  const sig = new Uint8Array(
    await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      priv as webcrypto.CryptoKey,
      new TextEncoder().encode(ownerSigningInputFor(KEY.deviceId, text)),
    ),
  )
  return { deviceId: KEY.deviceId, osig: b64urlEncode(sig), signed: new TextEncoder().encode(text) }
}
const frame = (over: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'agent.recover',
  id: '01KA0000000000000000000001',
  ts: '2026-11-12T17:00:00.000Z',
  control_id: OWNER.control_id,
  action: 'restart',
  device_id: KEY.deviceId,
  ...over,
})
async function signFrame(over: Record<string, unknown> = {}): Promise<RestartProof> {
  const priv = await importDevicePrivateKey(KEY.privateJwk)
  const f = await signOwnerFrame(frame(over), priv)
  const { osig, ...rest } = f
  // the canonical text, as the phone sends it in signed_b64url
  const { jcs } = await import('@talos-app/protocol')
  return { deviceId: KEY.deviceId, osig, signed: new TextEncoder().encode(jcs(rest)) }
}

describe('the owner’s restart proof (restart-proof.ts, the Mac’s RestartProofCheck)', () => {
  it('the shared fixture verifies: the owner’s, with its used key and signed time', async () => {
    const v = await verifyRestartProof(fixtureProof(), env())
    expect(v).toEqual({ ok: true, deviceId: KEY.deviceId, usedKey: proofUsedKey(fixtureProof()), signedMs: SIGNED_AT })
  })
  it('each step that fails is named: device, signature, frame, control_id, used', async () => {
    expect(await verifyRestartProof(fixtureProof(), env({ pinnedKey: () => undefined }))).toEqual({
      ok: false,
      step: 'device',
    })
    // a key pinned under the fixture's id that is another device's key
    const otherKey = await createExtractableDeviceKeyForTests()
    expect(await verifyRestartProof(fixtureProof(), env({ pinnedKey: () => otherKey.publicJwk }))).toEqual({
      ok: false,
      step: 'device',
    })
    const bad = { ...fixtureProof(), osig: `${OWNER.proof.osig.slice(0, -2)}AA` }
    expect(await verifyRestartProof(bad, env())).toEqual({ ok: false, step: 'signature' })
    const other = { ...fixtureProof(), signed: new TextEncoder().encode('{"x":1}') }
    expect(await verifyRestartProof(other, env())).toEqual({ ok: false, step: 'signature' })
    expect(await verifyRestartProof(fixtureProof(), env({ controlId: '01KA0000000000000000000009' }))).toEqual({
      ok: false,
      step: 'control_id',
    })
    expect(await verifyRestartProof(fixtureProof(), env({ isUsed: () => true }))).toEqual({ ok: false, step: 'used' })
    // signed by the key, but another frame type or action, or another device named inside
    for (const over of [{ type: 'card.resolve' }, { action: 'stop' }, { v: 2 }]) {
      expect(await verifyRestartProof(await signFrame(over), env()), JSON.stringify(over)).toEqual({
        ok: false,
        step: 'frame',
      })
    }
  })
  it('a signed text that is not its own canonical form is no frame (the bytes signed are the bytes judged)', async () => {
    const pretty = JSON.stringify(frame(), null, 1)
    expect(await verifyRestartProof(await signText(pretty), env())).toEqual({ ok: false, step: 'frame' })
    expect(await verifyRestartProof(await signText(`${JSON.stringify(frame())} `), env())).toMatchObject({ ok: false })
  })
  it('the time: too old, too far ahead, before this start, at or before the mark: not his word, never a forgery', async () => {
    const p = fixtureProof()
    const key = proofUsedKey(p)
    expect(await verifyRestartProof(p, env({ nowMs: SIGNED_AT + 5 * 60_000 + 1 }))).toEqual({
      ok: false,
      outOfTime: 'time_skew',
      usedKey: key,
      signedMs: SIGNED_AT,
    })
    expect(await verifyRestartProof(p, env({ nowMs: SIGNED_AT - 2 * 60_000 - 1 }))).toMatchObject({
      outOfTime: 'time_skew',
    })
    expect(await verifyRestartProof(p, env({ launchedAtMs: SIGNED_AT + 1 }))).toMatchObject({
      outOfTime: 'time_before_launch',
    })
    expect(await verifyRestartProof(p, env({ markMs: SIGNED_AT }))).toMatchObject({ outOfTime: 'time_before_mark' })
    expect(await verifyRestartProof(p, env({ markMs: SIGNED_AT - 1 }))).toMatchObject({ ok: true })
  })
  it('a form the canonical check cannot judge (a fraction): its own outcome, not a forgery', async () => {
    expect(await verifyRestartProof(await signFrame({ n: 1.5 }), env())).toMatchObject({
      ok: false,
      outOfTime: 'form_unknown',
    })
  })
})
