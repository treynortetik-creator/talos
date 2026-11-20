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

// Send is always on screen in its place (the owner, 2026-11-20: "there's no button to hit Send"). With nothing to send it is
// drawn dimmed and does nothing; typing turns it on where it already is, so the row keeps its height on a phone and the box
// keeps its width on a computer.
for (const [name, size] of [
  ['a phone', { width: 390, height: 844 }],
  ['a wide column', { width: 1280, height: 800 }],
] as const) {
  test(`${name}: the empty box shows Send dimmed, it sends nothing, and typing turns it on with nothing moving`, async ({
    page,
  }) => {
    await page.setViewportSize(size)
    await page.goto('/t/general')
    const field = page.getByLabel('Message', { exact: true })
    await expect(field).toBeVisible()
    const send = page.getByRole('button', { name: 'Send', exact: true })
    await expect(send).toBeVisible()
    await expect(send).toHaveAttribute('aria-disabled', 'true')
    const empty = await geometry(page)
    const emptySend = await send.boundingBox()
    expect(empty.row.height, 'a row as high as its buttons').toBeGreaterThanOrEqual(empty.plus.height - 1)
    const before = await page.getByTestId('msg-owner').count()
    await send.click({ force: true }) // a real tap on the dimmed button: it lands, and does nothing
    await field.focus()
    await field.press('Enter')
    await page.waitForTimeout(300)
    expect(await page.getByTestId('msg-owner').count(), 'an empty Send sends nothing').toBe(before)
    await field.fill('x')
    await expect(send).not.toHaveAttribute('aria-disabled', 'true')
    const typed = await geometry(page)
    const typedSend = await send.boundingBox()
    expect(Math.abs(typed.row.height - empty.row.height), 'the row keeps its height').toBeLessThan(1)
    expect(Math.abs(typed.box.width - empty.box.width), 'the box keeps its width').toBeLessThan(1)
    expect(Math.abs(typed.plus.y - empty.plus.y), 'plus does not move').toBeLessThan(1)
    expect(typedSend && emptySend && Math.abs(typedSend.x - emptySend.x) < 1, 'Send does not move').toBe(true)
  })
}
