// WP-N0 review F1, web side: signing in again on a device the Mac already pinned answers 409 device_proof_required with a
// nonce; the page signs it with the device key and sends the same request again.
import {
  createExtractableDeviceKeyForTests,
  deriveEnrollAuth,
  enrollAuthHash,
  enrollCodeId,
  newEnrollCode,
  verifyDeviceProof,
} from '@talos-app/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runEnrollment } from '../src/features/auth/passkeys.ts'
import type { SocketClient } from '../src/lib/socketClient.ts'

afterEach(() => vi.unstubAllGlobals())

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('runEnrollment: proof of possession', () => {
  it('signs the relay challenge with the device key and resends', async () => {
    const key = await createExtractableDeviceKeyForTests()
    const code = newEnrollCode()
    const nonce = 'A'.repeat(43)
    const sent: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/me') return json(200, { device_pinned: false, has_passkey: false })
        if (url === '/api/auth/device/verify') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          sent.push(body)
          return body.proof
            ? json(202, { accepted: true })
            : json(409, { error: 'device_proof_required', challenge: nonce })
        }
        return json(404, {})
      }),
    )
    const client = { ensureDevice: async () => key } as unknown as SocketClient
    const out = await runEnrollment(code, client)
    expect(out.deviceId).toBe(key.deviceId)
    expect(sent).toHaveLength(2)
    expect(sent[0]?.proof).toBeUndefined()
    const proof = sent[1]?.proof as { nonce: string; sig: string }
    expect(proof.nonce).toBe(nonce)
    const codeId = enrollCodeId(enrollAuthHash(deriveEnrollAuth(code)))
    expect(await verifyDeviceProof(key.publicJwk, { nonce, codeId, deviceId: key.deviceId, sig: proof.sig })).toBe(true)
  })

  it('does not retry on any other 409', async () => {
    const key = await createExtractableDeviceKeyForTests()
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        if (url === '/api/me') return json(200, { device_pinned: false, has_passkey: false })
        return json(409, { error: 'device_exists' })
      }),
    )
    await expect(
      runEnrollment(newEnrollCode(), { ensureDevice: async () => key } as unknown as SocketClient),
    ).rejects.toThrow()
    expect(calls.filter((u) => u === '/api/auth/device/verify')).toHaveLength(1)
  })
})
