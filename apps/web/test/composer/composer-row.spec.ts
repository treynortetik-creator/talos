// The message box has a row of its own on a phone, with the controls in a row beneath it; a wide column keeps the one row
// (the owner, 2026-11-14: "Our text box is tiny ... because it's sharing the same row with the plus mark, voice dictation,
// and the send button"). The switch is the thread column's width, not the window's.
import { expect, type Page, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

const geometry = async (page: Page) => {
  const box = await page.getByLabel('Message', { exact: true }).boundingBox()
  const row = await page.getByTestId('composer-row').boundingBox()
  const plus = await page.getByRole('button', { name: 'Attach' }).boundingBox()
  if (!box || !row || !plus) throw new Error('composer not drawn')
  return { box, row, plus }
}

test('on a phone the box is as wide as the row, and plus and Send sit in a row beneath it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/t/general')
  await page.getByLabel('Message', { exact: true }).fill('Can you look at the deploy log?')
  const { box, row, plus } = await geometry(page)
  expect(Math.abs(box.width - row.width), 'box spans the row').toBeLessThan(2)
  expect(plus.y, 'plus is below the box').toBeGreaterThanOrEqual(box.y + box.height)
  const send = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox()
  expect(send && send.y >= box.y + box.height, 'Send is below the box').toBe(true)
  expect(send && send.x > plus.x, 'Send is right of plus').toBe(true)
})

test('a wide column keeps one row: plus, box and Send side by side', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/t/general')
  await page.getByLabel('Message', { exact: true }).fill('Can you look at the deploy log?')
  const { box, plus } = await geometry(page)
  const send = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox()
  expect(plus.x + plus.width, 'plus is left of the box').toBeLessThanOrEqual(box.x + 1)
  expect(send && send.x >= box.x + box.width, 'Send is right of the box').toBe(true)
  expect(Math.abs(plus.y + plus.height - (box.y + box.height)), 'one row, aligned at the bottom').toBeLessThan(2)
})

test("a desktop window whose thread column is narrow (the sidebar beside it) gets the phone's two rows", async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'a desktop window')
  // 800 px wide with the sidebar open leaves the thread column under 36rem: the column decides, not the window
  await page.setViewportSize({ width: 800, height: 800 })
  await page.goto('/t/general')
  await page.getByLabel('Message', { exact: true }).fill('Can you look at the deploy log?')
  const { box, row, plus } = await geometry(page)
  expect(Math.abs(box.width - row.width), 'box spans the row').toBeLessThan(2)
  expect(plus.y, 'plus is below the box').toBeGreaterThanOrEqual(box.y + box.height)
})
