import { loginProofCodeId, signDeviceProof } from '@talos-app/protocol'
import { apiGet, apiPost, cookieFrom, enrollNodePhone } from '../harness/bughunt-node-app.ts'
import { expect, MAIN_NAV, signedIn, test } from '../harness/fixtures.ts'

type DeviceRow = { id: string; login_proven_at: string | null; pinned: boolean }
const devicesOf = async (stack: { origin: string }, cookie: string): Promise<DeviceRow[]> =>
  (await (await fetch(`${stack.origin}/api/devices`, { headers: { cookie } })).json()) as DeviceRow[]

// Device proof at sign-in (docs/SECURITY.md "Passkey sign-in proves the device"): the built relay, the built web app and the
// real bridge. No fake relay stands in for the rule, so a drift between the real client and the real relay turns this red.
test('12. a real browser signs in again with its device proof; the relay lists the device as proven since it enrolled', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  // Enrolling with a proof already counts: a device enrolled after this change cannot be imitated by leaving the proof out.
  const before = (await (await page.request.get(`${stack.origin}/api/devices`)).json()) as DeviceRow[]
  expect(before).toHaveLength(1)
  expect(before[0]?.login_proven_at).toEqual(expect.any(String)) // a time, not null and not a missing field

  // Sign out (drop the session cookie) and sign in with the passkey from the real login page.
  await context.clearCookies()
  await page.goto(`${stack.origin}/login`)
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await expect(MAIN_NAV(page)).toBeVisible({ timeout: 15_000 })
  const me = (await (await page.request.get(`${stack.origin}/api/me`)).json()) as { device_pinned: boolean }
  // Pinned again means the relay accepted the web client's own proof on the real route.
  expect(me.device_pinned).toBe(true)
})

test('12c. an open browser that never proved its key proves it in place on the next page load, and keeps its session', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  // Make this device look like one enrolled before device proof existed.
  stack.relay.services.db.prepare('update auth_devices set login_proven_at = null').run()
  const unproven = (await (await page.request.get(`${stack.origin}/api/devices`)).json()) as DeviceRow[]
  expect(unproven[0]?.login_proven_at).toBeNull()

  const proveCalls: string[] = []
  page.on('response', (r) => {
    if (r.url().includes('/api/auth/device/prove')) proveCalls.push(`${new URL(r.url()).pathname} ${r.status()}`)
  })
  await page.reload()
  await expect(MAIN_NAV(page)).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => proveCalls.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
  expect(proveCalls).toEqual(['/api/auth/device/prove/options 200', '/api/auth/device/prove 200'])

  const after = (await (await page.request.get(`${stack.origin}/api/devices`)).json()) as DeviceRow[]
  expect(after[0]?.login_proven_at).toEqual(expect.any(String))
  // The page still works: the proof did not sign this tab out.
  expect(
    ((await (await page.request.get(`${stack.origin}/api/me`)).json()) as { device_pinned: boolean }).device_pinned,
  ).toBe(true)
})

test('12b. a thief with the synced passkey and the device id is refused unless the device key signs; the real device still gets in', async ({
  stack,
}) => {
  await stack.startBridge()
  const owner = await enrollNodePhone(stack)
  const row = (await devicesOf(stack, owner.cookie))[0]
  expect(row?.login_proven_at).toEqual(expect.any(String))

  const attempt = async (device_proof?: unknown) => {
    const opts = await apiPost(stack, '/api/auth/login/options', {})
    const { challenge } = (await opts.json()) as { challenge: string }
    const res = await apiPost(stack, '/api/auth/login/verify', {
      response: owner.passkey.assert(challenge),
      device_id: owner.device.deviceId,
      ...(device_proof === undefined ? {} : { device_proof }),
    })
    return { res, challenge }
  }

  // No proof at all, and a made-up one: both refused, and no session cookie comes back.
  const none = await attempt()
  expect(none.res.status).toBe(403)
  expect(cookieFrom(none.res)).toBe('')
  const junk = await attempt({ nonce: 'A'.repeat(43), sig: 'B'.repeat(86) })
  expect(junk.res.status).toBe(401)
  expect(cookieFrom(junk.res)).toBe('')

  // The real device key signs the challenge the passkey signed.
  const opts = await apiPost(stack, '/api/auth/login/options', {})
  const { challenge } = (await opts.json()) as { challenge: string }
  const sig = await signDeviceProof(owner.device.privateKey, {
    nonce: challenge,
    codeId: loginProofCodeId(owner.passkey.credId),
    deviceId: owner.device.deviceId,
  })
  const ok = await apiPost(stack, '/api/auth/login/verify', {
    response: owner.passkey.assert(challenge),
    device_id: owner.device.deviceId,
    device_proof: { nonce: challenge, sig },
  })
  expect(ok.status).toBe(200)
  const me = (await (await apiGet(stack, '/api/me', cookieFrom(ok))).json()) as { device_pinned: boolean }
  expect(me.device_pinned).toBe(true)
  // The same proof again is dead: the challenge was single use.
  const replay = await apiPost(stack, '/api/auth/login/verify', {
    response: owner.passkey.assert(challenge),
    device_id: owner.device.deviceId,
    device_proof: { nonce: challenge, sig },
  })
  expect(replay.status).not.toBe(200)
})
