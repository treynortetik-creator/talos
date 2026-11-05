// K9c: the theme preview card at phone width (375 px): the sample fits with no sideways scroll, shows the draft's colours,
// has Apply and Keep current, and does not repaint the page before the owner decides.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { bindingFrom, Card, configCardCandidate, payloadHash, STOCK_THEMES } from '@talos-app/protocol'
import { open } from './e2e.ts'

// Screenshots go to $SHOT_DIR when it is set (outside the repo), as in settings/settings-home.spec.ts; nothing is written otherwise.
const SHOTS = process.env.SHOT_DIR

test.use({ bypassCSP: true, viewport: { width: 375, height: 812 } })

test('theme card preview at 375 px', async ({ page }) => {
  const dusk = structuredClone(STOCK_THEMES[1]) as (typeof STOCK_THEMES)[number]
  dusk.name = 'dusk'
  dusk.light['--accent'] = '#7a1fa2'
  const card = Card.parse(
    configCardCandidate({
      cardId: 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6',
      threadId: 'general',
      now: '2026-10-28T15:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      origin: 'chat',
      baseRev: 0,
      reason: 'you asked for dusk',
      changes: [{ path: 'theme', old: 'talos', new: dusk }],
    }),
  )
  card.payload_hash = payloadHash(bindingFrom(card))
  await open(page, '/cards', { seed: 'full' })
  await page.evaluate((c) => {
    const t = (window as unknown as { __talos: { store: { setState: (f: (s: any) => any) => void } } }).__talos
    t.store.setState((s) => ({ ...s, cards: [...s.cards, c] }))
  }, card)
  const article = page.locator(`[data-card-id="${card.id}"]`)
  await article.scrollIntoViewIfNeeded()
  const sample = article.getByTestId('theme-preview-sample')
  await expect(sample).toBeVisible()
  await expect(article.getByRole('button', { name: 'Apply' })).toBeVisible()
  await expect(article.getByRole('button', { name: 'Keep current' })).toBeVisible()
  expect(await sample.evaluate((el) => getComputedStyle(el).getPropertyValue('--accent').trim())).toBe('#7a1fa2')
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))).toBe('')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  const box = await sample.boundingBox()
  expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 999) <= 375).toBe(true)
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: join(SHOTS, 'theme-card-375.png'), fullPage: false })
  }
})
