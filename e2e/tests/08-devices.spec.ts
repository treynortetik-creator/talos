import {
  expect,
  openThread,
  rawSocket,
  recordWire,
  sendText,
  sentFrames,
  signedIn,
  test,
  virtualAuthenticator,
  waitUntil,
} from '../harness/fixtures.ts'

test("1b. a device the Mac answers N for stays unpinned and sees none of the owner's data", async ({
  stack,
  page,
  context,
}) => {
  recordWire(page)
  await stack.startBridge()
  await virtualAuthenticator(context, page)
  const cli = stack.cli(['enroll', '--label', 'phone'])
  const [link] = await cli.waitFor(/https?:\/\/\S+\/enroll#\S+/)
  await page.goto(link)
  await page.getByRole('button', { name: /^Continue/ }).click()
  await expect(page.getByTestId('fingerprint')).toBeVisible()
  await cli.waitFor(/\[[^\s\]]+ [^\s\]]+ [^\s\]]+ [^\s\]]+\]\? \[y\/N\]/)

  // Signed in but not pinned yet: the app shows only the waiting notice. There is no thread to type into.
  await page.goto(`${stack.origin}/t/general`)
  await expect(page.getByText('Waiting for your Mac to confirm this device.').first()).toBeVisible()
  await expect(page.getByLabel('Message', { exact: true })).toHaveCount(0)

  cli.write('N\n')
  expect(await cli.done()).toBe(0)
  await waitUntil(() => stack.bridgeLog().includes('device not pinned'), 'the Mac to record the refusal')
  const me = (await (await page.request.get(`${stack.origin}/api/me`)).json()) as { device_pinned: boolean }
  expect(me.device_pinned).toBe(false)
  // The refused session sees none of the owner's data: HTTP is 403, the socket gets an empty `ready` and refuses requests.
  for (const path of [
    '/api/inbox?tab=priority',
    '/api/devices',
    '/api/connections',
    '/media/md_00000000000000000000000000',
  ]) {
    const res = await page.request.get(`${stack.origin}${path}`)
    expect(res.status(), path).toBe(403)
  }
  const hello = sentFrames(page, 'hello')[0]
  if (!hello) throw new Error('no hello captured')
  const history = JSON.stringify({
    v: 1,
    type: 'history.request',
    id: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
    ts: new Date().toISOString(),
    request_id: 'req_1',
    thread_id: 'general',
    limit: 20,
  })
  const frames = await rawSocket(page, [hello.text, history])
  const ready = frames.find((f) => f.type === 'ready')
  expect(ready).toBeTruthy()
  expect(ready?.agent_config).toBeUndefined()
  expect(ready?.threads).toBeUndefined()
  expect(ready?.open_cards).toBeUndefined()
  expect(frames.some((f) => f.type === 'history.page')).toBe(false)
  expect(frames.find((f) => f.type === 'error')).toMatchObject({ code: 'device_not_pinned' })
  // The Mac notes the refusal in its own pin list: nothing was pinned.
  const devices = stack.cli(['devices'])
  await devices.done()
  expect(devices.out).toContain('no devices pinned')
})

test('9. a second live bridge with the same key supersedes the first, which stays down and tells the agent', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const first = stack.claude
  const second = await stack.startSecondBridge()
  try {
    const note = await first.waitForNotification(
      (n) => n.meta.kind === 'system' && /superseded|another bridge/i.test(n.content),
      15_000,
    )
    expect(note.meta.trust).toBe('system')
    await waitUntil(() => stack.bridgeLog().includes('superseded'), 'the first bridge to log it')
    // Messages now go to the second bridge only, and the first does not come back.
    await page.waitForTimeout(4000)
    await openThread(page, 'General')
    await sendText(page, 'who is listening')
    await second.claude.waitForNotification((n) => n.content === 'who is listening', 15_000)
    await page.waitForTimeout(1500)
    expect(first.notifications.filter((n) => n.content === 'who is listening')).toHaveLength(0)
    expect(stack.relay.services.bus.bridgeOnline()).toBe(true)
  } finally {
    await second.claude.stop().catch(() => {})
  }
})
