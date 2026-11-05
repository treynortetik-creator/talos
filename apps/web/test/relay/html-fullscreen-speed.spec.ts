import { createHash } from 'node:crypto'
import { newId } from '@talos-app/protocol'
import { expect, test } from '../helpers/fixtures.ts'
import type { Harness } from '../helpers/harness.ts'
import { agentReply, openSignedIn } from '../helpers/util.ts'

function wav(): Buffer {
  const n = 8000
  const b = Buffer.alloc(44 + n)
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
  b.fill(128, 44)
  return b
}

function att(harness: Harness, o: Record<string, unknown>, bytes: Buffer, mime: string) {
  const media_id = newId('md')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  harness.relay.media.set(media_id, { bytes, sha256, mime })
  return { media_id, role: 'attachment', mime, size: bytes.length, sha256, ...o }
}

test('HTML card expands to a full-viewport overlay; Escape and Close dismiss; focus returns', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context)
  const a = att(
    harness,
    { kind: 'html', name: 'report.html' },
    Buffer.from('<!doctype html><body>big page</body>'),
    'text/html',
  )
  harness.relay.sendToApps(agentReply({ text: 'Here.', attachments: [a] }))
  // Chromium waits for a tap before an inline page runs; WebKit runs it at once.
  await page.locator('iframe[title="report.html"], button[aria-label="Run report.html"]').first().waitFor()
  const run = page.getByRole('button', { name: 'Run report.html' })
  if (await run.count()) await run.click()
  await expect(page.locator('iframe[title="report.html"]')).toBeVisible()
  const expand = page.getByRole('button', { name: 'Expand report.html to full screen' })
  await expect(page.getByRole('dialog')).toHaveCount(0)

  for (const how of ['escape', 'close'] as const) {
    await expand.click()
    const overlay = page.getByRole('dialog', { name: 'report.html' })
    await expect(overlay).toBeVisible()
    const vp = page.viewportSize()
    const box = await overlay.boundingBox()
    expect(Math.round(box?.width ?? 0)).toBe(vp?.width)
    expect(Math.round(box?.height ?? 0)).toBe(vp?.height)
    const big = overlay.locator('iframe')
    expect(await big.getAttribute('sandbox')).toBe('allow-scripts')
    expect(await big.getAttribute('referrerpolicy')).toBe('no-referrer')
    await expect(page.frameLocator('[role="dialog"] iframe').locator('body')).toContainText('big page')
    await expect(overlay.getByRole('button', { name: 'Close' })).toBeFocused()
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden')
    if (how === 'escape') await page.keyboard.press('Escape')
    else await overlay.getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(expand).toBeFocused()
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')
  }
})

test('voice speed cycles 1 -> 1.25 -> 1.5 -> 1.75 -> 2 -> 1, sets playbackRate, and is remembered', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context)
  const a = att(harness, { kind: 'audio', name: 'clip.wav' }, wav(), 'audio/wav')
  harness.relay.sendToApps(agentReply({ text: 'Listen.', attachments: [a] }))
  const player = page.getByTestId('audio')
  await expect(player).toBeVisible()
  const rate = () =>
    page.locator('#talos-audio-dock').evaluate((el: HTMLAudioElement) => [el.playbackRate, el.preservesPitch])
  for (const s of ['1.25', '1.5', '1.75', '2', '1']) {
    await player.getByRole('button', { name: /Playback speed/ }).click()
    await expect(player.getByRole('button', { name: `Playback speed ${s}x` })).toBeVisible()
    expect(await rate()).toEqual([Number(s), true])
  }
  await player.getByRole('button', { name: /Playback speed/ }).click()
  await page.reload()
  const again = page.getByTestId('audio')
  await expect(again).toBeVisible()
  await expect(again.getByRole('button', { name: 'Playback speed 1.25x' })).toBeVisible()
  expect(await page.locator('#talos-audio-dock').evaluate((el: HTMLAudioElement) => el.playbackRate)).toBe(1.25)
})
