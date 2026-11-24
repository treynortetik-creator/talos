// Audio started from the Library (Files) has no floating player to stop it, so its row is the control: Play, then Pause, and
// it keeps being the control after the sheet or pane is closed and opened again. Real <audio> (a silent WAV), fake mode.
import { expect, type Page, test } from '@playwright/test'
import { t } from '@talos-app/testkit'
import { isPhoneWidth } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block', timezoneId: 'UTC' })

function wav(seconds: number): Buffer {
  const n = 8000 * seconds
  const b = Buffer.alloc(44 + n, 128)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(8000, 24)
  b.writeUInt32LE(8000, 28)
  b.writeUInt16LE(1, 32)
  b.writeUInt16LE(8, 34)
  b.write('data', 36)
  b.writeUInt32LE(n, 40)
  return b
}

/** Serves byte ranges (WebKit will not play media from a server that ignores them). */
async function serveAudio(page: Page) {
  const bytes = wav(60)
  await page.route('**/media/**', (route) => {
    const m = /bytes=(\d*)-(\d*)/.exec(route.request().headers().range ?? '')
    const start = m?.[1] ? Number(m[1]) : 0
    const end = m?.[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1
    return route.fulfill({
      status: m ? 206 : 200,
      headers: {
        'content-type': 'audio/wav',
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        ...(m ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}),
      },
      body: bytes.subarray(start, end + 1),
    })
  })
}

const player = (page: Page) =>
  page.evaluate(() => {
    const a = document.getElementById('talos-audio') as HTMLAudioElement | null
    return { paused: a?.paused ?? true, t: a?.currentTime ?? 0 }
  })

async function openLibrary(page: Page) {
  if (isPhoneWidth(page)) {
    await page.getByRole('button', { name: 'Library' }).click()
    return page.getByRole('dialog', { name: 'Library' })
  }
  await page.getByRole('toolbar', { name: 'Panes' }).getByRole('button', { name: 'Library' }).click()
  return page.getByRole('complementary', { name: 'Panes' }).getByRole('region', { name: 'Library' })
}

/** The table's two halves: what you sent is on the other side of the agent's. */
async function showOwn(files: ReturnType<Page['locator']>) {
  await files.getByRole('radio', { name: 'From you' }).click()
  await files.getByRole('radiogroup', { name: 'Whose' }).getByRole('radio').first().click()
}

async function closeLibrary(page: Page) {
  if (isPhoneWidth(page)) {
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Library' })).toHaveCount(0)
  } else {
    await page.getByRole('button', { name: 'Close Library' }).click()
    await expect(page.getByRole('region', { name: 'Library' })).toHaveCount(0)
  }
}

test('audio played from Files can be paused from its row, also after the Library was closed and opened again', async ({
  page,
}) => {
  test.setTimeout(t(120_000))
  await page.clock.install({ time: new Date('2026-03-11T12:00:00Z') })
  await serveAudio(page)
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await expect(page.getByTestId('thread-screen')).toBeVisible()
  let files = await openLibrary(page)
  if (!isPhoneWidth(page)) await showOwn(files)
  await files.getByRole('button', { name: /^Play standup-notes\.mp3/ }).click()
  await expect.poll(async () => (await player(page)).t, { timeout: t(15_000) }).toBeGreaterThan(0.5)
  await expect(files.getByRole('button', { name: /^Pause standup-notes\.mp3/ })).toBeVisible()

  await closeLibrary(page)
  expect((await player(page)).paused).toBe(false) // closing the sheet does not stop it

  files = await openLibrary(page)
  if (!isPhoneWidth(page)) await showOwn(files)
  await files.getByRole('button', { name: /^Pause standup-notes\.mp3/ }).click()
  await expect.poll(async () => (await player(page)).paused, { timeout: t(15_000) }).toBe(true)
  await expect(files.getByRole('button', { name: /^Play standup-notes\.mp3/ })).toBeVisible()
})
