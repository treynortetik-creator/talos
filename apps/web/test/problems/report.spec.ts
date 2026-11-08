// "Report a problem" in a real browser, at phone width (iPhone and Pixel projects) and on desktop: offline submit and
// reconnect, the 429 wording, keyboard and focus, both colour schemes (axe), and the IndexedDB upgrade to version 3.
import { expect, type Page, test } from '@playwright/test'
import type { HealthStatusT } from '@talos-app/protocol'
import { expectAxeClean } from '../cards/e2e.ts'
import { statusOf } from '../health/status.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

// the PWA's service worker would sit between page.route and the page
test.use({ serviceWorkers: 'block' })

type Posted = Array<Record<string, unknown>>

type Answer = { status: number; headers?: Record<string, string>; json?: unknown } | 'down'

async function open(page: Page, respond: (n: number) => Answer) {
  const posted: Posted = []
  await page.route('**/api/status', (r) => r.fulfill({ json: statusOf() as HealthStatusT }))
  await page.route('**/api/problems', (r) => {
    posted.push(r.request().postDataJSON() as Record<string, unknown>)
    const a = respond(posted.length)
    if (a === 'down') {
      posted.pop() // never reached the server
      return r.abort('internetdisconnected')
    }
    return r.fulfill({ status: a.status, headers: a.headers ?? {}, json: a.json ?? { ok: true } })
  })
  await page.goto('/settings/health')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  return posted
}

test('the form opens with the cursor in the note, and sending needs nothing but the keyboard', async ({ page }) => {
  const posted = await open(page, () => ({ status: 202, json: { ok: true, id: 'x' } }))
  await page.getByTestId('report-problem-open').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByLabel(/What were you doing/)).toBeFocused()
  await page.keyboard.type('I tapped Send and the screen froze')
  await expect(page.getByTestId('report-preview')).toContainText('I tapped Send and the screen froze')
  await page.getByRole('button', { name: 'Send report' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('report-sent')).toBeFocused()
  expect(posted).toHaveLength(1)
  expect(posted[0]).toMatchObject({ kind: 'owner', source: 'web', steps: 'I tapped Send and the screen froze' })
  // nothing from the page leaked into the report: only the declared keys
  expect(Object.keys(posted[0] as object).sort()).toEqual(
    [
      'at',
      'device',
      'fingerprint',
      'frames',
      'id',
      'kind',
      'message',
      'name',
      'routes',
      'source',
      'steps',
      'truncated',
      'versions',
    ].sort(),
  )
})

test('offline: the report is saved on the device, says so, and arrives by itself when the network is back', async ({
  page,
  context,
}) => {
  let down = false
  const posted = await open(page, () => (down ? 'down' : { status: 202 }))
  await page.getByTestId('report-problem-open').click()
  await page.getByLabel(/What were you doing/).fill('offline report')
  down = true
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Send report' }).click()
  await expect(page.getByTestId('report-saved')).toContainText('Saved on this device')
  await expect(page.getByTestId('problem-status')).toContainText('1 report is waiting')
  expect(posted).toHaveLength(0)
  down = false
  await context.setOffline(false)
  await expect.poll(() => posted.length).toBe(1)
  expect(posted[0]).toMatchObject({ steps: 'offline report' })
  await expect(page.getByTestId('problem-status')).not.toContainText('waiting')
  // a reload sends nothing twice
  await page.reload()
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.waitForTimeout(300)
  expect(posted).toHaveLength(1)
})

test('a report left in the queue survives a reload and goes out on the next page', async ({ page, context }) => {
  let ok = false
  const posted = await open(page, () => (ok ? { status: 202 } : { status: 503, json: { error: 'down' } }))
  await page.getByTestId('report-problem-open').click()
  await page.getByLabel(/What were you doing/).fill('server was down')
  await page.getByRole('button', { name: 'Send report' }).click()
  await expect(page.getByTestId('report-saved')).toContainText("couldn't take it")
  ok = true
  await page.reload()
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await expect.poll(() => posted.filter((p) => p.steps === 'server was down').length).toBeGreaterThanOrEqual(2)
  void context
})

test('the 429 says the report is saved and goes out when Talos next connects', async ({ page }) => {
  await open(page, () => ({ status: 429, headers: { 'Retry-After': '840' }, json: { error: 'rate_limited' } }))
  await page.getByTestId('report-problem-open').click()
  await page.getByRole('button', { name: 'Send report' }).click()
  await expect(page.getByTestId('report-saved')).toContainText('goes out when Talos next connects')
})

test('an uncaught error in the page becomes a report; a repeat is held back and said so', async ({ page }) => {
  const posted = await open(page, () => ({ status: 202 }))
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++)
      setTimeout(() => {
        throw new Error('page broke')
      }, 0)
  })
  await expect.poll(() => posted.filter((p) => p.kind === 'auto').length).toBe(1)
  await page.getByTestId('report-problem-open').click()
  await expect(page.getByTestId('problem-status')).toContainText('4 repeat reports were held back')
  const auto = posted.find((p) => p.kind === 'auto') as Record<string, unknown>
  expect(auto).toMatchObject({ name: 'Error', message: 'page broke', source: 'web' })
  expect(JSON.stringify(auto)).not.toMatch(/\/Users\/|\/home\//)
})

test('phone width: nothing overflows sideways with the form open, in both colour schemes', async ({ page }) => {
  await open(page, () => ({ status: 202 }))
  await page.getByTestId('report-problem-open').click()
  await page.getByLabel(/What were you doing/).fill('a long note '.repeat(150))
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  const box = await page.getByRole('button', { name: 'Send report' }).boundingBox()
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  await expectAxeClean(page, ['[data-testid="report-problem"]'])
})

test('an existing version-2 database is left alone: old rows stay, it stays at 2, and the problems queue gets its own database', async ({
  page,
}) => {
  await page.goto('/help') // any page of the app's origin; the app is not started on a bare 404
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const del = indexedDB.deleteDatabase('talos-app')
        del.onsuccess =
          del.onerror =
          del.onblocked =
            () => {
              const req = indexedDB.open('talos-app', 2)
              req.onupgradeneeded = () => {
                for (const n of ['keys', 'outbox', 'blobs', 'cache', 'drafts', 'schedules'])
                  req.result.createObjectStore(n)
              }
              req.onsuccess = () => {
                const tx = req.result.transaction('outbox', 'readwrite')
                tx.objectStore('outbox').put({ kind: 'message', bytes: '{}' }, 'old-row')
                tx.oncomplete = () => {
                  req.result.close()
                  resolve()
                }
                tx.onerror = () => reject(tx.error)
              }
              req.onerror = () => reject(req.error)
            }
      }),
  )
  await page.reload()
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  // the app opens the database lazily; opening a report forces a read of the problems store
  await page.goto('/settings/health')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  // The page shifts once when /api/status (not routed here) finishes failing: "Checking…" is replaced by the error block above
  // the button. A click that Playwright aimed before the shift can land on the old spot after it and open nothing, so wait for
  // the layout to settle (the error block is the end state; "Checking…" may not have rendered yet when the app is ready), and if a
  // click is still lost under load, click again until the form is there (bounded at 10 s).
  await expect(page.getByTestId('health-error')).toBeVisible()
  const form = page.getByTestId('report-problem')
  await expect(async () => {
    if (!(await form.isVisible())) await page.getByTestId('report-problem-open').click({ timeout: 2000 })
    await expect(form).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 10_000 })
  const info = await page.evaluate(
    () =>
      new Promise<{ version: number; stores: string[]; old: unknown; side: string[] }>((resolve, reject) => {
        const req = indexedDB.open('talos-app')
        req.onsuccess = () => {
          const db = req.result
          const stores = Array.from(db.objectStoreNames)
          const get = db.transaction('outbox').objectStore('outbox').get('old-row')
          get.onsuccess = () => {
            const out = { version: db.version, stores, old: get.result }
            db.close()
            const side = indexedDB.open('talos-app-problems')
            side.onsuccess = () => {
              const names = Array.from(side.result.objectStoreNames)
              side.result.close()
              resolve({ ...out, side: names })
            }
            side.onerror = () => reject(side.error)
          }
          get.onerror = () => reject(get.error)
        }
        req.onerror = () => reject(req.error)
      }),
  )
  // an older build opens `talos-app` at version 2: it must not have been raised
  expect(info.version).toBe(2)
  expect(info.stores).not.toContain('problems')
  expect(info.side).toEqual(['problems'])
  expect(info.old).toEqual({ kind: 'message', bytes: '{}' })
})
