import { expect, test } from '@playwright/test'

// D1: a device that has never loaded a thread (nothing cached, unread waiting, the Mac out of reach) must not say
// "No messages yet". It offers the load, says where the history lives, and keeps the unread badge until it is seen.
test('a thread with unread but nothing cached is not shown as empty while the Mac is away', async ({ page }) => {
  await page.goto('/threads')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(() => {
    const st = (window as unknown as { __talos: { store: { setState: (f: (s: any) => any) => void } } }).__talos.store
    st.setState((s) => ({
      messages: { ...s.messages, general: [] },
      unread: { ...s.unread, general: 30 },
      presence: { ...s.presence, bridge_online: false },
    }))
  })
  await page.getByTestId('thread-row-general').click()
  await expect(page.getByTestId('thread-screen')).toBeVisible()
  await expect(page.getByText(/live on your Mac/)).toBeVisible()
  await expect(page.getByTestId('load-earlier')).toHaveText('Load messages')
  await expect(page.getByText('No messages yet')).toHaveCount(0)
  // (axe is not run here: with 30 unread the nav badge trips label-content-name-mismatch, a bug outside Timeline)
  const box = await page.getByTestId('load-earlier').boundingBox()
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(36)
  const unread = await page.evaluate(
    () =>
      (window as unknown as { __talos: { store: { getState: () => any } } }).__talos.store.getState().unread.general,
  )
  expect(unread).toBe(30)
})

// Review: history lands AFTER the thread opened (a blank new device), the line is placed above the first unread row, and
// everything fits. Nothing can scroll, so no scroll event follows: the view must not be left "scrolled away" with a Jump
// pill that has nowhere to jump, and replies that come next must be followed.
test('a short thread whose history lands after open puts the line up, shows no Jump pill, and follows the replies', async ({
  page,
}) => {
  await page.goto('/threads')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(() => {
    type Client = {
      store: { setState: (f: (s: any) => any) => void }
      loadHistory: (...a: unknown[]) => Promise<unknown>
    }
    const client = (window as unknown as { __talos: Client }).__talos
    const row = (seq: number) => ({
      id: `m_fit_${seq}`,
      thread_id: 'general',
      author: 'agent',
      kind: 'text',
      text: `fit message ${seq}`,
      format: 'plain',
      attachments: [],
      via: 'app',
      seq,
      created_at: new Date(Date.UTC(2026, 9, 1, 12, seq)).toISOString(),
    })
    ;(window as unknown as { __rows: (n: number) => unknown }).__rows = row
    client.loadHistory = async () => {
      await new Promise((r) => setTimeout(r, 400))
      client.store.setState((s) => ({
        messages: { ...s.messages, general: [row(1), row(2), row(3), row(4)] },
      }))
      return { hasMore: false }
    }
    client.store.setState((s) => ({
      messages: { ...s.messages, general: [] },
      unread: { ...s.unread, general: 2 },
      readUpto: { general: 2 },
    }))
  })
  await page.getByTestId('thread-row-general').click()
  await expect(page.getByTestId('unread-marker')).toBeVisible()
  await expect(page.getByTestId('jump-to-latest')).toHaveCount(0)
  await page.evaluate(() => {
    const w = window as unknown as {
      __rows: (n: number) => unknown
      __talos: { store: { setState: (f: (s: any) => any) => void } }
    }
    w.__talos.store.setState((s) => ({
      messages: { ...s.messages, general: [...s.messages.general, w.__rows(5), w.__rows(6), w.__rows(7)] },
    }))
  })
  await expect(page.getByText('fit message 7', { exact: true })).toBeVisible()
  await expect(page.getByTestId('jump-to-latest')).toHaveCount(0)
})
