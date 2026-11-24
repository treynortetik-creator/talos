// A clip keeps playing when a card of the same thread is opened (the REAL /card/:id route renders that thread), and still stops
// when he really leaves. Fake mode, real <audio> (a silent WAV); navigation is the app's own router (history + popstate).
import { expect, type Page, test } from '@playwright/test'
import { composePermissionCard } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

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

const card = composePermissionCard({
  request: { request_id: 'bcdfg', tool_name: 'Bash', description: 'Scripted call', input_preview: 'ls' },
  card_id: 'c_01JBF3V7Q8K2M4N6P8R0S97001',
  thread_id: 'general',
  now: Date.parse('2026-10-28T15:59:30.000Z'),
  client_version: '2.1.312',
})

const goTo = (page: Page, path: string) =>
  page.evaluate((p) => {
    history.pushState({}, '', p)
    dispatchEvent(new PopStateEvent('popstate'))
  }, path)
const player = (page: Page) =>
  page.evaluate(() => {
    const a = document.getElementById('talos-audio') as HTMLAudioElement
    return { paused: a.paused, t: a.currentTime, src: a.getAttribute('src') ?? '' }
  })

for (const controls of [true, false]) {
  test(`opening a card of the same thread leaves the clip playing; going home ${controls ? 'keeps it (system controls)' : 'stops it (no system controls)'}`, async ({
    page,
  }) => {
    test.setTimeout(t(120_000))
    if (!controls)
      await page.addInitScript(() =>
        Object.defineProperty(Navigator.prototype, 'mediaSession', { value: undefined, configurable: true }),
      )
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
    await page.goto('/t/general')
    await page.waitForFunction(() => Boolean((window as unknown as { __talosAudio?: unknown }).__talosAudio))
    await page.evaluate((c) => {
      const w = window as unknown as {
        __talos: { store: { getState: () => any; setState: (s: any) => void } }
        __talosAudio: { open: (i: object, src: string, rest: unknown[], o: object) => void }
      }
      const s = w.__talos.store.getState()
      w.__talos.store.setState({ ...s, cards: [...s.cards, c] })
      w.__talosAudio.open({ key: 'm_1', mediaId: 'md_1', title: 'A clip' }, '/media/md_1?c=2', [], { play: true })
    }, card)
    await expect.poll(async () => (await player(page)).t, { timeout: t(15_000) }).toBeGreaterThan(0.5)

    await goTo(page, `/card/${card.id}`) // the real route: CardScreen renders ThreadView for the card's thread
    await expect(page.getByTestId('thread-screen')).toBeVisible()
    const at = (await player(page)).t
    await expect.poll(async () => (await player(page)).t, { timeout: t(15_000) }).toBeGreaterThan(at + 0.3)
    expect((await player(page)).paused).toBe(false)

    await goTo(page, '/threads') // a real leave
    if (controls) {
      const t1 = (await player(page)).t
      await expect.poll(async () => (await player(page)).t, { timeout: t(15_000) }).toBeGreaterThan(t1 + 0.3)
      expect((await player(page)).paused).toBe(false)
    } else {
      await expect.poll(async () => (await player(page)).paused, { timeout: t(15_000) }).toBe(true)
      expect((await player(page)).src).toBe('')
    }
  })
}
