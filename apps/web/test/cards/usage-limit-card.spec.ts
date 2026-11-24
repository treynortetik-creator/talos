// The usage-limit card (pane-prompts row 7) in a real browser at phone width (375 px, and the 320 px SE): the reset time in words, two buttons a finger
// wide, no sideways scroll, by keyboard (Tab to the first button, Enter sends its index), where focus lands, the answered / nothing pressed / expired
// states, and clean for axe in both themes. Nothing on it names a terminal.
import { expect, test } from '@playwright/test'
import { bindingFrom, Card, composeDialogCard, payloadHash, type WorkerDialogT } from '@talos-app/protocol'
import { expectAxeClean, open, sentFrames } from './e2e.ts'

test.use({ bypassCSP: true, viewport: { width: 375, height: 812 } })

const dialog = (over: Partial<WorkerDialogT> = {}): WorkerDialogT => ({
  id: 'Ul5Qm8ZtRx3Cw9PkNa2HdB',
  kind: 'usage_limit',
  subject: 'Fable limit reached. It resets Aug 8, 4pm (Europe/Paris).',
  options: ['Stop and wait', 'Switch model'],
  cursor: null,
  seen_at: '2026-10-28T16:00:00.000Z',
  expires_at: '2026-10-28T16:15:00.000Z',
  ...over,
})

async function show(
  page: import('@playwright/test').Page,
  d: WorkerDialogT,
  cardId: string,
  patch: Record<string, unknown> = {},
) {
  const card = Card.parse({
    ...composeDialogCard({
      card_id: cardId,
      dialog: d,
      thread_id: 'general',
      thread_name: 'General',
      now: Date.parse('2026-10-28T16:00:00.000Z'),
    }),
    ...patch,
  })
  card.payload_hash = payloadHash(bindingFrom(card))
  await open(page, '/cards', { seed: 'full' })
  await page.evaluate((c) => {
    const t = (window as unknown as { __talos: { store: { setState: (f: (s: any) => any) => void } } }).__talos
    t.store.setState((s) => ({ ...s, cards: [...s.cards, c] }))
  }, card)
  const article = page.locator(`[data-card-id="${card.id}"]`)
  await article.scrollIntoViewIfNeeded()
  return { card, article }
}

for (const width of [375, 320]) {
  test(`waiting at ${width} px: the reset in words, two finger-wide buttons, nothing sideways, no terminal`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 })
    const { article } = await show(page, dialog(), 'c_01JBF3V7Q8K2M4N6P8R0S2T4G1')
    await expect(article.getByRole('heading', { name: "General's session hit its usage limit" })).toBeVisible()
    await expect(article.getByTestId('dialog-subject')).toHaveText(
      'Fable limit reached. It resets Aug 8, 4pm (Europe/Paris).',
    )
    const names = await article.getByTestId('dialog-buttons').getByRole('button').allTextContents()
    expect(names).toEqual(['Stop and wait', 'Switch model'])
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
      0,
    )
    for (const name of names) {
      const b = await article.getByRole('button', { name }).boundingBox()
      expect(b?.height ?? 0, `${name}: at least 44 px tall`).toBeGreaterThanOrEqual(44)
      expect((b?.x ?? -1) >= 0 && (b?.x ?? 0) + (b?.width ?? 999) <= width, `${name}: inside the card`).toBe(true)
    }
    expect(await article.textContent()).not.toMatch(/terminal|tmux|\bpane\b|\bEsc\b|\/model|credits|funds/i)
  })
}

test('by keyboard: Tab walks the two buttons, Enter sends its index and the card hash, and the card is clean for axe in both themes', async ({
  page,
  browserName,
}) => {
  const { card, article } = await show(page, dialog(), 'c_01JBF3V7Q8K2M4N6P8R0S2T4G2')
  const wait = article.getByRole('button', { name: 'Stop and wait' })
  const sw = article.getByRole('button', { name: 'Switch model' })
  await wait.focus()
  await expect(wait).toBeFocused()
  // WebKit on a Mac leaves buttons out of the Tab order unless Alt is held
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'
  await page.keyboard.press(tab)
  await expect(sw).toBeFocused()
  await expectAxeClean(page, [`[data-card-id="${card.id}"]`])
  await page.keyboard.press(browserName === 'webkit' ? 'Shift+Alt+Tab' : 'Shift+Tab')
  await expect(wait).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await sentFrames(page)).some((f) => f.type === 'card.resolve')).toBe(true)
  const f = (await sentFrames(page)).find((x) => x.type === 'card.resolve') as Record<string, unknown>
  expect(f).toMatchObject({ card_id: card.id, action: 'primary', choice: 0, payload_hash: card.payload_hash })
  expect('text' in f).toBe(false)
})

test('a screen with no reset time says so, and offers only Stop and wait', async ({ page }) => {
  const { article } = await show(
    page,
    dialog({ subject: "Usage limit reached. The screen doesn't say when it resets.", options: ['Stop and wait'] }),
    'c_01JBF3V7Q8K2M4N6P8R0S2T4G3',
  )
  await expect(article.getByTestId('dialog-subject')).toHaveText(
    "Usage limit reached. The screen doesn't say when it resets.",
  )
  expect(await article.getByTestId('dialog-buttons').getByRole('button').allTextContents()).toEqual(['Stop and wait'])
})

test('answered, nothing pressed and expired: each says what happened without a terminal, and stays clean for axe', async ({
  page,
}) => {
  const base = { at: '2026-10-28T16:01:00.000Z' }
  const answered = await show(page, dialog(), 'c_01JBF3V7Q8K2M4N6P8R0S2T4G4', {
    state: 'done',
    resolution: {
      action: 'primary',
      ...base,
      edited: false,
      payload_hash: `sha256:${'0'.repeat(64)}`,
      by: 'this phone',
    },
    result: { ok: true, text: 'Stopped. Send a message after the limit resets to go on.', ...base, ran: true },
  })
  await expect(answered.article).toHaveAttribute('data-card-state', 'answered')
  await expect(answered.article.getByTestId('dialog-result')).toHaveText(
    'Stopped. Send a message after the limit resets to go on.',
  )
  expect(await answered.article.getByTestId('dialog-meta').textContent()).not.toMatch(/starting/)
  await expectAxeClean(page, [`[data-card-id="${answered.card.id}"]`])

  const nothing = await show(page, dialog(), 'c_01JBF3V7Q8K2M4N6P8R0S2T4G5', {
    state: 'done',
    resolution: {
      action: 'primary',
      ...base,
      edited: false,
      payload_hash: `sha256:${'0'.repeat(64)}`,
      by: 'this phone',
    },
    result: {
      ok: false,
      text: "General's screen showed something different when Talos went to answer, so it left it alone.",
      ...base,
      ran: false,
    },
  })
  await expect(nothing.article).toHaveAttribute('data-card-state', 'nothing')
  expect(await nothing.article.textContent()).not.toMatch(/terminal/i)

  const expired = await show(page, dialog(), 'c_01JBF3V7Q8K2M4N6P8R0S2T4G6', { state: 'expired' })
  await expect(expired.article).toHaveAttribute('data-card-state', 'expired')
  await expect(expired.article.getByTestId('dialog-buttons')).toHaveCount(0)
  expect(await expired.article.textContent()).not.toMatch(/terminal/i)
})
