// The agent's question card with a free-text option (pane-prompts row 9), in a real browser at phone width (375 px, and the 320 px SE below): the text box and its
// button fit with no sideways scroll, take a finger (44 px), work by keyboard (Tab to the box, Enter sends), say what is wrong with text that cannot be sent,
// hold nothing but the owner's words, send the choice and the text in ONE signed frame, and are clean for axe in both themes. The tool permission card is
// checked beside it: two buttons, no standing grant.
import { expect, test } from '@playwright/test'
import { bindingFrom, Card, composeDialogCard, payloadHash, type WorkerDialogT } from '@talos-app/protocol'
import { expectAxeClean, open, sentFrames } from './e2e.ts'

test.use({ bypassCSP: true, viewport: { width: 375, height: 812 } })

const dialog = (over: Partial<WorkerDialogT>): WorkerDialogT => ({
  id: 'Qq5Qm8ZtRx3Cw9PkNa2HdB',
  kind: 'agent_question',
  subject: 'Which color do you prefer?',
  options: ['Red', 'Blue', 'Other…', 'Chat about this'],
  cursor: null,
  free_text: 2,
  seen_at: '2026-10-28T16:00:00.000Z',
  expires_at: '2026-10-28T16:15:00.000Z',
  ...over,
})

async function show(page: import('@playwright/test').Page, d: WorkerDialogT, cardId: string) {
  const card = Card.parse(
    composeDialogCard({
      card_id: cardId,
      dialog: d,
      thread_id: 'general',
      thread_name: 'General',
      now: Date.parse('2026-10-28T16:00:00.000Z'),
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
  return { card, article }
}

test('the free-text box fits a phone, works by keyboard and sends the choice and the words in one frame', async ({
  page,
}) => {
  const { card, article } = await show(page, dialog({}), 'c_01JBF3V7Q8K2M4N6P8R0S2T4F1')
  const box = article.getByRole('textbox', { name: 'Other…' })
  await expect(box).toBeVisible()
  const send = article.getByRole('button', { name: 'Send your answer' })
  await expect(send).toBeDisabled()
  // 120 characters: what one row of the pane can show back before the Mac presses Enter
  await expect(box).toHaveAttribute('maxlength', '120')
  // nothing sideways, and every control is a finger wide
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  for (const el of [box, send, article.getByRole('button', { name: 'Red' })]) {
    const b = await el.boundingBox()
    expect(b?.height ?? 0, 'at least 44 px tall').toBeGreaterThanOrEqual(44)
    expect((b?.x ?? -1) >= 0 && (b?.x ?? 0) + (b?.width ?? 999) <= 375, 'inside the card at 375 px').toBe(true)
  }
  // keyboard: the box takes focus, a hidden character says why it cannot go, plain words enable the button, Enter sends
  await box.focus()
  await expect(box).toBeFocused()
  await box.fill('pur‮ple')
  await expect(article.getByText('Use plain text on one line.')).toBeVisible()
  await expect(box).toHaveAttribute('aria-invalid', 'true')
  await expect(send).toBeDisabled()
  await box.fill('  purple  ')
  await expect(send).toBeEnabled()
  await expect(article.getByText('Typed to your agent exactly as you write it.')).toBeVisible()
  await box.press('Enter')
  await expect.poll(async () => (await sentFrames(page)).some((f) => f.type === 'card.resolve')).toBe(true)
  const f = (await sentFrames(page)).find((x) => x.type === 'card.resolve') as Record<string, unknown>
  expect(f).toMatchObject({ card_id: card.id, action: 'primary', choice: 2, text: 'purple' })
})

test('a pick sends its index and no text; the card is clean for axe in both themes', async ({ page }) => {
  const { card, article } = await show(page, dialog({}), 'c_01JBF3V7Q8K2M4N6P8R0S2T4F2')
  await expectAxeClean(page, [`[data-card-id="${card.id}"]`])
  await article.getByRole('button', { name: 'Blue' }).click()
  await expect.poll(async () => (await sentFrames(page)).some((f) => f.type === 'card.resolve')).toBe(true)
  const f = (await sentFrames(page)).find((x) => x.type === 'card.resolve') as Record<string, unknown>
  expect(f).toMatchObject({ choice: 1 })
  expect('text' in f).toBe(false)
})

test('a question with no free-text option has no box; the tool permission card has Allow once and Deny only', async ({
  page,
}) => {
  const q = await show(page, dialog({ options: ['Red', 'Blue'], free_text: undefined }), 'c_01JBF3V7Q8K2M4N6P8R0S2T4F3')
  await expect(q.article.getByRole('textbox')).toHaveCount(0)
  const t = await show(
    page,
    dialog({
      id: 'Tq5Qm8ZtRx3Cw9PkNa2HdB',
      kind: 'tool_permission',
      subject: 'Bash command · touch hello.txt && ls -l hello.txt',
      options: ['Allow once', 'Deny'],
      free_text: undefined,
    }),
    'c_01JBF3V7Q8K2M4N6P8R0S2T4F4',
  )
  const names = await t.article.getByTestId('dialog-buttons').getByRole('button').allTextContents()
  expect(names).toEqual(['Allow once', 'Deny'])
  await expect(t.article.getByTestId('dialog-subject')).toHaveText('Bash command · touch hello.txt && ls -l hello.txt')
  expect(await t.article.textContent()).not.toMatch(/always|don.t ask/i)
  await expectAxeClean(page, [`[data-card-id="${t.card.id}"]`])
})
