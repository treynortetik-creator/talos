// Journey: switches the owner can flip, and whether the product behaves differently afterwards.
//   - voice-note replies: flipped in the app (Settings, Voice); config.json and the next reply both change.
//   - Chat notifications and Quiet hours: flipped in the app (Settings, Notifications); config.json changes and the relay
//     stops (and later resumes) pushing the next reply, for the reason that switch names.
//   - permission_relay: has no switch in the app (the Health screen says so); it is a line in config.json. Turning it off
//     must close an open approval card and refuse new ones.
//   - memory browser: the app switch (config.memory_browser, which the phone may only turn off) and `talos-app memory on|off`
//     at the Mac; the app must follow each. The app has no control for the first of these yet.
// The apps switch (TALOS_APP_APPS) is E15 in apps.spec.ts and is not repeated here.
import { createECDH, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { permissionFixture } from '@talos-app/testkit'
import { enrollDevice, expect, openThread, recordWire, signedIn, test, waitUntil } from '../../harness/fixtures.ts'
import type { Stack } from '../../harness/stack.ts'

test.setTimeout(120_000)

const readConfig = (stack: Stack) => JSON.parse(readFileSync(join(stack.home, 'config.json'), 'utf8'))
const writeConfig = (stack: Stack, change: (c: Record<string, unknown>) => void) => {
  const c = readConfig(stack)
  change(c)
  writeFileSync(join(stack.home, 'config.json'), `${JSON.stringify(c, null, 2)}\n`)
}

test('settings-switches: voice-note replies set in the app change the config and the next reply', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const select = page.getByLabel('Voice-note replies')

  await test.step('Always: a plain reply comes with audio', async () => {
    await page.goto(`${stack.origin}/settings/voice`)
    await select.selectOption('always')
    await waitUntil(() => readConfig(stack).voice_notes.reply_with_voice === 'always', 'config.json to say always')
    await openThread(page, 'General')
    const r = await stack.claude.callTool('reply', { thread_id: 'general', text: 'plain reply, voice always' })
    expect(r.isError, JSON.stringify(r)).toBeFalsy()
    const msg = page.getByTestId('msg-agent').filter({ hasText: 'plain reply, voice always' })
    await expect(msg).toBeVisible()
    await expect(msg.getByTestId('audio')).toHaveCount(1)
  })

  await test.step('Never: even a reply that asks for voice comes as text only', async () => {
    await page.goto(`${stack.origin}/settings/voice`)
    await select.selectOption('never')
    await waitUntil(() => readConfig(stack).voice_notes.reply_with_voice === 'never', 'config.json to say never')
    await openThread(page, 'General')
    await stack.claude.callTool('reply', { thread_id: 'general', text: 'asked for voice, voice never', voice: true })
    const msg = page.getByTestId('msg-agent').filter({ hasText: 'asked for voice, voice never' })
    await expect(msg).toBeVisible()
    await page.waitForTimeout(1000)
    await expect(msg.getByTestId('audio')).toHaveCount(0)
  })
})

/** The push decisions the relay logged after `since`: `sent`, or `skipped:<reason>`, one per push intent. */
const pushVerdicts = (stack: Stack, since: number): string[] =>
  stack.relayLog
    .slice(since)
    .map((l) => JSON.parse(l) as { msg?: string; reason?: string; template?: string })
    .filter((l) => l.template === 'reply' && (l.msg === 'push sent' || l.msg === 'push skipped'))
    .map((l) => (l.msg === 'push sent' ? 'sent' : `skipped:${l.reason}`))

test('settings-switches: Chat notifications and Quiet hours set in the app change the config and whether a reply is pushed', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  // A push subscription so the relay has somewhere to send; the endpoint is a made-up host and the send may fail, which
  // the relay still logs as a decision. Pushes also stay quiet while someone is at a visible screen, so the relay's clock
  // jumps past the 60 s presence window after each tap, before the reply.
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const sub = await page.request.post(`${stack.origin}/api/push/subscribe`, {
    data: {
      endpoint: 'https://push.example.com/sub/switches',
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
    },
    headers: { origin: stack.origin, 'x-talos-csrf': '1' },
  })
  expect(sub.status(), await sub.text()).toBe(204)
  await page.goto(`${stack.origin}/settings/notifications`)
  const master = page.getByRole('switch', { name: 'Chat notifications' })
  const quiet = page.getByRole('switch', { name: 'Quiet hours' })
  await expect(master).toBeChecked()
  await expect(quiet).not.toBeChecked()

  let n = 0
  /** One agent reply, then what the relay decided to do about its push. */
  const replyAndWatch = async (): Promise<string[]> => {
    stack.skew.ms += 120_000
    const since = stack.relayLog.length
    const r = await stack.claude.callTool('reply', { thread_id: 'general', text: `switch probe ${++n}` })
    expect(r.isError, JSON.stringify(r)).toBeFalsy()
    await waitUntil(() => pushVerdicts(stack, since).length >= 1, 'the relay to decide about the push')
    await new Promise((r) => setTimeout(r, 300))
    return pushVerdicts(stack, since)
  }

  await test.step('both on and off as shipped: the reply is pushed', async () => {
    expect(await replyAndWatch()).toEqual(['sent'])
  })

  await test.step('Chat notifications off: config.json says so and the reply is held back', async () => {
    await master.click()
    await waitUntil(() => readConfig(stack).notifications.master === false, 'config.json to say master false')
    expect(await replyAndWatch()).toEqual(['skipped:master_off'])
  })

  await test.step('Chat notifications on again: pushes resume', async () => {
    await master.click()
    await waitUntil(() => readConfig(stack).notifications.master === true, 'config.json to say master true')
    expect(await replyAndWatch()).toEqual(['sent'])
  })

  await test.step('Quiet hours on, around now: config.json holds the window and the reply is held back', async () => {
    await quiet.click()
    await waitUntil(() => readConfig(stack).quiet_window !== null, 'config.json to hold a quiet window')
    const zone = readConfig(stack).timezone ?? 'UTC'
    const at = (offsetMs: number) =>
      new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
        new Date(stack.now() + 120_000 + offsetMs),
      )
    await page.getByLabel('Quiet hours start').fill(at(-3_600_000))
    await page.getByLabel('Quiet hours end').fill(at(3_600_000))
    await page.getByLabel('Quiet hours end').blur()
    // Both times: the leftover window (22:00 to 07:00) wraps around some hours of the day, so waiting on the start alone
    // can pass on the old window. Wait for the end, which is the last to be saved.
    await waitUntil(
      () =>
        readConfig(stack).quiet_window?.start === at(-3_600_000) &&
        readConfig(stack).quiet_window?.end === at(3_600_000),
      'config.json to hold both new times',
    )
    expect(await replyAndWatch()).toEqual(['skipped:quiet'])
  })

  await test.step('Quiet hours off: config.json drops the window and pushes resume', async () => {
    await quiet.click()
    await waitUntil(() => readConfig(stack).quiet_window === null, 'config.json to drop the quiet window')
    expect(await replyAndWatch()).toEqual(['sent'])
  })
})

test('settings-switches: permission_relay off in config.json closes the open approval card and refuses new ones', async ({
  stack,
  page,
  context,
}) => {
  writeConfig(stack, (c) => {
    c.permission_relay = true
  })
  recordWire(page)
  const claude = await stack.startBridge({ clientVersion: '2.1.312' })
  await enrollDevice(stack, page, context)
  await openThread(page, 'General')

  const first = permissionFixture('plain_bash').params
  await test.step('on: a tool prompt becomes a card in the app', async () => {
    expect((await claude.openPermission(first)).relayed).toBe(true)
    await expect(page.locator('[data-card-id]').filter({ hasText: 'Allow Bash?' })).toBeVisible()
  })

  await test.step('the Health screen reports On, and says where the line lives', async () => {
    await page.goto(`${stack.origin}/settings/health`)
    await expect(page.getByTestId('permission-relay-state')).toContainText('Tool prompts as approval cards: On')
  })

  await test.step('off: the open card closes in the app', async () => {
    writeConfig(stack, (c) => {
      c.permission_relay = false
    })
    await openThread(page, 'General')
    // The card is compact now (Allow lives in the approval sheet), so "no Allow button" proves nothing: wait for the card itself
    // to say it expired, which is the bridge having noticed the switch.
    const open = page.locator('[data-card-id]').filter({ hasText: 'Allow Bash?' })
    await expect(open).toHaveAttribute('data-card-state', 'expired', { timeout: 30_000 })
    await expect(page.locator('[data-card-state="pending"]')).toHaveCount(0)
  })

  await test.step('off: a new prompt makes no card', async () => {
    const ids = () =>
      page.locator('[data-card-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-card-id')))
    const before = await ids()
    expect(before).toHaveLength(1)
    await claude.openPermission({ ...first, request_id: 'abcde' })
    await page.waitForTimeout(1500)
    // The same card ids, not just the same count: a second card, closed or not, is a card made while the switch was off.
    expect(await ids()).toEqual(before)
  })

  await test.step('the Health screen follows', async () => {
    await page.goto(`${stack.origin}/settings/health`)
    await expect(page.getByTestId('permission-relay-state')).toContainText('Tool prompts as approval cards: Off')
  })
})

test('settings-switches: the memory browser follows its app switch and `talos-app memory on|off` at the Mac', async ({
  stack,
  page,
  context,
}) => {
  const agentDir = join(stack.root, 'agent')
  mkdirSync(join(agentDir, 'notes'), { recursive: true })
  writeFileSync(join(agentDir, 'notes', 'hello.md'), '# Hello note\n\nA note the phone may read.\n')
  writeFileSync(
    join(stack.home, 'memory.json'),
    JSON.stringify({
      version: 1,
      enabled: true,
      agent_dir: agentDir,
      roots: [{ id: 'notes', label: 'Notes', path: 'notes', include: ['**/*.md'], exclude: [] }],
      max_file_kb: 512,
    }),
    { mode: 0o600 },
  )
  await signedIn(stack, page, context)

  const seeNote = async () => {
    await expect(async () => {
      await page.goto(`${stack.origin}/memory`)
      await expect(page.getByRole('button', { name: /^Hello note/ })).toBeVisible({ timeout: 4000 })
    }).toPass({ timeout: 45_000 })
  }

  // The bridge notices a hand-edited config.json on its next housekeeping tick, so reload until the app reflects it.
  const seeOff = async () => {
    await expect(async () => {
      await page.reload()
      await expect(page.getByTestId('memory-off')).toBeVisible({ timeout: 4000 })
    }).toPass({ timeout: 45_000 })
    await expect(page.getByRole('button', { name: /^Hello note/ })).toHaveCount(0)
  }

  await test.step('on: the app lists the note', async () => {
    await seeNote()
  })

  await test.step('the app switch alone off (config.memory_browser, what a phone off-switch writes): the app says off', async () => {
    writeConfig(stack, (c) => {
      c.memory_browser = false
    })
    await seeOff()
  })

  await test.step('`talos-app memory on` at the Mac: the note is back', async () => {
    const on = stack.cli(['memory', 'on'])
    expect(await on.done()).toBe(0)
    await seeNote()
  })

  await test.step('`talos-app memory off` at the Mac: off again, and nothing is listed', async () => {
    const off = stack.cli(['memory', 'off'])
    expect(await off.done()).toBe(0)
    await seeOff()
  })
})
