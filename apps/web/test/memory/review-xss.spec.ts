// Adversarial review of WP-V5 (PR #44), in real browsers (iPhone/WebKit, Pixel and desktop Chromium): hostile notes as
// frames the REAL bridge memory service produced (captured/memory/review-xss.json), opened through the real MemoryScreen,
// NoteView and socket adapter in the memory harness. A note must never run code.
// FAILS ON PR HEAD wherever the browser serialises `>` inside attribute values unescaped (see review-xss.test.tsx).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'

const cap = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../packages/testkit/fixtures/captured/memory/review-xss.json',
    ),
    'utf8',
  ),
) as { frames: Array<{ frame: Record<string, unknown> }> }

async function openHostile(page: Page, notePath: string) {
  const frame = cap.frames.find((s) => s.frame.path === notePath)?.frame
  expect(frame).toBeTruthy()
  await page.goto('/test/memory/harness/index.html?route=/memory')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await expect(page.getByTestId('memory-entry-Overview.md')).toBeVisible()
  // the Mac answers this read with the captured hostile frame
  await page.evaluate(
    (f) => {
      const m = (window as unknown as { __talos: { memory: { read: unknown } } }).__talos.memory
      m.read = async () => ({
        text: f.text,
        mime: f.mime,
        size: f.size,
        mtime: f.mtime,
        sha256: f.sha256,
        nextOffset: f.next_offset ?? null,
        links: f.links ?? [],
      })
    },
    frame as Record<string, unknown>,
  )
  await page.getByTestId('memory-entry-Overview.md').click()
  await expect(page.getByTestId('memory-body')).toBeVisible()
  await page.waitForTimeout(300) // let an onerror/onload fire if one got in
}

for (const note of ['title-img.md', 'title-svg.md', 'mixed.md', 'front.md']) {
  test(`hostile note ${note} runs nothing and leaves no live element`, async ({ page }) => {
    await openHostile(page, note)
    const body = page.getByTestId('memory-body')
    expect(await body.locator('img, svg, script, iframe, [onerror], [onload]').count()).toBe(0)
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss ?? 0)).toBe(0)
  })
}
