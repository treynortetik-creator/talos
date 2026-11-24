// One tap (owner, 2026-11-21): "If I click Approve, it's approved ... and then always have the Always allow button on there too."
// In the REAL app, a permission card and a deploy card in the thread show Deny / Always allow / Approve on their faces. A permission
// card has no Always allow (a rule for it waits for Claude Code to suggest one). Approve is one tap and sends the signed resolve
// with the card's hash; no sheet opens. Screenshots (light) land in test-results/shots/one-tap/.
import { mkdirSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { bindingFrom, Card, type CardT, composePermissionCard, payloadHash } from '@talos-app/protocol'

test.use({ bypassCSP: true })

const NOW = '2026-10-28T16:00:00.000Z'
const permission = composePermissionCard({
  request: {
    request_id: 'bcdfg',
    tool_name: 'Bash',
    description: 'Run the test suite',
    input_preview: '{"command": "pnpm test"}',
  },
  card_id: 'c_01JBF3V7Q8K2M4N6P8R0S97001',
  thread_id: 'general',
  now: Date.parse('2026-10-28T15:59:30.000Z'),
  client_version: '2.1.312',
})
const deploy = (() => {
  const c = Card.parse({
    id: 'c_01JBF3V7Q8K2M4N6P8R0S97002',
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
    expires_at: '2026-10-28T17:00:00.000Z',
  }) as CardT
  c.payload_hash = payloadHash(bindingFrom(c))
  return c
})()

async function openCard(page: Page, card: CardT) {
  await page.clock.install({ time: new Date(NOW) })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/threads')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate((c) => {
    const w = window as unknown as { __talos: { store: { getState: () => any; setState: (s: any) => void } } }
    const s = w.__talos.store.getState()
    w.__talos.store.setState({
      ...s,
      presence: { ...s.presence, features: [...(s.presence.features ?? []), 'always-allow/1', 'always-allow/2'] },
      cards: [...s.cards, c],
    })
    window.history.pushState({}, '', `/card/${c.id}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, card)
  const face = page.locator(`[data-card-id="${card.id}"]`)
  await expect(face).toBeVisible()
  return face
}
const frames = (page: Page) =>
  page.evaluate(() => (window as unknown as { __talos: { sent: Array<Record<string, unknown>> } }).__talos.sent)
const shot = async (face: ReturnType<Page['locator']>, name: string, project: string) => {
  mkdirSync('test-results/shots/one-tap', { recursive: true })
  await face.screenshot({ path: `test-results/shots/one-tap/${name}-${project}.png` })
}

test('a permission card: Deny, Details and Allow on its face, no Always allow, and Allow is one tap', async ({
  page,
}, info) => {
  const face = await openCard(page, permission)
  await expect(page.getByTestId('approval-sheet')).toHaveCount(0) // a push or /card/:id does not force the sheet
  await expect(face.getByRole('button', { name: 'Deny' })).toBeVisible()
  await expect(face.getByRole('button', { name: 'Details' })).toBeVisible()
  await expect(face.getByRole('button', { name: /^Always allow/ })).toHaveCount(0)
  if (info.project.name !== 'pixel') await shot(face, 'permission', info.project.name)
  await face.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect.poll(async () => (await frames(page)).some((f) => f.type === 'card.resolve')).toBe(true)
  const last = (await frames(page)).at(-1)
  expect(last).toMatchObject({
    type: 'card.resolve',
    action: 'primary',
    card_id: permission.id,
    payload_hash: permission.payload_hash,
  })
  expect(last).not.toHaveProperty('always')
  await expect(page.getByTestId('approval-sheet')).toHaveCount(0)
})

test('Details opens the whole call with Allow enabled at once', async ({ page }) => {
  const face = await openCard(page, permission)
  await face.getByRole('button', { name: 'Details' }).click()
  const sheet = page.getByTestId('approval-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('button', { name: /^Allow/ })).toBeEnabled()
})

test('a deploy card: Deny, Always allow and Deploy on its face; Always allow sends always: true', async ({
  page,
}, info) => {
  const face = await openCard(page, deploy)
  await expect(face.getByRole('button', { name: 'Deny' })).toBeVisible()
  await expect(face.getByRole('button', { name: 'Deploy', exact: true })).toBeVisible()
  if (info.project.name !== 'pixel') await shot(face, 'deploy', info.project.name)
  await face.getByRole('button', { name: 'Always allow deploys' }).click()
  await expect.poll(async () => (await frames(page)).some((f) => f.type === 'card.resolve')).toBe(true)
  expect((await frames(page)).at(-1)).toMatchObject({
    type: 'card.resolve',
    action: 'primary',
    always: true,
    card_id: deploy.id,
    payload_hash: deploy.payload_hash,
  })
})

test('a deploy card: the plain Deploy tap is one tap with no always', async ({ page }) => {
  const face = await openCard(page, deploy)
  await face.getByRole('button', { name: 'Deploy', exact: true }).click()
  await expect.poll(async () => (await frames(page)).some((f) => f.type === 'card.resolve')).toBe(true)
  const last = (await frames(page)).at(-1)
  expect(last).toMatchObject({ action: 'primary', card_id: deploy.id })
  expect(last).not.toHaveProperty('always')
})
