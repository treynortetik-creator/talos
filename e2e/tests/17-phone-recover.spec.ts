import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hostOf, RECOVER_SENT_TEXT } from '@talos-app/protocol'
import { hostFeature } from '../../apps/bridge/src/handshake.ts'
import { expect, signedIn, test, waitUntil } from '../harness/fixtures.ts'

// Where the phone says the restore is done follows the host the bridge reports (apps/web/src/lib/hostWords.ts): a Mac's
// menu, the PC's icon by the clock (a bridge in WSL reports a Windows host), or plain "your computer" on other Linux.
const RESTORE_WHERE = {
  mac: 'use the Talos menu on your Mac: Restore last good setup',
  windows: 'use the Talos icon by the clock on your PC: Restore last good setup',
  linux: 'do it on your computer, not from here',
} as const

// Restart agent from the phone, end to end: the real app signs agent.recover, the real relay queues the frame once, the real bridge records the result and writes
// agent-request.json for the Mac app. The agent (FakeClaude) is never told anything.

test('17. phone recover: Restart hands a request to the Mac app through agent-request.json, and the agent hears nothing', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const heard = stack.claude.notifications.length // the new-device notice from pairing
  const file = join(stack.home, 'agent-request.json')
  const read = () =>
    JSON.parse(readFileSync(file, 'utf8')) as { v: number; control_id: string; action: string; ts: number }

  await page.goto(`${stack.origin}/settings/agent`)
  await page.getByRole('button', { name: 'Restart agent' }).click()
  await expect(page.getByText(RECOVER_SENT_TEXT)).toBeVisible()
  await waitUntil(() => {
    try {
      return read().action === 'restart'
    } catch {
      return false
    }
  }, 'the Mac to write the restart request')
  const first = read()
  expect(first.v).toBe(1)
  expect(statSync(file).mode & 0o777).toBe(0o600)

  // Restoring is done at the Mac: the phone has no button for it, only the line saying where it is.
  await expect(page.getByRole('button', { name: /restore/i })).toHaveCount(0)
  const host = hostOf([hostFeature()]) ?? 'linux'
  await expect(page.getByText(RESTORE_WHERE[host])).toBeVisible()

  expect(stack.claude.notifications).toHaveLength(heard)
})
