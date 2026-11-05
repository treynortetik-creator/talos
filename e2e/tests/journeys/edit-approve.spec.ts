// Journey: the owner edits a draft on the card and approves it; what the agent is told to run is the edit, never the original.
import { readFileSync } from 'node:fs'
import { card, cardIdFrom, expect, signedIn, test } from '../../harness/fixtures.ts'

const ORIGINAL_BODY = 'Hi Sam, the invoice is attached. Regards, Talos.'
const EDITED_BODY = 'Hi Sam, the invoice is attached, due Friday. Regards, Alex.'
const ORIGINAL_SUBJECT = 'Invoice 114'
const EDITED_SUBJECT = 'Invoice 114 (due Friday)'

const DRAFT = {
  thread_id: 'general',
  kind: 'message',
  title: 'Send the invoice note to Sam',
  primary_label: 'Send',
  kill_label: 'Kill the note',
  risk: 'low',
  origin: 'chat',
  destination: [{ label: 'To', value: 'sam@example.com' }],
  fields: [{ key: 'subject', label: 'Subject', value: ORIGINAL_SUBJECT, editable: true }],
  body: ORIGINAL_BODY,
  allow_edit: true,
} as const

test('edit-approve: the agent is handed the edited subject and body, and the original is nowhere in what it must run', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const id = cardIdFrom(await stack.claude.callTool('card', { ...DRAFT }))
  const article = card(page, id)

  await test.step('edit the subject and the body on the card', async () => {
    await article.getByRole('button', { name: 'Edit', exact: true }).click()
    await article.getByLabel('Subject').fill(EDITED_SUBJECT)
    await article.getByLabel('Message body').fill(EDITED_BODY)
    await expect(article.getByRole('button', { name: 'Send edited' })).toBeVisible()
  })

  await test.step('approve the edited card', async () => {
    await article.getByRole('button', { name: 'Send edited' }).click()
  })

  await test.step('the agent is told PRIMARY, edited, and the approved file holds only the edit', async () => {
    const act = await stack.claude.waitForNotification((n) => n.meta.kind === 'card_action' && n.meta.card_id === id)
    expect(act.meta).toMatchObject({ card_action: 'primary', card_edited: 'true' })
    expect(act.content).toContain('Edited: yes')
    const path = act.meta.payload_path
    expect(path).toBeTruthy()
    const approved = readFileSync(path as string, 'utf8')
    expect(approved).toContain(EDITED_BODY)
    expect(approved).toContain(EDITED_SUBJECT)
    expect(approved).not.toContain(ORIGINAL_BODY)
    expect(approved).not.toContain(`"${ORIGINAL_SUBJECT}"`)
    await expect(article.getByTestId('collapse-line')).toHaveText(/^✓ Sent/, { timeout: 15_000 })
  })
})

test('edit-approve (control): approving the same draft untouched hands the agent the original', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const id = cardIdFrom(await stack.claude.callTool('card', { ...DRAFT }))
  await card(page, id).getByRole('button', { name: 'Send', exact: true }).click()
  const act = await stack.claude.waitForNotification((n) => n.meta.kind === 'card_action' && n.meta.card_id === id)
  expect(act.meta.card_edited).toBe('false')
  const approved = readFileSync(act.meta.payload_path as string, 'utf8')
  expect(approved).toContain(ORIGINAL_BODY)
  expect(approved).not.toContain(EDITED_BODY)
})
