// WP-V3 in a real browser (iphone, pixel, desktop): the driving toggle and /drive against the fake client (VITE_FAKE=1).
// V4.6 web rows: toggle -> one signed config.patch; a forced config_conflict -> one retry; a voice follow-up autoplays
// after the toggle tap; no voice in 20 s -> speechSynthesis.speak (stubbed).
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

type Fake = {
  sent: Array<Record<string, unknown>>
  failNextPatchWith(code: string): void
  store: {
    setState(fn: (s: Record<string, unknown>) => Record<string, unknown>): void
    getState(): Record<string, unknown>
  }
}
// The PWA service worker has a fetch handler; in WebKit, requests that pass through it bypass page.route, so the media
// stub below can miss on iphone (the preview server answers /media/* with index.html). Block the worker so every request
// stays on the stubs. (Re-check 2026-10-30.)
test.use({ serviceWorkers: 'block' })

const fake = <T>(page: Page, fn: (t: Fake) => T) => page.evaluate(`(${fn.toString()})(window.__talos)`) as Promise<T>
const patches = (page: Page) =>
  fake(page, (t) => t.sent.filter((f) => f.type === 'config.patch').map((f) => f.patch as Record<string, unknown>))

/** 3 s of 8 kHz 8-bit silence, long enough to see "Speaking" before it ends. */
function wav(seconds: number): Buffer {
  const n = 8000 * seconds
  const b = Buffer.alloc(44 + n, 0x80)
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

async function stubMedia(page: Page) {
  await page.route('**/media/md_*', (r) => {
    const body = wav(3)
    const m = /bytes=(\d*)-(\d*)/.exec(r.request().headers().range ?? '')
    if (!m) return r.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'Accept-Ranges': 'bytes' }, body })
    const start = m[1] ? Number(m[1]) : 0
    const end = Math.min(m[2] ? Number(m[2]) : body.length - 1, body.length - 1)
    return r.fulfill({
      status: 206,
      contentType: 'audio/wav',
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}` },
      body: body.subarray(start, end + 1),
    })
  })
}
async function stubSpeech(page: Page) {
  await page.addInitScript(() => {
    const spoken: string[] = []
    ;(window as unknown as { __spoken: string[] }).__spoken = spoken
    class U {
      text: string
      constructor(t: string) {
        this.text = t
      }
    }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: U, configurable: true })
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: (u: { text: string }) => spoken.push(u.text), cancel: () => {}, speaking: false },
      configurable: true,
    })
  })
}
// The fake's seeded card is announced once when driving starts; these tests are about replies.
const spoken = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __spoken: string[] }).__spoken.filter((t) => !/waiting for an approval/.test(t)),
  )

const pushAgent = (page: Page, partial: Record<string, unknown>) =>
  page.evaluate((p) => {
    const t = (window as unknown as { __talos: Fake }).__talos
    t.store.setState((s) => {
      const messages = s.messages as Record<string, unknown[]>
      const thread = (p.thread_id as string) ?? 'general'
      const msg = {
        thread_id: thread,
        author: 'agent',
        kind: 'text',
        format: 'plain',
        attachments: [],
        via: 'app',
        created_at: new Date().toISOString(),
        ...p,
      }
      return { ...s, messages: { ...messages, [thread]: [...(messages[thread] ?? []), msg] } }
    })
  }, partial)

const voiceAtt = (id: string) => ({
  media_id: id,
  kind: 'audio',
  role: 'voice_reply',
  mime: 'audio/wav',
  name: 'reply.wav',
  size: 1000,
  sha256: 'a'.repeat(64),
  duration_ms: 3000,
})

test('the Settings toggle sends one signed config.patch for now + 2 h', async ({ page }) => {
  await page.goto('/settings/voice')
  const sw = page.getByRole('switch', { name: 'Driving mode' })
  await expect(sw).toBeVisible()
  await sw.click()
  await expect(sw).toBeChecked()
  const p = await patches(page)
  expect(p).toHaveLength(1)
  const until = Date.parse((p[0] as { voice_notes: { driving_until: string } }).voice_notes.driving_until)
  expect(until - Date.now()).toBeGreaterThan(2 * 3600_000 - 60_000)
  expect(until - Date.now()).toBeLessThanOrEqual(2 * 3600_000 + 1000)
  await sw.click()
  await expect(sw).not.toBeChecked()
  expect((await patches(page))[1]).toEqual({ voice_notes: { driving_until: null } })
})

test('a forced config_conflict is retried once, then the toggle is on', async ({ page }) => {
  await page.goto('/settings/voice')
  await fake(page, (t) => t.failNextPatchWith('config_conflict'))
  const sw = page.getByRole('switch', { name: 'Driving mode' })
  await sw.click()
  await expect(sw).toBeChecked()
  expect(await patches(page)).toHaveLength(1)
  await expect(page.getByText("Couldn't change driving mode")).toHaveCount(0)
})

test('a voice follow-up autoplays after the toggle tap, from any thread', async ({ page }) => {
  await stubMedia(page)
  await stubSpeech(page)
  await page.goto('/settings/voice')
  await page.getByRole('switch', { name: 'Driving mode' }).click()
  await expect(page.getByRole('switch', { name: 'Driving mode' })).toBeChecked()
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4B1', text: 'Done.' })
  await pushAgent(page, {
    id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4B2',
    thread_id: 'inbox',
    kind: 'voice_note',
    reply_to: 'm_01JBF3V7Q8K2M4N6P8R0S2T4B1',
    attachments: [voiceAtt('md_01JBF3V7Q8K2M4N6P8R0S2T4B3')],
  })
  const audio = page.getByTestId('drive-audio')
  await expect(audio).toHaveAttribute('src', /md_01JBF3V7Q8K2M4N6P8R0S2T4B3/)
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(false)
  expect(await spoken(page)).toEqual([])
})

test('no voice in 20 s: the phone reads the plain text aloud', async ({ page }) => {
  await stubSpeech(page)
  await page.clock.install()
  await page.goto('/settings/voice')
  await page.getByRole('switch', { name: 'Driving mode' }).click()
  await expect(page.getByRole('switch', { name: 'Driving mode' })).toBeChecked()
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4B4', text: '**Done.** Three sections.' })
  await page.clock.runFor(19_000)
  expect(await spoken(page)).toEqual([])
  await page.clock.runFor(2_000)
  expect(await spoken(page)).toEqual(['Done. Three sections.'])
})

test('/drive: start, status line, controls, no scroll, 22 px text', async ({ page }) => {
  await stubMedia(page)
  await page.goto('/drive')
  const screen = page.getByTestId('drive-screen')
  await expect(screen).toBeVisible()
  await page.getByRole('button', { name: 'Start driving' }).click()
  await expect(page.getByTestId('drive-status')).toContainText('Ready')
  await expect(page.getByRole('button', { name: /Driving · General/ })).toBeVisible()
  await pushAgent(page, { id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4C1', text: 'Done. Three sections.' })
  await expect(page.getByTestId('drive-line')).toContainText('Done. Three sections.')
  await pushAgent(page, {
    id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4C2',
    kind: 'voice_note',
    reply_to: 'm_01JBF3V7Q8K2M4N6P8R0S2T4C1',
    attachments: [voiceAtt('md_01JBF3V7Q8K2M4N6P8R0S2T4C3')],
  })
  await expect(page.getByTestId('drive-status')).toContainText('Speaking')
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  // no page scroll, nothing under 22 px
  const m = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="drive-screen"]') as HTMLElement
    const small = [...el.querySelectorAll<HTMLElement>('*')]
      .filter(
        (n) => n.childNodes.length && [...n.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? '').trim()),
      )
      .filter((n) => parseFloat(getComputedStyle(n).fontSize) < 22)
      .map((n) => n.textContent?.trim())
    return { sh: el.scrollHeight, ch: el.clientHeight, small }
  })
  expect(m.sh).toBeLessThanOrEqual(m.ch)
  expect(m.small).toEqual([])
  const talk = await page.getByTestId('drive-talk').boundingBox()
  expect(talk?.height).toBeGreaterThanOrEqual(139)
  await expect(page.getByTestId('drive-status')).toContainText('Ready', { timeout: 15_000 })
})

test('/drive: a waiting card is counted, not approved; Exit turns driving off', async ({ page }) => {
  await page.goto('/drive')
  await page.getByRole('button', { name: 'Start driving' }).click()
  await expect(page.getByText(/1 card waiting/)).toBeVisible()
  expect(await fake(page, (t) => t.sent.filter((f) => f.type === 'card.resolve').length)).toBe(0)
  await page.getByRole('button', { name: 'Exit' }).click()
  await expect(page.getByTestId('drive-screen')).toHaveCount(0)
  const p = await patches(page)
  expect(p.at(-1)).toEqual({ voice_notes: { driving_until: null } })
})

test('/drive: axe clean', async ({ page }) => {
  await page.goto('/drive')
  await page.getByRole('button', { name: 'Start driving' }).click()
  await expect(page.getByTestId('drive-status')).toBeVisible()
  await expectAxeClean(page)
})
