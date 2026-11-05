// A big chunk of text lands in the message box (dictation, a paste, or a tool writing the value): the box scrolls so the
// end of the text and the caret are in view. An edit in the middle must not move the view.
import { expect, type Locator, type Page, test } from '@playwright/test'

const long = (n: number, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n')

const atEnd = (box: Locator) =>
  box.evaluate((el: HTMLTextAreaElement) => ({
    gap: el.scrollHeight - el.clientHeight - el.scrollTop,
    over: el.scrollHeight > el.clientHeight,
    caretAtEnd: el.selectionStart === el.value.length && el.selectionEnd === el.value.length,
  }))

async function open(page: Page) {
  await page.goto('/t/general')
  const box = page.getByLabel('Message', { exact: true })
  await box.click()
  return box
}

test.describe('the message box follows big inserts', () => {
  test('a paste (real clipboard event) shows the end and the caret', async ({ page }) => {
    const box = await open(page)
    await box.evaluate((el: HTMLTextAreaElement, text) => {
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, long(60))
    await expect(box).toHaveValue(long(60))
    const s = await atEnd(box)
    expect(s.over).toBe(true)
    expect(s.gap).toBeLessThanOrEqual(1)
    expect(s.caretAtEnd).toBe(true)
  })

  test('dictation via setRangeText plus an input event', async ({ page }) => {
    const box = await open(page)
    await box.evaluate((el: HTMLTextAreaElement, text) => {
      el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end')
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }))
    }, long(60))
    const s = await atEnd(box)
    expect(s.over).toBe(true)
    expect(s.gap).toBeLessThanOrEqual(1)
  })

  test('a value set straight on the element with NO event at all', async ({ page }) => {
    const box = await open(page)
    await box.evaluate((el: HTMLTextAreaElement, text) => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      set?.call(el, text)
    }, long(60))
    await expect.poll(async () => (await atEnd(box)).gap, { timeout: 3000 }).toBeLessThanOrEqual(1)
    expect((await atEnd(box)).over).toBe(true)
    // and the app now holds it: Send appears
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  })

  test('select all and paste something SHORTER still ends at the caret', async ({ page }) => {
    const box = await open(page)
    await box.fill(long(100))
    await box.evaluate(
      (el: HTMLTextAreaElement, text) => {
        el.scrollTop = 0 // the owner had scrolled back up to reread before redrafting
        el.select()
        const dt = new DataTransfer()
        dt.setData('text/plain', text)
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      },
      long(60, 'redraft'),
    )
    await expect(box).toHaveValue(long(60, 'redraft'))
    const s = await atEnd(box)
    expect(s.caretAtEnd).toBe(true)
    expect(s.gap).toBeLessThanOrEqual(1)
  })

  test('typing at the end of a long message still shows the caret line', async ({ page }) => {
    const box = await open(page)
    await box.fill(long(40))
    await box.press('Control+End')
    await box.pressSequentially('!!')
    expect((await atEnd(box)).gap).toBeLessThanOrEqual(1)
  })
})

test.describe('editing in the middle does not jump the view', () => {
  async function seed(page: Page) {
    const box = await open(page)
    await box.fill(long(60))
    await box.evaluate((el: HTMLTextAreaElement) => {
      el.scrollTop = 0
      el.setSelectionRange(8, 8) // inside "line 2"
    })
    return box
  }

  test('typing a character keeps the scroll offset', async ({ page }) => {
    const box = await seed(page)
    await box.press('x')
    expect(await box.evaluate((el: HTMLTextAreaElement) => el.scrollTop)).toBe(0)
  })

  test('a big insert at the caret mid-text keeps the scroll offset', async ({ page }) => {
    const box = await seed(page)
    await box.evaluate(
      (el: HTMLTextAreaElement, text) => {
        el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end')
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }))
      },
      long(30, 'mid'),
    )
    expect(await box.evaluate((el: HTMLTextAreaElement) => el.scrollTop)).toBe(0)
  })

  test('a scrolled-away offset survives a keystroke too', async ({ page }) => {
    const box = await open(page)
    await box.fill(long(60))
    const mid = await box.evaluate((el: HTMLTextAreaElement) => {
      el.scrollTop = 120
      const at = el.value.indexOf('line 8') + 2 // a line that is on screen at this offset
      el.setSelectionRange(at, at)
      return el.scrollTop
    })
    expect(mid).toBeGreaterThan(0)
    await box.press('x')
    expect(await box.evaluate((el: HTMLTextAreaElement) => el.scrollTop)).toBe(mid)
  })
})
