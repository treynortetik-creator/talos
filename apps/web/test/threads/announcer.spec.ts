import { expect, type Page, test } from '@playwright/test'
import { bindingFrom, Card, type CardT, payloadHash } from '@talos-app/protocol'

// 0.16 in a real browser (fake mode, VITE_FAKE=1): each event writes the one announcer exactly once, in the words of
// announceText.ts, and the app has one announcer however many events there are. The clipboard is a stub (never the real one).
test.use({ serviceWorkers: 'block', bypassCSP: true })

type FakeApp = {
  store: {
    getState(): { threads: Array<{ id: string; name: string }>; cards: unknown[]; messages: Record<string, unknown[]> }
    setState(s: unknown): void
  }
  emit(type: string, fields: unknown): void
  session: { patch(p: Record<string, unknown>): void }
}
type Said = { mode: string | null; text: string }
type W = { __said: Said[]; __talos: Record<string, unknown> & FakeApp }

const card = (() => {
  const c = Card.parse({
    id: 'c_01JBF3V7Q8K2M4N6P8R0S97101',
    thread_id: 'general',
    kind: 'deploy',
    title: 'Deploy the site to staging',
    destination: [{ label: 'To', value: 'staging' }],
    body: 'Runs the staging deploy for the docs site.',
    body_format: 'plain',
    fields: [],
    attachments: [],
    primary_label: 'Deploy',
    kill_label: 'Deny',
    allow_edit: false,
    allow_revise: true,
    risk: 'low',
    origin: 'chat',
    payload_hash: `sha256:${'0'.repeat(64)}`,
    state: 'pending',
    created_at: '2026-10-28T15:59:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
  }) as CardT
  c.payload_hash = payloadHash(bindingFrom(c))
  return c
})()

/** Records every non-empty text the announcer's regions hold after a change, once per region per batch of changes. */
async function recordAnnouncer(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as W
    w.__said = []
    new MutationObserver((records) => {
      const touched = new Set<Element>()
      for (const r of records) {
        const el = r.target.nodeType === 3 ? r.target.parentElement : (r.target as Element)
        const region = el?.closest('#talos-announcer [aria-live]')
        if (region) touched.add(region)
      }
      for (const region of touched) {
        const text = region.textContent?.trim()
        if (text) w.__said.push({ mode: region.getAttribute('aria-live'), text })
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
}
const said = (page: Page) => page.evaluate(() => (window as unknown as W).__said)
const announcers = (page: Page) => page.locator('#talos-announcer').count()

async function open(page: Page, path = '/t/general') {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } })
  })
  await page.goto(path)
  await page.waitForFunction(() => Boolean((window as unknown as W).__talos))
  if (path.startsWith('/t/')) await expect(page.getByTestId('composer')).toBeVisible()
  await recordAnnouncer(page)
}

test('Copy on a code block writes the region once', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const st = (window as unknown as W).__talos.store
    const msg = {
      id: 'm_01JBF3V7Q8K2M4N6P8R0S1TA16',
      thread_id: 'general',
      author: 'agent',
      kind: 'text',
      text: 'Run:\n\n```sh\necho hi\n```',
      format: 'markdown',
      attachments: [],
      via: 'app',
      created_at: '2026-10-28T15:00:00.000Z',
    }
    st.setState({ ...st.getState(), messages: { ...st.getState().messages, general: [msg] } })
  })
  await page.getByRole('button', { name: 'Copy code' }).click()
  await expect.poll(() => said(page)).toEqual([{ mode: 'polite', text: 'Copied' }])
  await page.waitForTimeout(600) // timing-ok: proves nothing more is written after the one write
  expect(await said(page)).toHaveLength(1)
  expect(await announcers(page)).toBe(1)
})

test('Sending writes the region once', async ({ page }) => {
  await open(page)
  await page.getByRole('textbox', { name: 'Message' }).fill('hello there')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect.poll(async () => (await said(page)).length).toBe(1)
  const [one] = await said(page)
  expect(['Sent', "Saved. It sends when you're back online."]).toContain(one?.text)
  await page.waitForTimeout(600) // timing-ok: proves nothing more is written after the one write
  expect(await said(page)).toHaveLength(1)
  expect(await announcers(page)).toBe(1)
})

test('Answering a card writes the region once, with the label of the button pressed', async ({ page }) => {
  await open(page, '/threads')
  await page.evaluate((c) => {
    const st = (window as unknown as W).__talos.store
    st.setState({ ...st.getState(), cards: [...st.getState().cards, c] })
    window.history.pushState({}, '', `/card/${c.id}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, card)
  const face = page.locator(`[data-card-id="${card.id}"]`)
  await face.getByRole('button', { name: 'Deploy', exact: true }).click()
  await expect.poll(() => said(page)).toEqual([{ mode: 'polite', text: 'Answered: Deploy' }])
  await page.waitForTimeout(600) // timing-ok: proves nothing more is written after the one write
  expect(await said(page)).toHaveLength(1)
  expect(await announcers(page)).toBe(1)
})

test('Stop and then Undo each write the region once, and the strip has no live role of its own', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const t = (window as unknown as W).__talos
    const st = t.store
    const now = Date.now()
    const rows = [
      ['agent', 'on it'],
      ['owner', 'please do it'],
    ].map(([author, text], i) => ({
      id: `m_stop_${i}`,
      thread_id: 'general',
      author,
      kind: 'text',
      text,
      format: 'plain',
      attachments: [],
      via: 'app',
      seq: 2000 + i,
      created_at: new Date(now - (2 - i) * 1000).toISOString(),
    }))
    st.setState({
      ...st.getState(),
      messages: { ...st.getState().messages, general: rows },
      statuses: { general: { thread_id: 'general', state: 'working', since: new Date().toISOString() } },
    })
    t.session.patch({ busy: true, turn_id: 'turn_7' })
  })
  await page.getByRole('button', { name: 'Stop your agent', exact: true }).click()
  const strip = page.getByTestId('stopped-strip')
  await expect(strip).toBeVisible()
  expect(await strip.getAttribute('role')).toBeNull()
  await expect.poll(() => said(page)).toEqual([{ mode: 'polite', text: 'Stopped Talos. Undo is available' }])
  await strip.getByRole('button', { name: 'Undo' }).click()
  await expect
    .poll(async () => (await said(page)).map((s) => s.text))
    .toEqual(['Stopped Talos. Undo is available', 'Message sent again'])
  await page.waitForTimeout(600) // timing-ok: proves nothing more is written after the writes
  expect(await said(page)).toHaveLength(2)
  expect(await announcers(page)).toBe(1)
})

test('A card for a thread that is not on screen writes the region once', async ({ page }) => {
  await open(page)
  const other = await page.evaluate(() => {
    const t = (window as unknown as W).__talos
    const threads = t.store.getState().threads as Array<{ id: string; name: string }>
    return threads.find((x) => x.id !== 'general') ?? null
  })
  expect(other).not.toBeNull()
  await page.evaluate(
    ([c, id]) => {
      const t = (window as unknown as W).__talos
      t.emit('card.create', { card: { ...(c as object), thread_id: id } })
    },
    [card, other?.id] as const,
  )
  await expect.poll(() => said(page)).toEqual([{ mode: 'polite', text: `${other?.name} needs you` }])
  await page.waitForTimeout(600) // timing-ok: proves nothing more is written after the one write
  expect(await said(page)).toHaveLength(1)
  expect(await announcers(page)).toBe(1)
})

test('a card for the thread on screen writes nothing', async ({ page }) => {
  await open(page)
  await page.evaluate((c) => (window as unknown as W).__talos.emit('card.create', { card: c }), card)
  await page.waitForTimeout(600) // timing-ok: proves nothing is written
  expect(await said(page)).toEqual([])
})
