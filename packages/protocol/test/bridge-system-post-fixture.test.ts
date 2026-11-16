// The Mac app signs its own system row for the phone (when Main and its bridge are down, and config.json may be what is
// broken), in Swift. Swift cannot import this code, so apps/desktop/Tests/Fixtures/bridge-system-post.json pins what this
// code produces for fixed inputs, and the Swift tests (SystemPostTests) check the Mac against it. This keeps the file honest:
// a change to the signing string, the header or the reply frame shows here first.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { b64urlDecode } from '../src/encoding.ts'
import {
  bridgeHttpString,
  bridgeKeyId,
  importBridgePrivateKey,
  parseFrame,
  signBridgeHttp,
  verifyBridgeHttp,
} from '../src/index.ts'

type Fixture = {
  key_file: { v: 1; pkcs8: string; public: string; key_id: string }
  method: string
  path: string
  ts: number
  nonce: string
  body: string
  signing_string: string
  authorization: string
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../apps/desktop/Tests/Fixtures/bridge-system-post.json'), 'utf8'),
) as Fixture

describe("the Mac's system-post fixture is what the bridge's own code makes", () => {
  it('the same signing string and the same header, from the same key, and the relay accepts it', async () => {
    const k = fixture.key_file
    expect(bridgeKeyId(b64urlDecode(k.public))).toBe(k.key_id)
    const args = {
      method: fixture.method,
      pathWithQuery: fixture.path,
      ts: fixture.ts,
      nonce: fixture.nonce,
      body: fixture.body,
    }
    expect(bridgeHttpString(args)).toBe(fixture.signing_string)
    const header = await signBridgeHttp({ privateKey: await importBridgePrivateKey(k.pkcs8), keyId: k.key_id, ...args })
    expect(header).toBe(fixture.authorization)
    const ok = await verifyBridgeHttp({
      header,
      method: fixture.method,
      pathWithQuery: fixture.path,
      body: fixture.body,
      nowS: fixture.ts,
      keys: [{ keyId: k.key_id, publicKeyB64: k.public }],
    })
    expect(ok.ok).toBe(true)
  })

  it('the body is a reply frame the bridge may send: a system row, headless', () => {
    const r = parseFrame(JSON.parse(fixture.body), { direction: 'bridge_to_relay' })
    expect(r.ok).toBe(true)
    if (!r.ok || r.frame.type !== 'reply') throw new Error('not a reply')
    expect(r.frame.message).toMatchObject({ author: 'system', via: 'headless', kind: 'text', format: 'plain' })
  })
})
