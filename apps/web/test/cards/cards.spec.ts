import { expect, test } from '@playwright/test'
import { bindingFrom, Card, editedHash, payloadHash } from '@talos-app/protocol'
import { expectAxeClean, open, sentFrames } from './e2e.ts'
import { IDS } from './harness/seed.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

const card = (page: import('@playwright/test').Page, id: string) => page.locator(`[data-card-id="${id}"]`)

test('every decided card state renders its collapse line and no buttons', async ({ page }) => {
  await open(page, '/cards', { seed: 'full' })
  const expected: Record<string, string> = {
    'State done': '✓ Sent 08:41',
    'State killed': '✕ Killed 08:41',
    'State revise': '↻ Asked Talos to change it 08:41',
    'State expired': '⌛ Expired',
    'State failed': "⚠ Couldn't send · Ask Talos to retry",
    'State superseded': '↻ Replaced by a newer draft',
    'State published': '✓ Published 08:41',
    'Expired draft': '⌛ Expired',
  }
  for (const [title, line] of Object.entries(expected)) {
    const article = page.locator('article', { hasText: title }).first()
    await expect(article.getByTestId('collapse-line')).toHaveText(line)
    await expect(article.getByRole('button', { name: /^(Send|Kill draft|Edit)/ })).toHaveCount(0)
  }
})

test('editing a field changes edited_hash and the button reads "Send edited"', async ({ page }) => {
  await open(page, '/cards', { seed: 'full' })
  const article = card(page, IDS.low)
  await expect(article.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  await article.getByRole('button', { name: 'Edit' }).click()
  await expect(article).not.toHaveAttribute('data-edited-hash', /.+/)
  await article.getByRole('textbox', { name: 'Subj' }).fill('Re: Sunday booking')
  await expect(article.getByRole('button', { name: 'Send edited' })).toBeVisible()
  const live = JSON.parse(
    await page.evaluate(
      (id) => JSON.stringify(window.__talos.store.getState().cards.find((c) => c.id === id)),
      IDS.low,
    ),
  )
  const c = Card.parse(live)
  const expected = editedHash(bindingFrom(c), { fields: [{ key: 'subject', value: 'Re: Sunday booking' }] })
  await expect(article).toHaveAttribute('data-edited-hash', expected)
  expect(expected).not.toBe(c.payload_hash)
})

test('Kill names its target and sends the app-computed hash', async ({ page }) => {
  await open(page, '/cards', { seed: 'full' })
  const article = card(page, IDS.low)
  const kill = article.getByRole('button', { name: 'Kill draft' })
  await expect(kill).toBeVisible()
  await kill.click()
  await expect(article.getByTestId('collapse-line')).toHaveText(/^✕ Killed/)
  const frames = await sentFrames(page)
  const last = frames.at(-1) as Record<string, unknown>
  expect(last.type).toBe('card.resolve')
  expect(last.action).toBe('kill')
  const live = Card.parse(
    JSON.parse(
      await page.evaluate(
        (id) => JSON.stringify(window.__talos.store.getState().cards.find((c) => c.id === id)),
        IDS.low,
      ),
    ),
  )
  expect(last.payload_hash).toBe(payloadHash(bindingFrom({ ...live, state: 'pending' })))
})

test('a high-risk primary triggers the step-up mock before anything is sent', async ({ page }) => {
  await open(page, '/cards', { seed: 'full' })
  await page.evaluate(() => {
    const c = window.__talos
    const orig = c.stepup.bind(c)
    c.stepup = async (purpose: string) => {
      window.__order.push(`stepup:${purpose}:sent=${c.sent.length}`)
      return orig(purpose)
    }
  })
  const article = card(page, IDS.fixtureHigh)
  await article.getByRole('button', { name: /Publish/ }).click()
  await expect(article.getByTestId('collapse-line')).toHaveText(/^✓ Published/)
  const order = await page.evaluate(() => window.__order)
  expect(order).toEqual([`stepup:card:${IDS.fixtureHigh}:sent=0`])
  const frames = await sentFrames(page)
  expect(frames.at(-1)?.type).toBe('card.resolve')
})

test('card.resolve carries the hash the app computed from the render', async ({ page }) => {
  await open(page, '/cards', { seed: 'full' })
  const before = Card.parse(
    JSON.parse(
      await page.evaluate(
        (id) => JSON.stringify(window.__talos.store.getState().cards.find((c) => c.id === id)),
        IDS.low,
      ),
    ),
  )
  await card(page, IDS.low).getByRole('button', { name: 'Send', exact: true }).click()
  await expect(card(page, IDS.low).getByTestId('collapse-line')).toHaveText(/^✓ Sent/)
  const last = (await sentFrames(page)).at(-1) as Record<string, unknown>
  expect(last.payload_hash).toBe(payloadHash(bindingFrom(before)))
})

test('an expired card shows no buttons', async ({ page }) => {
  await open(page, '/cards', { seed: 'full' })
  const article = card(page, IDS.expiredLive)
  await expect(article.getByTestId('collapse-line')).toHaveText('⌛ Expired')
  await expect(article.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0)
  await expect(article.getByRole('button', { name: 'Kill draft' })).toHaveCount(0)
})

test('a card whose body changed after hashing renders the altered state with no action buttons', async ({ page }) => {
  await open(page, '/cards', { seed: 'full' })
  const article = card(page, IDS.altered)
  await expect(article).toHaveAttribute('data-card-state', 'altered')
  await expect(article.getByRole('alert')).toHaveText("⚠ This card was altered in transit. Don't approve it.")
  await expect(article.getByRole('button')).toHaveCount(0)
  expect(await sentFrames(page)).toHaveLength(0)
})

test('/card/:id scrolls to the card and highlights it', async ({ page }) => {
  await open(page, `/card/${IDS.low}`, { seed: 'full' })
  const article = card(page, IDS.low)
  await expect(article).toBeInViewport()
  await expect(article).toHaveClass(/ring-2/)
  await expect(article).not.toHaveClass(/ring-2/, { timeout: 4000 })
})

test('axe: cards are clean in light and dark', async ({ page }) => {
  await open(page, '/cards', { seed: 'full' })
  await expectAxeClean(page)
})

test('direction and invisible characters in a card summary, body and warning show as tokens, at phone width', async ({
  page,
}) => {
  await open(page, '/cards', { seed: 'full' })
  const live = Card.parse(
    JSON.parse(
      await page.evaluate(
        (id) => JSON.stringify(window.__talos.store.getState().cards.find((c) => c.id === id)),
        IDS.low,
      ),
    ),
  )
  const hostile = Card.parse({
    ...live,
    summary: 'Pay \u202Etxet\u202C now\u200B',
    body: 'Send the file\u2066 to Bob\u2069.\u2060\nSecond line\nWire to account \u05BD\u200F4417 1234\u200F\u05BD now',
    warning: 'Do not\u202E trust this\uFEFF',
  })
  // Hashed again so the card stays a live, unaltered one and the text is what the owner would approve.
  const withHash = { ...hostile, payload_hash: payloadHash(bindingFrom(hostile)) }
  await page.evaluate(
    ({ id, next }) => {
      const store = window.__talos.store
      const s = store.getState()
      store.setState({ ...s, cards: s.cards.map((c) => (c.id === id ? next : c)) })
    },
    { id: IDS.low, next: withHash },
  )
  const article = card(page, IDS.low)
  await expect(article.getByTestId('card-body')).toContainText('⟦U+2066⟧')
  const text = (await article.textContent()) ?? ''
  for (const raw of ['‮', '⁦', '⁩', '​', '⁠', '﻿']) expect(text).not.toContain(raw)
  expect(text).toContain('⟦U+202E⟧')
  expect(text).toContain('⟦U+FEFF⟧')
  // The tokens wrap inside the card: nothing pushes the page sideways.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
