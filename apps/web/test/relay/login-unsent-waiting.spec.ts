// After a session expires the sign-in page says that unsent messages are waiting and will send after sign-in. Phone width,
// both themes, no sideways scroll, nothing shown when nothing is waiting.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, test } from '../helpers/fixtures.ts'

async function queueRows(page: Page, n: number, signedBy?: string) {
  await page.evaluate(
    async ({ count, who }) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const open = indexedDB.open('talos-app', 1)
        open.onupgradeneeded = () => {
          for (const s of ['keys', 'outbox', 'blobs', 'cache', 'drafts']) open.result.createObjectStore(s)
        }
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('outbox', 'readwrite')
        for (let i = 0; i < count; i++) {
          const id = `01JZ000000000000000000000${i}`
          tx.objectStore('outbox').put(
            {
              id,
              order: i + 1,
              kind: 'message',
              clientMsgId: `m_${id}`,
              threadId: 'general',
              bytes: JSON.stringify(who ? { device_id: who } : {}),
            },
            id,
          )
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    },
    { count: n, who: signedBy },
  )
}

for (const scheme of ['light', 'dark'] as const) {
  test(`sign-in page says unsent messages are waiting (${scheme})`, async ({ page, context, harness }, info) => {
    await page.setViewportSize({ width: 360, height: 740 })
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await harness.seedDevice(context, page)
    await queueRows(page, 2)
    harness.expireSessions()
    await page.goto('/login')
    const note = page.getByRole('status')
    await expect(note).toContainText('2 unsent messages are waiting on this device')
    await expect(note).toContainText('They send once you sign in again')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
    await page.getByRole('button', { name: 'Sign in with passkey' }).focus() // reachable by keyboard
    await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeFocused()
    await page.screenshot({ path: info.outputPath(`login-waiting-${scheme}.png`) })
  })
}

test('sign-in page shows no waiting note when nothing is queued', async ({ page, context, harness }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await harness.seedDevice(context, page)
  harness.expireSessions()
  await page.goto('/login')
  await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible()
  await expect(page.getByRole('status')).toHaveCount(0)
})

test('Discard removes what is waiting, and only what this device can send is counted', async ({
  page,
  context,
  harness,
}) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await harness.seedDevice(context, page)
  await queueRows(page, 2)
  harness.expireSessions()
  await page.goto('/login')
  await expect(page.getByRole('status')).toContainText('2 unsent messages')
  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByRole('status')).toHaveCount(0)
  const left = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('talos-app')
        open.onsuccess = () => {
          const req = open.result.transaction('outbox').objectStore('outbox').count()
          req.onsuccess = () => resolve(req.result)
        }
      }),
  )
  expect(left).toBe(0)
})

test('rows signed by a different key are not promised, and an unfinished sign-out wipe is said out loud', async ({
  page,
  context,
  harness,
}) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await harness.seedDevice(context, page)
  await queueRows(page, 2, 'd_someoneelse')
  harness.expireSessions()
  await page.goto('/login')
  await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible()
  await expect(page.getByRole('status')).toHaveCount(0) // nothing here can be sent, so nothing is promised

  // a sign-out whose clear failed leaves a marker; the page retries it and, while it still fails, says so
  await page.evaluate(() => localStorage.setItem('talos-app:wipe-pending', 'all'))
  await page.addInitScript(() => {
    IDBObjectStore.prototype.clear = () => {
      throw new DOMException('The database connection is closing.', 'InvalidStateError')
    }
  })
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('could not be removed from this device')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})
