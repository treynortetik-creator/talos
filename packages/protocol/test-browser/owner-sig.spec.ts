import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { build } from 'esbuild'

// Bundles src/index.ts for the browser and serves it from http://127.0.0.1 (a secure context, so WebCrypto works),
// then signs and verifies in the real engine. A frame signed in the browser must also verify in Node.
import { createDeviceKey, signOwnerFrame, verifyOwnerFrame } from '../src/index.ts'

let server: ReturnType<typeof createServer>
let origin = ''
let bundle = ''

test.beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'TalosProtocol',
    platform: 'browser',
    write: false,
    target: 'es2022',
  })
  bundle = out.outputFiles[0]?.text ?? ''
  server = createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle)
    } else {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><script src="/bundle.js"></script>')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  await new Promise((r) => server.close(r))
})

test('owner signature round trip in the browser, and the browser signature verifies in Node', async ({ page }) => {
  await page.goto(origin)
  const result = await page.evaluate(async () => {
    const P = (globalThis as unknown as { TalosProtocol: typeof import('../src/index.ts') }).TalosProtocol
    const key = await P.createDeviceKey()
    const frame = {
      v: 1,
      type: 'message',
      id: '01JBF3V7Q8K2M4N6P8R0S2T4V6',
      ts: '2026-10-28T15:32:10.120Z',
      thread_id: 'general',
      client_msg_id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4V7',
      text: 'hello é 😀',
      attachments: [],
      device_id: key.deviceId,
    }
    const signed = await P.signOwnerFrame(frame, key.privateKey)
    const ok = await P.verifyOwnerFrame(signed, key.publicJwk)
    const tampered = await P.verifyOwnerFrame({ ...signed, text: 'x' }, key.publicJwk)
    const privateExtractable = key.privateKey.extractable
    return {
      signed,
      jwk: key.publicJwk,
      ok,
      tampered,
      privateExtractable,
      hash: P.sha256Hex('abc'),
      parsed: P.parseFrame(signed).ok,
    }
  })
  expect(result.ok).toBe(true)
  expect(result.tampered).toBe(false)
  expect(result.privateExtractable).toBe(false)
  expect(result.parsed).toBe(true)
  expect(result.hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(await verifyOwnerFrame(result.signed, result.jwk)).toBe(true) // verified in Node
})

test('a frame signed in Node verifies in the browser', async ({ page }) => {
  const key = await createDeviceKey()
  const signed = await signOwnerFrame(
    {
      v: 1,
      type: 'message',
      id: '01JBF3V7Q8K2M4N6P8R0S2T4V6',
      ts: '2026-10-28T15:32:10.120Z',
      thread_id: 'general',
      client_msg_id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4V7',
      text: 'from node',
      attachments: [],
      device_id: key.deviceId,
    },
    key.privateKey,
  )
  await page.goto(origin)
  const ok = await page.evaluate(
    async ({ signed, jwk }) => {
      const P = (globalThis as unknown as { TalosProtocol: typeof import('../src/index.ts') }).TalosProtocol
      return P.verifyOwnerFrame(signed, jwk)
    },
    { signed, jwk: key.publicJwk },
  )
  expect(ok).toBe(true)
})

test('enrollment binding and Ed25519 challenge round trip in the browser', async ({ page }) => {
  await page.goto(origin)
  const r = await page.evaluate(async () => {
    const P = (globalThis as unknown as { TalosProtocol: typeof import('../src/index.ts') }).TalosProtocol
    const code = P.newEnrollCode()
    const dev = await P.createDeviceKey()
    const binding = P.bindingMac(P.deriveEnrollBind(code), dev.deviceId, dev.publicJwk)
    const bindingOk = P.verifyBinding(code, dev.deviceId, dev.publicJwk, binding)
    let ed25519 = 'unsupported'
    try {
      const k = await P.generateBridgeKey()
      const c = { nonce: P.newChallengeNonce(), relay_host: 'relay.example.com', server_time: 1 }
      ed25519 = String(await P.verifyChallenge(k.publicKeyB64, c, await P.signChallenge(k.privateKey, c)))
    } catch (e) {
      ed25519 = `error: ${(e as Error).name}`
    }
    return { bindingOk, ed25519, words: P.fingerprintWords(dev.deviceId).length }
  })
  expect(r.bindingOk).toBe(true)
  expect(r.words).toBe(4)
  // Ed25519 only runs on the Mac and the relay (Node/Bun); report but do not require it from every browser engine.
  expect(['true', 'unsupported']).toContain(r.ed25519.startsWith('error') ? 'unsupported' : r.ed25519)
})
