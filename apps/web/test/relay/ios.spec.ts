import { expect, test } from '../helpers/fixtures.ts'

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1'
test.use({ userAgent: IPHONE_UA })

test('iOS in a Safari tab: the enroll page does not consume the code and offers [Copy setup link]', async ({
  page,
  harness,
  browserName,
}) => {
  const { link } = harness.armEnroll()
  if (browserName === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(link)
  await expect(page.getByRole('heading', { name: 'Add Talos to your Home Screen first' })).toBeVisible()
  await expect(page.getByText('Add to Home Screen')).toBeVisible()
  const copy = page.getByRole('button', { name: 'Copy setup link' })
  await expect(copy).toBeVisible()
  await copy.click()
  if (browserName === 'chromium') {
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link)
  }
  // Nothing was sent to the auth routes: the code is still good.
  expect(harness.authCalls.filter((c) => c.includes('/api/auth/enroll') || c.includes('/api/auth/device'))).toEqual([])
  expect(harness.failedAuthCalls).toBe(0)
})

test('iOS Home Screen app with no session and no link shows [Paste setup link]', async ({ page, harness }) => {
  await page.addInitScript(() => {
    const orig = window.matchMedia.bind(window)
    window.matchMedia = (q: string) =>
      q.includes('display-mode: standalone')
        ? ({
            matches: true,
            media: q,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            onchange: null,
            dispatchEvent: () => false,
          } as unknown as MediaQueryList)
        : orig(q)
  })
  await page.goto('/enroll')
  await expect(page.getByRole('button', { name: 'Paste setup link' })).toBeVisible()
  await expect(page.getByLabel('Or type the link or code')).toBeVisible()
  await page.getByLabel('Or type the link or code').fill('not a link')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('alert')).toContainText("doesn't look like a setup link")
  expect(harness.authCalls).toEqual([])
})
