// The owner's proof in agent-request.json (frames.ts `AgentRequestProof`, built by `buildAgentRequestProof`). The fixtures in
// fixtures/agent-request/ are shared with the Mac app's Swift tests (AgentRequestProofTests.swift): a real `agent.recover` signed with the
// committed test device key exactly as the web app signs (signOwnerFrame), and the request file the bridge writes from it. Both sides check
// the same bytes, so a drift in either one fails here or there. Rewrite them with UPDATE_AGENT_REQUEST_FIXTURES=1.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_REQUEST_SIGNED_MAX,
  AgentRequestFile,
  b64urlDecode,
  buildAgentRequestProof,
  fromUtf8,
  importDevicePrivateKey,
  jcs,
  ownerSignedString,
  parseFrame,
  signOwnerFrame,
  verifyOwnerFrame,
  verifyOwnerSignedString,
} from '../src/index.ts'
import { loadTestKey } from './helpers.ts'

const DIR = join(import.meta.dirname, '..', 'fixtures', 'agent-request')
const read = (name: string) => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as Record<string, unknown>
const FRAME_TS = '2026-11-12T17:00:00.000Z'

async function build() {
  const key = loadTestKey()
  const priv = await importDevicePrivateKey(key.privateJwk)
  const frame = await signOwnerFrame(
    {
      v: 1,
      type: 'agent.recover',
      id: '01KA0000000000000000000001',
      ts: FRAME_TS,
      control_id: '01KA0000000000000000000002',
      action: 'restart',
      device_id: key.deviceId,
    },
    priv,
  )
  const proof = buildAgentRequestProof(frame)
  const request = { v: 1, control_id: frame.control_id, action: 'restart', ts: Date.parse(FRAME_TS) + 1000, proof }
  return { 'agent-recover-signed.json': frame, 'agent-request-owner.json': request }
}

/**
 * What the Mac's own canonicaliser (RestartProofCheck.canonical) must write byte for byte: each object as plain JSON in an order JCS would
 * not use, and its JCS form from the real canonical.ts. Keys that sort differently by UTF-16 code units than by a case-insensitive or
 * numeric-aware compare, and every kind of character JCS escapes or leaves alone.
 */
function canonicalVectors() {
  const objects: Record<string, unknown>[] = [
    { x2: 'a', x10: 'b', X: 'c', a_b: 'd', a: 1, B: 2, b: 3, _: 4, Z9: 5 },
    { s: 'a/b' },
    { s: 'say "hi"' },
    { s: 'back\\slash' },
    { s: 'del\u007f' },
    { s: 'line\u2028sep\u2029' },
    { s: 'smile \u{1F600} and e\u0301' },
    { s: 'ctl \u0001\u001f\b\t\n\f\r' },
    { t: true, f: false, n: null, i: -42, z: 0, big: 9007199254740991 },
    { é: 1, e: 2, ê: 3 },
  ]
  return objects.map((o) => ({ json: JSON.stringify(Object.fromEntries(Object.entries(o).reverse())), jcs: jcs(o) }))
}

if (process.env.UPDATE_AGENT_REQUEST_FIXTURES) {
  mkdirSync(DIR, { recursive: true })
  for (const [name, body] of Object.entries(await build()))
    writeFileSync(join(DIR, name), `${JSON.stringify(body, null, 2)}\n`)
  writeFileSync(join(DIR, 'canonical-vectors.json'), `${JSON.stringify(canonicalVectors(), null, 2)}\n`)
}

describe("agent-request.json's proof", () => {
  it('the shared fixture is a real agent.recover, signed by the test key, and its proof is the bytes the bridge verifies', async () => {
    const key = loadTestKey()
    const frame = read('agent-recover-signed.json')
    expect(parseFrame(frame).ok).toBe(true)
    expect(await verifyOwnerFrame(frame, key.publicJwk)).toBe(true)
    const file = AgentRequestFile.parse(read('agent-request-owner.json'))
    const proof = file.proof
    if (!proof) throw new Error('fixture has no proof')
    expect(proof).toEqual(buildAgentRequestProof(frame))
    const signed = fromUtf8(b64urlDecode(proof.signed_b64url))
    expect(signed).toBe(ownerSignedString(frame))
    expect(await verifyOwnerSignedString(signed, proof.osig, proof.device_id, key.publicJwk)).toBe(true)
    expect(await verifyOwnerFrame({ ...JSON.parse(signed), osig: proof.osig }, key.publicJwk)).toBe(true)
    expect(JSON.parse(signed)).toMatchObject({ type: 'agent.recover', action: 'restart', control_id: file.control_id })
    // the real file is small; the signed text is far under its cap
    expect(readFileSync(join(DIR, 'agent-request-owner.json')).length).toBeLessThan(1024)
    expect(proof.signed_b64url.length).toBeLessThan(AGENT_REQUEST_SIGNED_MAX / 2)
  })

  it('the unsigned fields (relay, stepup_token) are not in the proof, so a relay stamp cannot change it', async () => {
    const frame = read('agent-recover-signed.json')
    const stamped = { ...frame, relay: { seq: 9, received_at: FRAME_TS }, stepup_token: 'x' }
    expect(buildAgentRequestProof(stamped)).toEqual(buildAgentRequestProof(frame))
    expect(await verifyOwnerFrame(stamped, loadTestKey().publicJwk)).toBe(true)
  })

  it('nothing to prove from a frame without a signature or a device', () => {
    const { osig: _o, ...noSig } = read('agent-recover-signed.json')
    expect(buildAgentRequestProof(noSig)).toBeNull()
    const { device_id: _d, ...noDevice } = read('agent-recover-signed.json')
    expect(buildAgentRequestProof(noDevice)).toBeNull()
  })

  it('the canonical vectors the Mac is tested against are the real canonical.ts output', () => {
    const kept = JSON.parse(readFileSync(join(DIR, 'canonical-vectors.json'), 'utf8')) as {
      json: string
      jcs: string
    }[]
    expect(kept).toEqual(canonicalVectors())
    for (const v of kept) expect(jcs(JSON.parse(v.json))).toBe(v.jcs)
    // the orders differ where a case-insensitive or numeric-aware sort would not
    expect((kept[0] as { jcs: string }).jcs).toBe(
      '{"B":2,"X":"c","Z9":5,"_":4,"a":1,"a_b":"d","b":3,"x10":"b","x2":"a"}',
    )
  })

  it('a fresh signature over the same frame makes the same signed bytes (only osig differs)', async () => {
    const fresh = (await build())['agent-request-owner.json'].proof
    const kept = AgentRequestFile.parse(read('agent-request-owner.json')).proof
    expect(fresh?.signed_b64url).toBe(kept?.signed_b64url)
  })
})
