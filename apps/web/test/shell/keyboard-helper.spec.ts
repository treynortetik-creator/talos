// The shared keyboard helper (test/helpers/keyboard.ts) models a touch device while the keyboard is up, settles before it
// returns, and leaves the page's own pointer answer alone otherwise.
import { expect, type Page, test } from '@playwright/test'
import { keyboard } from '../helpers/keyboard.ts'

const coarse = (page: Page) => page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)
const fine = (page: Page) => page.evaluate(() => window.matchMedia('(pointer: fine)').matches)
const kb = (page: Page) => page.evaluate(() => document.documentElement.dataset.kb ?? null)

async function open(page: Page) {
  await page.goto('/t/general')
  await expect(page.getByTestId('composer')).toBeVisible()
}

test('the page is a touch device while the keyboard is up, and only then', async ({ page }) => {
  await open(page)
  const before = await coarse(page)
  const beforeFine = await fine(page)
  await keyboard(page, 336)
  expect(await coarse(page)).toBe(true)
  await keyboard(page, 0)
  expect(await coarse(page), 'the browser answer is put back').toBe(before)
  expect(await fine(page)).toBe(beforeFine)
})

test('other media queries are untouched while the keyboard is up', async ({ page }) => {
  await open(page)
  const q = '(prefers-reduced-motion: reduce)'
  const real = await page.evaluate((x) => window.matchMedia(x).matches, q)
  await keyboard(page, 336)
  expect(await page.evaluate((x) => window.matchMedia(x).matches, q)).toBe(real)
  expect(await page.evaluate(() => typeof window.matchMedia('(min-width: 1px)').addEventListener)).toBe('function')
  await keyboard(page, 0)
})

test('keyboard() returns after the app has set (and cleared) data-kb, with no waiting in the test', async ({
  page,
}) => {
  await open(page)
  expect(await kb(page)).toBeNull()
  await keyboard(page, 336)
  expect(await kb(page)).toBe('open')
  await keyboard(page, 0)
  expect(await kb(page)).toBeNull()
})

test('a page that never calls keyboard() keeps its real pointer answer', async ({ page }, info) => {
  await open(page)
  expect(await coarse(page)).toBe(info.project.name !== 'desktop')
})
