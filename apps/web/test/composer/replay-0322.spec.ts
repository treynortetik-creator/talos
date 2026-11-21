// Replay of the owner's bug report of 2026-11-20 03:22 (a browser, his main thread): he typed words and attached a photo; no
// "/" list opened, no Stop showed, Enter did nothing while Shift+Enter made a new line, Send was missing, and a few reloads
// fixed it. The cause was a photo chip stuck at "uploading" with no deadline, which made canSend false. One test per symptom,
// on the web app's own projects (iphone, pixel, desktop), fake mode (window.__talos). The unit test upload-stall.test.tsx
// and the real-stack e2e/tests/composer-upload-stall.spec.ts cover the store and the relay; this drives the owner's steps in
// a browser. The fake client is not a real network: the throttle is a replaced window.__talos.uploadMedia, and the 30 s are
// page.clock's (the stall timer is a plain setTimeout, so the clock drives it).
import { expect, type Page, test } from '@playwright/test'
import { UPLOAD_STALL_MS } from '../../src/features/composer/composerStore.ts'

test.use({ serviceWorkers: 'block', bypassCSP: true })

type Fake = {
  sent: Array<Record<string, unknown>>
  store: { setState(p: unknown): void; getState(): { statuses: Record<string, unknown> } }
  session: { patch(p: Record<string, unknown>): void }
  uploadMedia: (blob: Blob, meta: { name: string; onProgress?: (f: number) => void }) => Promise<unknown>
}
const fake = <T>(page: Page, fn: (t: Fake) => T) => page.evaluate(`(${fn.toString()})(window.__talos)`) as Promise<T>
const messages = (page: Page) =>
  fake(page, (t) =>
    t.sent
      .filter((f) => f.type === 'message')
      .map((f) => ({ text: f.text as string, attachments: (f.attachments as Array<{ kind: string }>) ?? [] })),
  )

const box = (page: Page) => page.getByLabel('Message', { exact: true })
const send = (page: Page) => page.getByRole('button', { name: 'Send', exact: true })
const chip = (page: Page) => page.getByTestId('chip')
const note = (page: Page) => page.getByTestId('composer-note')

// a real 1x1 PNG: a photo
const PHOTO = {
  name: 'IMG_0322.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
}

async function open(page: Page, clock = false) {
  if (clock) await page.clock.install()
  await page.goto('/t/general')
  await expect(page.getByTestId('composer')).toBeVisible()
}
const attach = (page: Page) => page.getByTestId('pick-photos').setInputFiles(PHOTO)
/** Enter sends on a desktop keyboard; on a phone (coarse pointer) it is a newline by design, so the owner taps Send. */
async function submit(page: Page) {
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  if (coarse) await send(page).click()
  else await box(page).press('Enter')
}
const setWorking = (page: Page) =>
  fake(page, (t) => {
    t.store.setState({
      ...t.store.getState(),
      statuses: { general: { thread_id: 'general', state: 'working', since: new Date().toISOString() } },
    })
    t.session.patch({ busy: true, turn_id: 'turn_7' })
  })

test('1. words and a photo, then Enter (Send on a phone): one message holds both, the box clears', async ({ page }) => {
  await open(page)
  // Send is on screen before anything is typed (dimmed): there is always a button to hit
  await expect(send(page)).toBeVisible()
  await expect(send(page)).toHaveAttribute('aria-disabled', 'true')
  await box(page).fill('look at this')
  await attach(page)
  await expect(chip(page)).toHaveAttribute('data-state', 'ready')
  await expect(send(page)).not.toHaveAttribute('aria-disabled', 'true')
  // Shift+Enter is a newline and sends nothing (on a phone Enter is one too)
  await box(page).press('End')
  await box(page).press('Shift+Enter')
  await box(page).pressSequentially('again')
  await expect(box(page)).toHaveValue('look at this\nagain')
  expect(await messages(page)).toHaveLength(0)
  await expect(chip(page)).toHaveCount(1)
  await submit(page)
  await expect.poll(async () => (await messages(page)).length).toBe(1)
  const [m] = await messages(page)
  expect(m?.text).toBe('look at this\nagain')
  expect(m?.attachments.map((a) => a.kind)).toEqual(['image'])
  await expect(box(page)).toHaveValue('')
  await expect(chip(page)).toHaveCount(0)
  await page.waitForTimeout(300)
  expect(await messages(page)).toHaveLength(1)
  // it shows in the thread with its photo
  const mine = page.getByTestId('timeline').getByTestId('msg-owner').last()
  await expect(mine).toContainText('look at this')
  await expect(mine.getByText(PHOTO.name).first()).toBeVisible()
})

test('2. "/" with a ready photo chip opens the list, and the chip survives', async ({ page }) => {
  // The picker looks only at the box's words (SLASH = /^\/(\S*)$/ in SlashPicker.tsx), never at the chips, so a chip must
  // neither block it nor be touched by it. Picking a command clears the words only; the photo stays for the next message.
  await open(page)
  await attach(page)
  await expect(chip(page)).toHaveAttribute('data-state', 'ready')
  await box(page).fill('/')
  await expect(page.getByTestId('slash-picker')).toBeVisible()
  await expect(page.getByTestId('slash-option').first()).toBeVisible()
  await expect(chip(page)).toHaveCount(1)
  await expect(chip(page)).toHaveAttribute('data-state', 'ready')
  // narrowing keeps it open; leaving the "/" closes it, and the chip is still there
  await box(page).pressSequentially('mo')
  await expect(page.getByTestId('slash-picker')).toBeVisible()
  await box(page).fill('hello')
  await expect(page.getByTestId('slash-picker')).toHaveCount(0)
  await expect(chip(page)).toHaveCount(1)
  await expect(send(page)).not.toHaveAttribute('aria-disabled', 'true')
})

test('3. after a send with a photo, the working line shows Stop under the newest message; one tap, one stop', async ({
  page,
}) => {
  await open(page)
  await box(page).fill('finish the report')
  await attach(page)
  await expect(chip(page)).toHaveAttribute('data-state', 'ready')
  await submit(page)
  await expect.poll(async () => (await messages(page)).length).toBe(1)
  await setWorking(page)
  const line = page.getByTestId('stop-line')
  await expect(line).toBeVisible()
  await expect(line).toContainText('is working…')
  // Stop is on the working line, and the message box has none (it moved out of the box on 2026-11-20)
  const stop = line.getByRole('button', { name: 'Stop your agent', exact: true })
  await expect(stop).toBeVisible()
  await expect(page.getByTestId('composer').getByRole('button', { name: /Stop/ })).toHaveCount(0)
  // The sent message shows its photo (the fake client has no media to fetch, so the photo's own row says "Loading <name>"
  // and offers Download; the real pixels are not replayed here). The line sits under the newest message of the thread.
  const mine = page.getByTestId('timeline').getByTestId('msg-owner').last()
  await expect(mine).toContainText('finish the report')
  await expect(mine.getByText(PHOTO.name).first()).toBeVisible()
  const newest = page.getByTestId('timeline').getByRole('article').last()
  const a = await newest.boundingBox()
  const b = await line.boundingBox()
  if (!a || !b) throw new Error('no box')
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1)
  // the box is alive meanwhile: Send is there
  await expect(send(page)).toBeVisible()
  await stop.click()
  await expect.poll(() => fake(page, (t) => t.sent.filter((f) => f.action === 'stop').length)).toBe(1)
  await page.waitForTimeout(300)
  expect(await fake(page, (t) => t.sent.filter((f) => f.action === 'stop').length)).toBe(1)
})

test('4a. a slow upload: progress shows, then ready, Send turns on and sends words and photo', async ({ page }) => {
  await open(page, true)
  await page.evaluate(() => {
    const t = (window as unknown as { __talos: Fake }).__talos
    const real = t.uploadMedia.bind(t)
    t.uploadMedia = async (blob, meta) => {
      // 5% per 2 s, as a bad uplink: 40 s in all, far past the stall time, but never silent
      for (let i = 1; i <= 20; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        meta.onProgress?.(i / 20)
      }
      return real(blob, meta)
    }
  })
  await box(page).fill('slow one')
  await attach(page)
  await expect(chip(page)).toHaveAttribute('data-state', 'uploading')
  await expect(send(page)).toBeVisible()
  await expect(send(page)).toHaveAttribute('aria-disabled', 'true')
  await expect(send(page)).toHaveAttribute('data-waiting', 'true')
  await page.clock.runFor(10_000)
  await expect(chip(page)).toHaveAttribute('data-state', 'uploading')
  await expect(chip(page)).toContainText(/\d+\s*%/)
  // still working after the stall time has passed in total (35 s), because progress keeps coming
  await page.clock.runFor(UPLOAD_STALL_MS - 5000)
  await expect(chip(page)).toHaveAttribute('data-state', 'uploading')
  await page.clock.runFor(10_000)
  await expect(chip(page)).toHaveAttribute('data-state', 'ready')
  await expect(send(page)).not.toHaveAttribute('aria-disabled', 'true')
  await expect(send(page)).not.toHaveAttribute('data-waiting', 'true')
  await submit(page)
  await expect.poll(async () => (await messages(page)).length).toBe(1)
  const [m] = await messages(page)
  expect(m?.text).toBe('slow one')
  expect(m?.attachments).toHaveLength(1)
})

test('4b. an upload that never answers: Enter says why, the chip gives up with Retry and Remove, the words go', async ({
  page,
}) => {
  await open(page, true)
  await page.evaluate(() => {
    ;(window as unknown as { __talos: Fake }).__talos.uploadMedia = () => new Promise(() => {})
  })
  await box(page).fill('no answer here')
  await attach(page)
  await expect(chip(page)).toHaveAttribute('data-state', 'uploading')
  // Send is there, dimmed and showing it waits; Enter (or a tap on Send) says why and sends nothing
  await expect(send(page)).toBeVisible()
  await expect(send(page)).toHaveAttribute('data-waiting', 'true')
  // (Playwright counts aria-disabled as not clickable, so the tap is forced: a finger would reach it)
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  if (!coarse) {
    await box(page).press('Enter')
    await expect(note(page)).toContainText('Waiting for the upload to finish. Remove it to send without it.')
  }
  // typing clears the note, so the line seen after the tap is the tap's own (a real change: the same value fires no change)
  await box(page).fill('no answer here.')
  await expect(note(page)).toHaveCount(0)
  await box(page).fill('no answer here')
  await send(page).click({ force: true })
  await expect(note(page)).toContainText('Waiting for the upload to finish. Remove it to send without it.')
  expect(await messages(page)).toHaveLength(0)
  await expect(box(page)).toHaveValue('no answer here')
  // not yet given up halfway to the stall time (the installed clock also moves with real time, so the margin is wide)
  await page.clock.runFor(UPLOAD_STALL_MS / 2)
  await expect(chip(page)).toHaveAttribute('data-state', 'uploading')
  await page.clock.runFor(UPLOAD_STALL_MS / 2 + 1000)
  await expect(chip(page)).toHaveAttribute('data-state', 'error')
  await expect(page.getByTestId('chip-status')).toHaveText(/Couldn't upload: no answer/)
  await expect(page.getByTestId('chip-retry')).toBeVisible()
  await expect(page.getByRole('button', { name: `Remove ${PHOTO.name}` })).toBeVisible()
  // the box is not dead: Send is on, and Enter (Send on a phone) sends the words
  await expect(send(page)).toBeVisible()
  await expect(send(page)).not.toHaveAttribute('aria-disabled', 'true')
  await expect(send(page)).not.toHaveAttribute('data-waiting', 'true')
  await submit(page)
  await expect.poll(async () => (await messages(page)).length).toBe(1)
  expect((await messages(page))[0]?.text).toBe('no answer here')
})

test('4c. Remove on a stalled photo leaves the words and Send working', async ({ page }) => {
  await open(page, true)
  await page.evaluate(() => {
    ;(window as unknown as { __talos: Fake }).__talos.uploadMedia = () => new Promise(() => {})
  })
  await box(page).fill('without it')
  await attach(page)
  await expect(chip(page)).toHaveAttribute('data-state', 'uploading')
  await page.clock.runFor(UPLOAD_STALL_MS + 1000)
  await expect(chip(page)).toHaveAttribute('data-state', 'error')
  await page.getByRole('button', { name: `Remove ${PHOTO.name}` }).click()
  await expect(chip(page)).toHaveCount(0)
  await submit(page)
  await expect.poll(async () => (await messages(page)).length).toBe(1)
  const [m] = await messages(page)
  expect(m?.text).toBe('without it')
  expect(m?.attachments).toHaveLength(0)
})
