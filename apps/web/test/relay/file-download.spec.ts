import { createHash } from 'node:crypto'
import { newId } from '@talos-app/protocol'
import { expect, test } from '../helpers/fixtures.ts'
import { agentReply, openSignedIn } from '../helpers/util.ts'

// A file chip must download under the attachment's own name (the "Upload" / generic "Document" bug).
test('a file chip downloads (desktop) or shares (phone) with its filename and extension', async ({
  page,
  context,
  harness,
}, info) => {
  const phone = info.project.name === 'iphone'
  if (phone) {
    // iphone is in share mode: the tap hands one prepared File to navigator.share; no browser download fires.
    await page.addInitScript(() => {
      const w = window as unknown as { __shared: unknown[]; __inClick: boolean }
      w.__shared = []
      w.__inClick = false
      addEventListener(
        'click',
        () => {
          w.__inClick = true
          setTimeout(() => {
            w.__inClick = false
          }, 0)
        },
        true,
      )
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (d: { files: File[] }) => {
          if (!w.__inClick) throw Object.assign(new Error('no activation'), { name: 'NotAllowedError' })
          w.__shared.push({ n: d.files.length, name: d.files[0]?.name, type: d.files[0]?.type })
        },
      })
    })
  }
  await openSignedIn(harness, page, context)
  const name = 'talos-v1-status.md'
  const media_id = newId('md')
  const bytes = Buffer.from('# Status\n\nAll good.\n')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  harness.relay.media.set(media_id, { bytes, sha256, mime: 'text/markdown', name })
  harness.relay.sendToApps(
    agentReply({
      text: 'Here is the status.',
      attachments: [
        { media_id, kind: 'file', role: 'attachment', mime: 'text/markdown', name, size: bytes.length, sha256 },
      ],
    }),
  )
  const chip = page.getByRole('link', { name: new RegExp(name) })
  await expect(chip).toBeVisible()
  if (phone) {
    await expect(chip).toHaveAttribute('data-prepared', 'true')
    await chip.click()
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared))
      .toEqual([{ n: 1, name, type: 'text/markdown' }])
    return
  }
  const [download] = await Promise.all([page.waitForEvent('download'), chip.click()])
  expect(download.suggestedFilename()).toBe(name)
})
