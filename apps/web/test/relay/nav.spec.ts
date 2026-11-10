import { loadExampleConfig } from '@talos-app/testkit'
import { expect, test } from '../helpers/fixtures.ts'
import { startHarness } from '../helpers/harness.ts'
import { isPhoneWidth, threadSwitcher } from '../helpers/phone.ts'
import { openSignedIn } from '../helpers/util.ts'

test('the thread tab bar (menu list on phones) switches threads', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context)
  const phone = isPhoneWidth(page)
  let tabs = await threadSwitcher(page)
  await expect(tabs.getByRole('link', { name: /General/ })).toHaveAttribute('aria-current', 'page')
  await tabs.getByRole('link', { name: /Inbox/ }).click()
  await expect(page).toHaveURL(/\/t\/inbox$/)
  if (phone) await expect(page.getByTestId('phone-menu')).toBeHidden() // choosing a thread closes the menu
  tabs = await threadSwitcher(page)
  await expect(tabs.getByRole('link', { name: /Inbox/ })).toHaveAttribute('aria-current', 'page')
  await tabs.getByRole('link', { name: /General/ }).click()
  await expect(page).toHaveURL(/\/t\/general$/)
})

test('Ctrl+2 switches to the second thread, in config order', async ({ browser }) => {
  const harness = await startHarness({ agentConfig: loadExampleConfig('five-threads') })
  const config = harness.relay.config.threads
  const context = await browser.newContext({ baseURL: harness.url })
  const page = await context.newPage()
  try {
    await openSignedIn(harness, page, context, `/t/${config[0]?.id}`)
    await page.keyboard.press('ControlOrMeta+2')
    await expect(page).toHaveURL(new RegExp(`/t/${config[1]?.id}$`))
    await page.keyboard.press('ControlOrMeta+1')
    await expect(page).toHaveURL(new RegExp(`/t/${config[0]?.id}$`))
  } finally {
    await context.close()
    await harness.stop()
  }
})

test('the phone bottom bar and the thread list route to threads', async ({ page, context, harness, isMobile }) => {
  await openSignedIn(harness, page, context, '/threads')
  await expect(page.getByTestId('thread-row-general')).toBeVisible()
  await page.getByTestId('thread-row-general').click()
  await expect(page).toHaveURL(/\/t\/general$/)
  if (isMobile) await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
})
