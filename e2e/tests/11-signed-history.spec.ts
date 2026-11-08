import type { Page } from '@playwright/test'
import { expect, rawSocket, sendText, sentFrames, signedIn, test } from '../harness/fixtures.ts'

/** The owner's way to search now: the magnifier in the sidebar's thread list turns into a box and the results replace the threads. */
async function searchInSidebar(page: Page, text: string) {
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
  await sidebar.getByRole('button', { name: 'Search threads' }).click()
  await sidebar.getByRole('searchbox', { name: 'Search all threads' }).fill(text)
  await expect(sidebar.getByTestId('hit-row').first()).toBeVisible()
}

// Signed history reads (docs/PROTOCOL.md): the real relay, the real bridge and the real app. Search "jump to hit" and the
// context view page by message id, which only the Mac answers; the app signs those requests, and the same bytes sent again
// by someone who captured them are refused.
test('11. search jump-to-hit and context paging work with signed reads; a captured request cannot be replayed', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  await sendText(page, 'zebra needle first')
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'ack: zebra needle first' })).toBeVisible()

  // The way in is the magnifier in the thread list: type there, then "See all results" opens the full search page.
  await searchInSidebar(page, 'zebra')
  await page.getByRole('link', { name: 'See all results' }).click()
  await expect(page).toHaveURL(/\/search\?q=zebra$/)
  await page.getByRole('searchbox', { name: 'Search messages' }).fill('zebra')
  await page.getByTestId('hit-row').first().click()
  await expect(page.getByTestId('context-view')).toBeVisible()
  await expect(page.getByTestId('context-list').getByText('zebra needle first').first()).toBeVisible()

  const asked = sentFrames(page, 'history.request')
  expect(asked.length).toBeGreaterThan(0)
  for (const f of asked) {
    expect(typeof f.json.osig).toBe('string')
    expect(typeof f.json.device_id).toBe('string')
  }

  // Someone who captured those bytes sends them again on a new socket: no page comes back, only an error.
  const first = asked[0]
  if (!first) throw new Error('no history.request captured')
  const hello = sentFrames(page, 'hello')[0]
  if (!hello) throw new Error('no hello captured')
  const back = await rawSocket(page, [hello.text, first.text])
  // On a failing run the report carries what came back on the replay socket: one line, types, refs and counts, never text.
  await test.info().attach('replay-back', {
    contentType: 'text/plain',
    body: `replayed ${String(first.json.type)} ${String(first.json.id)} [${Object.keys(first.json).sort().join(',')}] -> ${back
      .map((f) =>
        [f.type, f.ref ?? f.request_id ?? '', f.code ?? '', Array.isArray(f.messages) ? `${f.messages.length}msgs` : '']
          .filter(Boolean)
          .join(':'),
      )
      .join(' | ')}`,
  })
  expect(back.some((f) => f.type === 'history.page')).toBe(false)
  expect(back.some((f) => f.type === 'error' && f.ref === first.json.id)).toBe(true)
  expect(stack.bridgeLog()).not.toContain('zebra needle first')
})

// The same signed read through the results shown in place in the thread list: a result opens its message in context.
test('11b. a search result in the thread list opens its message in context with signed reads', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  await sendText(page, 'quokka needle second')
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'ack: quokka needle second' })).toBeVisible()

  await searchInSidebar(page, 'quokka')
  await page.getByRole('complementary', { name: 'Sidebar' }).getByTestId('hit-row').first().click()
  await expect(page.getByTestId('context-view')).toBeVisible()
  await expect(page.getByTestId('context-list').getByText('quokka needle second').first()).toBeVisible()
  const asked = sentFrames(page, 'history.request')
  expect(asked.length).toBeGreaterThan(0)
  for (const f of asked) expect(typeof f.json.osig).toBe('string')
})
