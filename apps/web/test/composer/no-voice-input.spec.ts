// Voice input is archived (2026-11-19, at the owner's request; tag archive/voice-2026-11-19, docs/archived/voice.md): no
// Dictate, no voice-note mic, no live call, no Talk on /drive. The Dictate button had been starting by itself: on a computer Tab
// from the box lands on it and Enter starts it. This pins that nothing in the app asks for the microphone, with the server
// saying dictation and live voice are available, and that the settings and shortcut lists no longer offer them. Every project.
import { expect, type Page, test } from '@playwright/test'
import { DEFAULT_KEYMAP } from '../../src/lib/keymap.ts'

test.use({ serviceWorkers: 'block' })

const box = (page: Page) => page.getByLabel('Message', { exact: true })
const GONE = /^(Dictate|Record a voice note|Start a live call|Stop dictating)$/
const GONE_ON_DRIVE = /^(Talk|Hold to talk|Tap to talk|Talk live|End call)$/

const mics = new WeakMap<Page, { n: number }>()

/** Counts every microphone request (across page loads), and turns on the server flags that used to show the buttons. */
async function open(page: Page, path = '/t/general') {
  let seen = mics.get(page)
  if (!seen) {
    seen = { n: 0 }
    mics.set(page, seen)
    const counter = seen
    await page.exposeFunction('__micRequested', () => void counter.n++)
    await page.addInitScript(() => {
      const w = window as unknown as { __micRequested: () => void }
      const deny = async () => {
        w.__micRequested()
        throw new DOMException('no microphone in this test', 'NotAllowedError')
      }
      const md = navigator.mediaDevices
      if (md) md.getUserMedia = deny
      else Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: deny } })
    })
  }
  await page.goto(path)
  await page.waitForFunction(() => Boolean((window as unknown as { __talosSession?: unknown }).__talosSession))
  await page.evaluate(() => {
    const s = (window as unknown as { __talosSession: { setState(p: unknown): void } }).__talosSession
    s.setState({
      status: 'authed',
      me: {
        device_pinned: true,
        has_passkey: true,
        rp_id: 'x',
        version: '1',
        bridge_online: true,
        dictate: { available: true },
        voice: { available: true },
      },
    })
  })
}
const mic = async (page: Page) => mics.get(page)?.n ?? 0

test('on a thread, with dictation and live voice available, none of their buttons exist (empty or typed)', async ({
  page,
}) => {
  await open(page)
  await expect(box(page)).toBeVisible()
  await expect(page.getByRole('button', { name: GONE })).toHaveCount(0)
  await expect(page.getByTestId('dictate')).toHaveCount(0)
  await expect(page.getByTestId('mic')).toHaveCount(0)
  await box(page).fill('hello')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: GONE })).toHaveCount(0)
  expect(await mic(page)).toBe(0)
})

test('Enter in the box (several, held, after a send) never asks for the microphone', async ({ page, isMobile }) => {
  await open(page)
  await box(page).focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.down('Enter')
  await page.waitForTimeout(600)
  await page.keyboard.up('Enter')
  await box(page).fill('hello')
  if (isMobile)
    await page.getByRole('button', { name: 'Send', exact: true }).click() // Enter is a new line on a phone
  else await page.keyboard.press('Enter') // sends
  await expect(box(page)).toHaveValue('')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  expect(await mic(page)).toBe(0)
})

test('Tab and Enter (and Space) through every composer control never ask for the microphone', async ({ page }) => {
  // every control in the composer, with the box empty and then typed: each is focused, Enter and Space pressed on it, on a
  // fresh page (a control may open a dialog or navigate)
  for (const typed of [false, true]) {
    await open(page)
    const n = await page.getByTestId('composer').locator('button').count()
    for (let i = 0; i <= n; i++) {
      await open(page)
      if (typed) await box(page).fill('draft')
      const button = page.getByTestId('composer').locator('button').nth(i)
      if (i < n) {
        const focused = await button.focus({ timeout: 1000 }).then(
          () => true,
          () => false,
        )
        if (!focused) continue
        await page.keyboard.press('Enter')
        await page.keyboard.press('Space')
      } else {
        // Tab on from the box, pressing Enter on whatever it lands on (on the computer this used to start dictation)
        await box(page).focus()
        for (let t = 0; t < 4; t++) {
          await page.keyboard.press('Tab')
          await page.keyboard.press('Enter')
          await page.keyboard.press('Escape')
        }
      }
      await page.waitForTimeout(50)
    }
  }
  expect(await mic(page)).toBe(0)
})

test('Send, tapped or clicked twice, never asks for the microphone', async ({ page, isMobile }) => {
  await open(page)
  await box(page).fill('hello')
  const b = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox()
  if (!b) throw new Error('no Send')
  const [x, y] = [b.x + b.width / 2, b.y + b.height / 2]
  const press = () => (isMobile ? page.touchscreen.tap(x, y) : page.mouse.click(x, y))
  await press()
  await press()
  await expect(box(page)).toHaveValue('')
  await page.waitForTimeout(800)
  await press()
  await page.waitForTimeout(300)
  expect(await mic(page)).toBe(0)
})

test('/drive has no Talk, Hold to talk, Tap to talk or Talk live button and never asks for the microphone', async ({
  page,
}) => {
  await open(page, '/drive')
  await expect(page.getByTestId('drive-screen')).toBeVisible()
  await expect(page.getByRole('button', { name: GONE_ON_DRIVE })).toHaveCount(0)
  await page.getByRole('button', { name: 'Start driving' }).click()
  await expect(page.getByTestId('drive-status')).toBeVisible()
  await expect(page.getByRole('button', { name: GONE_ON_DRIVE })).toHaveCount(0)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Space')
  expect(await mic(page)).toBe(0)
})

test('Settings > Voice keeps Spoken replies and Driving, and has no live-call voice, microphone mode or persona', async ({
  page,
}) => {
  await open(page, '/settings/voice')
  await expect(page.getByTestId('spoken-replies')).toBeVisible()
  await expect(page.getByTestId('driving-row')).toBeVisible()
  await expect(page.getByLabel('Spoken replies')).toBeVisible()
  await expect(page.getByLabel('Live-call voice')).toHaveCount(0)
  await expect(page.getByText('Live-call personality')).toHaveCount(0)
  await expect(page.getByTestId('voice-persona')).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Microphone' })).toHaveCount(0)
  await expect(page.getByText(/Hands-free|Hold to talk/)).toHaveCount(0)
  await expect(page.getByText(/Tap to talk/)).toHaveCount(0)
  const options = await page.getByLabel('Spoken replies').locator('option').allTextContents()
  expect(options.join('|')).not.toMatch(/voice note/i)
  expect(options).toEqual(['Always', 'Never'])
})

test('the keyboard shortcuts list has no "Start a call"', async ({ page }, info) => {
  expect(DEFAULT_KEYMAP.some((e) => e.id === ('call' as string) || /call/i.test(e.label))).toBe(false)
  test.skip(info.project.name !== 'desktop', 'the phone does not list shortcuts')
  await open(page, '/settings/shortcuts')
  await expect(page.getByTestId('shortcuts-section')).toBeVisible()
  await expect(page.getByTestId('shortcuts-section')).not.toContainText(/Start a call/)
})
