// Audit package D (D2, D9, D21, D22): sign-in names the device, a revoked browser re-enrolls, sign-out empties the device,
// and the sign-out and revoke buttons say what they do. Real parser and real storage layer; only the network is stubbed.
import {
  createExtractableDeviceKeyForTests,
  type DeviceKey,
  loginProofCodeId,
  newEnrollCode,
  SESSION_PROOF_CODE_ID,
  verifyDeviceProof,
} from '@talos-app/protocol'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({ id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {} })),
  startRegistration: vi.fn(),
}))

import { proveDeviceInPlace, runEnrollment, signInWithPasskey } from '../../src/features/auth/passkeys.ts'
import { clearLocalData, pendingWipe, retryPendingWipe, useSession } from '../../src/features/auth/session.ts'
import { AccountSection } from '../../src/features/settings/sections.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { getPlatform } from '../../src/lib/platform.ts'
import type { SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage, type Storage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { LocationProbe } from '../cards/helpers.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.removeItem('talos-app:wipe-pending')
  useSession.setState({ status: 'authed', me: null, offline: false })
})

const json = (status: number, body?: unknown) =>
  body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Call = { method: string; url: string; body: Record<string, unknown> }
function stubNetwork(routes: Record<string, (c: Call) => Response>) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      }
      calls.push(call)
      const h = routes[`${call.method} ${url}`]
      return h ? h(call) : json(404, {})
    }),
  )
  return calls
}

async function seedPrivateData(storage: Storage, key: DeviceKey) {
  await storage.put('keys', 'device', key)
  await storage.put('cache', 'snapshot', { messages: { general: [{ text: 'private' }] } })
  await storage.put('cache', 'me', { device_pinned: true })
  await storage.put('drafts', 'general', 'half written')
  await storage.put('outbox', 'o1', { id: 'o1' })
  await storage.put('blobs', 'b1', new Blob(['voice']))
}
const privateCounts = async (s: Storage) => ({
  cache: (await s.all('cache')).length,
  drafts: (await s.all('drafts')).length,
  outbox: (await s.all('outbox')).length,
  blobs: (await s.all('blobs')).length,
  keys: (await s.all('keys')).length,
})

describe('D2: passkey sign-in names the device key of this storage jar', () => {
  it('posts the stored device id with the passkey response', async () => {
    const key = await createExtractableDeviceKeyForTests()
    const storage = createMemoryStorage()
    await storage.put('keys', 'device', key)
    const calls = stubNetwork({
      'POST /api/auth/login/options': () => json(200, { challenge: 'x' }),
      'POST /api/auth/login/verify': () => json(200, { ok: true }),
      'GET /api/me': () => json(200, { device_id: key.deviceId, device_pinned: true, has_passkey: true }),
    })
    await signInWithPasskey(storage)
    const verify = calls.find((c) => c.url === '/api/auth/login/verify')
    expect(verify?.body.device_id).toBe(key.deviceId)
    expect(verify?.body.response).toBeDefined()
  })

  it('item 3: signs the login challenge with the device key so the relay can check the device, not just the passkey', async () => {
    const key = await createExtractableDeviceKeyForTests()
    const storage = createMemoryStorage()
    await storage.put('keys', 'device', key)
    const challenge = 'C'.repeat(43)
    const calls = stubNetwork({
      'POST /api/auth/login/options': () => json(200, { challenge }),
      'POST /api/auth/login/verify': () => json(200, { ok: true }),
      'GET /api/me': () => json(200, { device_id: key.deviceId, device_pinned: true, has_passkey: true }),
    })
    await signInWithPasskey(storage)
    const proof = calls.find((c) => c.url === '/api/auth/login/verify')?.body.device_proof as {
      nonce: string
      sig: string
    }
    expect(proof.nonce).toBe(challenge)
    // 'cred-1' is the id the mocked passkey answered with: the proof is bound to that passkey
    expect(
      await verifyDeviceProof(key.publicJwk, {
        nonce: challenge,
        codeId: loginProofCodeId('cred-1'),
        deviceId: key.deviceId,
        sig: proof.sig,
      }),
    ).toBe(true)
    expect(
      await verifyDeviceProof(key.publicJwk, {
        nonce: challenge,
        codeId: loginProofCodeId('another-passkey'),
        deviceId: key.deviceId,
        sig: proof.sig,
      }),
    ).toBe(false)
  })

  it('item 3: sends no proof when this jar has no key', async () => {
    const calls = stubNetwork({
      'POST /api/auth/login/options': () => json(200, { challenge: 'C'.repeat(43) }),
      'POST /api/auth/login/verify': () => json(200, { ok: true }),
      'GET /api/me': () => json(200, { device_pinned: false, has_passkey: true }),
    })
    await signInWithPasskey(createMemoryStorage())
    expect(calls.find((c) => c.url === '/api/auth/login/verify')?.body).not.toHaveProperty('device_proof')
  })

  it('item 3: a refused proof reaches the caller as an error, not a signed-in page', async () => {
    const key = await createExtractableDeviceKeyForTests()
    const storage = createMemoryStorage()
    await storage.put('keys', 'device', key)
    stubNetwork({
      'POST /api/auth/login/options': () => json(200, { challenge: 'C'.repeat(43) }),
      'POST /api/auth/login/verify': () => json(403, { error: 'device_proof_required' }),
    })
    await expect(signInWithPasskey(storage)).rejects.toMatchObject({ status: 403 })
  })

  it('sends no device id when this jar has no key (a brand-new browser)', async () => {
    const calls = stubNetwork({
      'POST /api/auth/login/options': () => json(200, { challenge: 'x' }),
      'POST /api/auth/login/verify': () => json(200, { ok: true }),
      'GET /api/me': () => json(200, { device_pinned: false, has_passkey: true }),
    })
    await signInWithPasskey(createMemoryStorage())
    expect(calls.find((c) => c.url === '/api/auth/login/verify')?.body).not.toHaveProperty('device_id')
  })
})

describe('an open browser proves its device key in place', () => {
  const nonce = 'N'.repeat(43)

  it('asks for a challenge, signs it under the session label and posts the proof', async () => {
    const key = await createExtractableDeviceKeyForTests()
    const storage = createMemoryStorage()
    await storage.put('keys', 'device', key)
    const calls = stubNetwork({
      'POST /api/auth/device/prove/options': () => json(200, { challenge: nonce }),
      'POST /api/auth/device/prove': () => json(200, { ok: true }),
    })
    expect(await proveDeviceInPlace(storage)).toBe(true)
    const sent = calls.find((c) => c.url === '/api/auth/device/prove')?.body as { nonce: string; sig: string }
    expect(sent.nonce).toBe(nonce)
    const check = (codeId: string) =>
      verifyDeviceProof(key.publicJwk, { nonce, codeId, deviceId: key.deviceId, sig: sent.sig })
    expect(await check(SESSION_PROOF_CODE_ID)).toBe(true)
    // it is not a sign-in proof or an enrollment proof
    expect(await check('login:cred-1')).toBe(false)
    expect(await check('some-enroll-code')).toBe(false)
  })

  it('does nothing more when the relay says the device already proved its key', async () => {
    const key = await createExtractableDeviceKeyForTests()
    const storage = createMemoryStorage()
    await storage.put('keys', 'device', key)
    const calls = stubNetwork({ 'POST /api/auth/device/prove/options': () => json(200, { proven: true }) })
    expect(await proveDeviceInPlace(storage)).toBe(true)
    expect(calls.map((c) => c.url)).toEqual(['/api/auth/device/prove/options'])
  })

  it('returns false, and makes no request, with no device key in this jar', async () => {
    const calls = stubNetwork({})
    expect(await proveDeviceInPlace(createMemoryStorage())).toBe(false)
    expect(calls).toEqual([])
  })

  it('returns false (does not throw) when the relay refuses, when the network is down and when the reply is empty', async () => {
    const key = await createExtractableDeviceKeyForTests()
    const storage = createMemoryStorage()
    await storage.put('keys', 'device', key)
    stubNetwork({
      'POST /api/auth/device/prove/options': () => json(200, { challenge: nonce }),
      'POST /api/auth/device/prove': () => json(401, { error: 'device_proof_invalid' }),
    })
    expect(await proveDeviceInPlace(storage)).toBe(false)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down')
      }),
    )
    expect(await proveDeviceInPlace(storage)).toBe(false)
    stubNetwork({ 'POST /api/auth/device/prove/options': () => json(200, {}) })
    expect(await proveDeviceInPlace(storage)).toBe(false)
  })
})

describe('D9: a revoked browser makes a new key and enrolls again', () => {
  const revoked = () => json(409, { error: 'device_revoked' })

  function clientWith(keys: DeviceKey[]) {
    let i = 0
    const ensureDevice = vi.fn(async (opts?: { replace?: boolean }) => {
      if (opts?.replace) i += 1
      return keys[i] as DeviceKey
    })
    return { client: { ensureDevice } as unknown as SocketClient, ensureDevice }
  }

  it('replaces the key once and pins the new one', async () => {
    const [oldKey, newKey] = [await createExtractableDeviceKeyForTests(), await createExtractableDeviceKeyForTests()]
    const { client, ensureDevice } = clientWith([oldKey, newKey])
    const sent: string[] = []
    stubNetwork({
      'GET /api/me': () => json(200, { device_pinned: false, has_passkey: true }),
      'POST /api/auth/device/verify': (c) => {
        const id = (c.body.device as { id: string }).id
        sent.push(id)
        return id === oldKey.deviceId ? revoked() : json(202, { accepted: true })
      },
    })
    const out = await runEnrollment(newEnrollCode(), client)
    expect(sent).toEqual([oldKey.deviceId, newKey.deviceId])
    expect(out.deviceId).toBe(newKey.deviceId)
    expect(ensureDevice).toHaveBeenCalledWith({ replace: true })
  })

  it('does not loop: a second revoked answer fails the enrollment', async () => {
    const keys = [
      await createExtractableDeviceKeyForTests(),
      await createExtractableDeviceKeyForTests(),
      await createExtractableDeviceKeyForTests(),
    ]
    const { client, ensureDevice } = clientWith(keys)
    const calls = stubNetwork({
      'GET /api/me': () => json(200, { device_pinned: false, has_passkey: true }),
      'POST /api/auth/device/verify': revoked,
    })
    await expect(runEnrollment(newEnrollCode(), client)).rejects.toThrow()
    expect(calls.filter((c) => c.url === '/api/auth/device/verify')).toHaveLength(2)
    expect(ensureDevice.mock.calls.filter(([o]) => o?.replace)).toHaveLength(1)
  })

  it('a different 409 still does not replace the key', async () => {
    const key = await createExtractableDeviceKeyForTests()
    const { client, ensureDevice } = clientWith([key])
    stubNetwork({
      'GET /api/me': () => json(200, { device_pinned: false, has_passkey: true }),
      'POST /api/auth/device/verify': () => json(409, { error: 'device_exists' }),
    })
    await expect(runEnrollment(newEnrollCode(), client)).rejects.toThrow()
    expect(ensureDevice).not.toHaveBeenCalledWith({ replace: true })
  })
})

describe('D21: clearLocalData', () => {
  it('empties chats, drafts, queued messages, blobs and the remembered identity, and keeps the device key', async () => {
    const key = await createExtractableDeviceKeyForTests()
    const storage = createMemoryStorage()
    await seedPrivateData(storage, key)
    await clearLocalData(storage)
    expect(await privateCounts(storage)).toEqual({ cache: 0, drafts: 0, outbox: 0, blobs: 0, keys: 1 })
  })

  it('after a wipe an offline start does not count as signed in', async () => {
    const storage = createMemoryStorage()
    await storage.put('cache', 'me', { device_pinned: true, has_passkey: true })
    stubNetwork({ 'GET /api/me': () => json(200, { device_pinned: true, has_passkey: true }) })
    expect(await useSession.getState().refresh(storage)).toBe('authed')
    await clearLocalData(storage)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down')
      }),
    )
    expect(await useSession.getState().refresh(storage)).toBe('error')
    expect(useSession.getState().status).toBe('error')
  })

  it('with keepUnsent the queued messages and voice notes stay and every other private store is emptied', async () => {
    const key = await createExtractableDeviceKeyForTests()
    const storage = createMemoryStorage()
    await seedPrivateData(storage, key)
    await storage.put('schedules', 's1', { id: 's1' })
    await clearLocalData(storage, { keepUnsent: true })
    expect(await privateCounts(storage)).toEqual({ cache: 0, drafts: 0, outbox: 1, blobs: 1, keys: 1 })
    expect((await storage.all('schedules')).length).toBe(0)
  })

  it('a 401 at app open (no socket yet) wipes the cached chats but keeps unsent work and the device key', async () => {
    const key = await createExtractableDeviceKeyForTests()
    const storage = createMemoryStorage()
    await seedPrivateData(storage, key)
    stubNetwork({ 'GET /api/me': () => json(401, { error: 'unauthorized', reason: 'expired' }) })
    expect(await useSession.getState().refresh(storage)).toBe('anon')
    await waitFor(async () =>
      expect(await privateCounts(storage)).toEqual({ cache: 0, drafts: 0, outbox: 1, blobs: 1, keys: 1 }),
    )
  })

  it.each([
    ['revoked', { error: 'unauthorized', reason: 'revoked' }],
    ['signed out everywhere', { error: 'unauthorized', reason: 'logged_out_everywhere' }],
    ['no reason (an older relay)', { error: 'unauthorized' }],
  ])('a 401 that says %s wipes the queue too', async (_n, body) => {
    const key = await createExtractableDeviceKeyForTests()
    const storage = createMemoryStorage()
    await seedPrivateData(storage, key)
    stubNetwork({ 'GET /api/me': () => json(401, body) })
    expect(await useSession.getState().refresh(storage)).toBe('anon')
    await waitFor(async () =>
      expect(await privateCounts(storage)).toEqual({ cache: 0, drafts: 0, outbox: 0, blobs: 0, keys: 1 }),
    )
  })

  it('a wipe that fails is remembered, said so on the next open, and retried until it works', async () => {
    const storage = createMemoryStorage()
    await storage.put('outbox', 'o1', { id: 'o1' })
    const realClear = storage.clear.bind(storage)
    let broken = true
    storage.clear = async (n) => {
      if (broken && n === 'outbox') throw new Error('disk')
      return realClear(n)
    }
    await expect(clearLocalData(storage)).rejects.toThrow('disk')
    expect(pendingWipe()).toBe('all')
    expect(await retryPendingWipe(storage)).toBe(false) // still failing: still pending
    expect(pendingWipe()).toBe('all')
    broken = false
    expect(await retryPendingWipe(storage)).toBe(true)
    expect(pendingWipe()).toBeNull()
    expect((await storage.all('outbox')).length).toBe(0)
  })

  it('an unreachable server at open is not a sign-out and wipes nothing', async () => {
    const key = await createExtractableDeviceKeyForTests()
    const storage = createMemoryStorage()
    await seedPrivateData(storage, key)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down')
      }),
    )
    expect(await useSession.getState().refresh(storage)).toBe('authed')
    expect((await privateCounts(storage)).cache).toBe(2)
  })

  it('also empties the remembered searches and local thread notes in localStorage', async () => {
    localStorage.setItem('talos.search.recent', JSON.stringify(['secret query']))
    localStorage.setItem('talos.thread-descriptions', JSON.stringify({ general: 'private note' }))
    localStorage.setItem('talos.threads-explainer-dismissed', '1')
    await clearLocalData(createMemoryStorage())
    expect(localStorage.getItem('talos.search.recent')).toBeNull()
    expect(localStorage.getItem('talos.thread-descriptions')).toBeNull()
  })

  it('still clears the other stores when one fails, then reports the failure', async () => {
    const storage = createMemoryStorage()
    await storage.put('drafts', 'g', 'x')
    const clear = storage.clear.bind(storage)
    storage.clear = async (name) => {
      if (name === 'cache') throw new Error('disk')
      await clear(name)
    }
    await expect(clearLocalData(storage)).rejects.toThrow('disk')
    expect((await storage.all('drafts')).length).toBe(0)
  })
})

describe('Account section: sign out and revoke', () => {
  let storage: Storage
  let mine: DeviceKey
  let other: DeviceKey

  beforeEach(async () => {
    storage = createMemoryStorage()
    mine = await createExtractableDeviceKeyForTests()
    other = await createExtractableDeviceKeyForTests()
    await seedPrivateData(storage, mine)
    // The relay says which device THIS session belongs to; the Account section marks that one.
    useSession.setState({
      status: 'authed',
      me: {
        device_id: mine.deviceId,
        device_pinned: true,
        has_passkey: true,
        rp_id: 'relay.example.com',
        version: 'test',
        bridge_online: true,
      },
      offline: false,
    })
  })

  const device = (k: DeviceKey, name: string) => ({
    id: k.deviceId,
    name,
    pubkey_jwk: k.publicJwk,
    pinned: true,
    revoked: false,
    created_at: '2026-10-01T00:00:00.000Z',
    last_used_at: null,
  })

  function mount(routes: Record<string, (c: Call) => Response>) {
    const calls = stubNetwork({
      'GET /api/devices': () => json(200, [device(mine, 'This phone'), device(other, 'Old laptop')]),
      ...routes,
    })
    const client = createFakeClient()
    client.store.setState((s) => ({ ...s, deviceId: mine.deviceId }))
    const stepup = vi.fn(async () => 'token')
    client.stepup = stepup as never
    const close = vi.spyOn(client, 'close')
    render(
      <ClientProvider client={client}>
        <StorageProvider storage={storage}>
          <MemoryRouter initialEntries={['/settings']}>
            <Routes>
              <Route path="*" element={<AccountSection readOnly={false} />} />
            </Routes>
            <LocationProbe />
          </MemoryRouter>
        </StorageProvider>
      </ClientProvider>,
    )
    return { calls, stepup, close }
  }
  const here = () => screen.getByTestId('location').textContent

  it('Sign out of this device: one POST /logout, then the chats on this device are gone and the key stays', async () => {
    const { calls, close } = mount({ 'POST /api/auth/logout': () => json(204) })
    await screen.findByText('Old laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Sign out of this device' }))
    await waitFor(() => expect(here()).toBe('/login'))
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/auth/logout'])
    expect(close).toHaveBeenCalled()
    expect(await privateCounts(storage)).toEqual({ cache: 0, drafts: 0, outbox: 0, blobs: 0, keys: 1 })
    expect(useSession.getState().status).toBe('anon')
  })

  it('U10: on an iPhone, Sign out of this device asks first and says how to get back; nothing is sent until it is confirmed', async () => {
    vi.spyOn(getPlatform(), 'isIos').mockReturnValue(true)
    const { calls } = mount({ 'POST /api/auth/logout': () => json(204) })
    await screen.findByText('Old laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Sign out of this device' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/new setup link/)
    expect(dialog.textContent).toMatch(/talos-app enroll/)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect((await privateCounts(storage)).cache).toBe(2) // still signed in, still cached
    await userEvent.click(screen.getByRole('button', { name: 'Sign out of this device' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(here()).toBe('/login'))
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/auth/logout'])
    vi.restoreAllMocks()
  })

  it('off an iPhone it still signs out at once, as before', async () => {
    vi.spyOn(getPlatform(), 'isIos').mockReturnValue(false)
    const { calls } = mount({ 'POST /api/auth/logout': () => json(204) })
    await screen.findByText('Old laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Sign out of this device' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(here()).toBe('/login'))
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    vi.restoreAllMocks()
  })

  it('M16: the section is called Devices, not Passkeys and devices', async () => {
    mount({})
    await screen.findByText('Old laptop')
    expect(screen.getByRole('heading', { name: 'Devices' })).toBeTruthy()
    expect(screen.queryByText('Passkeys and devices')).toBeNull()
  })

  it('a failed sign-out says so and wipes nothing', async () => {
    mount({ 'POST /api/auth/logout': () => json(500, { error: 'boom' }) })
    await screen.findByText('Old laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Sign out of this device' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't sign out/)
    expect(here()).not.toBe('/login')
    expect((await privateCounts(storage)).cache).toBe(2)
    expect(useSession.getState().status).toBe('authed')
  })

  it('Sign out everywhere asks first, says what it does, and sends nothing until confirmed', async () => {
    const { calls } = mount({ 'POST /api/auth/logout-all': () => json(204) })
    await screen.findByText('Old laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/every phone, browser and Mac app/)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect((await privateCounts(storage)).cache).toBe(2)

    await userEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }))
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign out everywhere' }),
    )
    await waitFor(() => expect(here()).toBe('/login'))
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/auth/logout-all'])
    expect((await privateCounts(storage)).cache).toBe(0)
  })

  it('a failed sign-out everywhere keeps the owner signed in and shows the error', async () => {
    mount({ 'POST /api/auth/logout-all': () => json(500, {}) })
    await screen.findByText('Old laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }))
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign out everywhere' }),
    )
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't sign out/)
    expect(useSession.getState().status).toBe('authed')
    expect((await privateCounts(storage)).cache).toBe(2)
  })

  it('signing out stops this browser taking pushes, and Sign out everywhere says what the apps need', async () => {
    const unsubscribe = vi.spyOn(getPlatform().push, 'unsubscribe').mockResolvedValue()
    mount({ 'POST /api/auth/logout-all': () => json(204) })
    await screen.findByText('Old laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/iPhone and Mac apps need a new setup link/)
    expect(dialog.textContent).toMatch(/talos-app enroll/)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }))
    await waitFor(() => expect(here()).toBe('/login'))
    expect(unsubscribe).toHaveBeenCalled()
    unsubscribe.mockRestore()
  })

  it('a device the Mac has not confirmed cannot sign out everywhere, so it signs out of itself', async () => {
    const { calls } = mount({
      'POST /api/auth/logout-all': () => json(403, { error: 'device_not_pinned' }),
      'POST /api/auth/logout': () => json(204),
    })
    await screen.findByText('Old laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }))
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign out everywhere' }),
    )
    await waitFor(() => expect(here()).toBe('/login'))
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
      '/api/auth/logout-all',
      '/api/auth/logout',
    ])
    expect((await privateCounts(storage)).cache).toBe(0)
  })

  it('revoking THIS device warns first; confirming signs out, wipes chats and drops the dead key', async () => {
    const { calls, stepup } = mount({ [`POST /api/devices/${mine.deviceId}/revoke`]: () => json(200, { ok: true }) })
    await screen.findByText('Old laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Revoke This phone' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/signs you out here/)
    expect(stepup).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke this device' }))
    await waitFor(() => expect(here()).toBe('/login'))
    expect(stepup).toHaveBeenCalledWith('device:revoke')
    expect(await privateCounts(storage)).toEqual({ cache: 0, drafts: 0, outbox: 0, blobs: 0, keys: 0 })
  })

  it('revoking another device needs no warning and leaves this device signed in', async () => {
    const { calls, stepup } = mount({ [`POST /api/devices/${other.deviceId}/revoke`]: () => json(200, { ok: true }) })
    await screen.findByText('Old laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Old laptop' }))
    await waitFor(() => expect(calls.some((c) => c.url === `/api/devices/${other.deviceId}/revoke`)).toBe(true))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(stepup).toHaveBeenCalled()
    expect(here()).not.toBe('/login')
    expect((await privateCounts(storage)).cache).toBe(2)
  })

  describe('item 3: which devices have proved their key', () => {
    const proven = (k: DeviceKey, name: string, at: string | null) => ({ ...device(k, name), login_proven_at: at })

    it('a pinned device that never proved shows "Key not verified"; a proven one and an older relay do not', async () => {
      mount({
        'GET /api/devices': () =>
          json(200, [proven(mine, 'This phone', '2026-11-01T00:00:00.000Z'), proven(other, 'Old laptop', null)]),
      })
      await screen.findByText('Old laptop')
      expect(screen.getAllByText('Key not verified')).toHaveLength(1)
      expect(screen.getByText('Old laptop').parentElement?.textContent).toContain('Key not verified')
    })

    it('an older relay that sends no login_proven_at shows no badge at all', async () => {
      mount({})
      await screen.findByText('Old laptop')
      expect(screen.queryByText('Key not verified')).toBeNull()
    })
  })

  describe('item 3: a passkey shared with another device', () => {
    const shared = (k: DeviceKey, name: string) => ({ ...device(k, name), shared_passkey: true })

    it('revoking a device on a shared passkey warns first that the passkey stays, and sends nothing until confirmed', async () => {
      const { calls, stepup } = mount({
        'GET /api/devices': () => json(200, [shared(mine, 'This phone'), shared(other, 'Old laptop')]),
        [`POST /api/devices/${other.deviceId}/revoke`]: () => json(204),
      })
      await screen.findByText('Old laptop')
      await userEvent.click(screen.getByRole('button', { name: 'Revoke Old laptop' }))
      const dialog = await screen.findByRole('dialog')
      expect(dialog.textContent).toMatch(/does not remove that passkey/)
      expect(stepup).not.toHaveBeenCalled()
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
      await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke this device' }))
      await waitFor(() => expect(calls.some((c) => c.url === `/api/devices/${other.deviceId}/revoke`)).toBe(true))
      expect((await screen.findByRole('status')).textContent).toMatch(
        /passkey is shared with another device and still works/,
      )
    })

    it('cancel leaves the device alone', async () => {
      const { calls } = mount({
        'GET /api/devices': () => json(200, [shared(mine, 'This phone'), shared(other, 'Old laptop')]),
      })
      await screen.findByText('Old laptop')
      await userEvent.click(screen.getByRole('button', { name: 'Revoke Old laptop' }))
      await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    })

    it('an older relay (no shared_passkey field) keeps the plain one-tap revoke', async () => {
      const { calls } = mount({ [`POST /api/devices/${other.deviceId}/revoke`]: () => json(204) })
      await screen.findByText('Old laptop')
      await userEvent.click(screen.getByRole('button', { name: 'Revoke Old laptop' }))
      await waitFor(() => expect(calls.some((c) => c.url === `/api/devices/${other.deviceId}/revoke`)).toBe(true))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.queryByRole('status')).toBeNull()
    })

    it('revoking THIS device on a shared passkey adds the warning to the existing one', async () => {
      mount({ 'GET /api/devices': () => json(200, [shared(mine, 'This phone'), shared(other, 'Old laptop')]) })
      await screen.findByText('Old laptop')
      await userEvent.click(screen.getByRole('button', { name: 'Revoke This phone' }))
      const dialog = await screen.findByRole('dialog')
      expect(dialog.textContent).toMatch(/signs you out here/)
      expect(dialog.textContent).toMatch(/does not remove that passkey/)
    })
  })

  it('a failed revoke of this device keeps everything', async () => {
    mount({ [`POST /api/devices/${mine.deviceId}/revoke`]: () => json(500, {}) })
    await screen.findByText('Old laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Revoke This phone' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke this device' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't revoke/)
    expect(await privateCounts(storage)).toEqual({ cache: 2, drafts: 1, outbox: 1, blobs: 1, keys: 1 })
  })
})
