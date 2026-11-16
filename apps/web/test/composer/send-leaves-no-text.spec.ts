// Clicking Send while the box does not have focus (the owner clicked elsewhere, or came back from another window) must
// leave the box empty. Refocusing the box during the click fires its focus handler before React has drawn the cleared
// text; the handler used to read the old value back off the element, so the sent words returned as a draft.
import { expect, type Page, test } from '@playwright/test'

declare global {
  interface Window {
    __sent: string[]
  }
}

const box = (page: Page) => page.getByLabel('Message', { exact: true })
const send = (page: Page) => page.getByRole('button', { name: 'Send', exact: true })

/** Counts what reaches the client, and optionally refuses the first send (the real "nothing was queued" path). */
async function watchSends(page: Page, failFirst = false) {
  await page.evaluate((fail) => {
    const c = (window as unknown as { __talos: { sendMessage: (a: { text: string }) => Promise<unknown> } }).__talos
    const real = c.sendMessage.bind(c)
    window.__sent = []
    let refused = !fail
    c.sendMessage = async (a) => {
      window.__sent.push(a.text)
      if (!refused) {
        refused = true
        throw new Error('refused')
      }
      return real(a)
    }
  }, failFirst)
}

const storedDraft = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string | undefined>((resolve, reject) => {
        const open = indexedDB.open('talos-app')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const req = open.result.transaction('drafts').objectStore('drafts').get('general')
          req.onsuccess = () => resolve(req.result as string | undefined)
        }
      }),
  )

test.describe('sending with the box unfocused', () => {
  test.beforeEach(async ({ page }) => {
    // The 300 ms draft save runs on the page clock, so the test moves time instead of waiting for it.
    await page.clock.install()
    await page.goto('/t/general')
    await page.clock.runFor(50)
    // the tests wrap window.__talos.sendMessage: wait for the app to set it (a loaded machine is still booting), moving the
    // page clock as they do, so a boot step on a timer is not held up
    await expect
      .poll(async () => {
        await page.clock.runFor(50)
        return page.evaluate(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
      })
      .toBe(true)
  })

  for (const focused of [false, true]) {
    test(`Send with the box ${focused ? 'focused' : 'blurred'} clears the box and the saved draft, sends once, and keeps focus where the device allows`, async ({
      page,
    }) => {
      await watchSends(page)
      await box(page).click()
      await box(page).pressSequentially('hello there')
      if (!focused) {
        await box(page).evaluate((el) => (el as HTMLTextAreaElement).blur())
        expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA')
      }
      await send(page).click()
      await expect(box(page)).toHaveValue('')
      await page.clock.runFor(1000) // past the draft save
      await expect(box(page)).toHaveValue('')
      await expect.poll(() => storedDraft(page)).toBeUndefined()
      expect(await page.evaluate(() => window.__sent)).toEqual(['hello there'])
      const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)
      // Phones drop the keyboard after Send (FOLLOW_NEW_TEXT, 4fa88fa), so the box ends unfocused there whether or not it
      // had focus; everywhere else the box keeps focus or takes it back.
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Message')).toBe(!coarse)
    })
  }

  test('a failed send still hands the words back', async ({ page }) => {
    await watchSends(page, true)
    await box(page).click()
    await box(page).pressSequentially('keep me')
    await box(page).evaluate((el) => (el as HTMLTextAreaElement).blur())
    await send(page).click()
    await expect(page.getByText("Couldn't send. Your message is still here.")).toBeVisible()
    await expect(box(page)).toHaveValue('keep me')
    await send(page).click()
    await expect(box(page)).toHaveValue('')
    expect(await page.evaluate(() => window.__sent)).toEqual(['keep me', 'keep me'])
  })

  test('text written straight on the element while unfocused is still picked up and sent', async ({ page }) => {
    await watchSends(page)
    await box(page).evaluate((el: HTMLTextAreaElement) => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      set?.call(el, 'from a tool')
    })
    await box(page).focus() // the focus handler is what notices a value React did not draw
    await send(page).click()
    await expect(box(page)).toHaveValue('')
    expect(await page.evaluate(() => window.__sent)).toEqual(['from a tool'])
  })
})
