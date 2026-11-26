// Deny with a note (Wave 0, 0.8). A card raised for a PermissionRequest hook (`deny_note`) keeps its one-tap Deny and adds a small
// "Deny with a note" link; it opens a box, and Send deny signs the kill with the owner's words as `note`. A card without the flag
// (a channel-relay card, an older bridge) offers no note, because its verdict has no room for words.
import { composePermissionCard, PERMISSION_DENY_NOTE_MAX } from '@talos-app/protocol'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installAlwaysVisible } from '../helpers/intersection.ts'
import { LiveCard, renderWith, setup } from './helpers.tsx'

const make = (denyNote: boolean) =>
  composePermissionCard({
    request: {
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Upload the build',
      input_preview: '{"command": "aws s3 cp build s3://prod-bucket/"}',
    },
    card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4F0',
    thread_id: 'general',
    now: Date.parse('2026-10-28T15:00:00.000Z'),
    client_version: '2.1.312',
    ...(denyNote ? { deny_note: true } : {}),
  })

let restoreIO = () => {}
beforeEach(() => {
  restoreIO = installAlwaysVisible()
})
afterEach(() => restoreIO())

const link = () => screen.getByRole('button', { name: 'Deny with a note' })
const box = () => screen.getByLabelText('Note for Claude') as HTMLTextAreaElement
const resolves = (client: ReturnType<typeof setup>) => client.sent.filter((f) => f.type === 'card.resolve')

describe('a hook card (deny_note) offers a note', () => {
  it('plain Deny is still one tap and sends a kill with no note', async () => {
    const c = make(true)
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    expect(resolves(client)[0]).toMatchObject({ action: 'kill', card_id: c.id, payload_hash: c.payload_hash })
    expect('note' in (resolves(client)[0] as object)).toBe(false)
  })

  it('shows no box until the link is tapped; then a box with a counter, Send deny and Cancel', async () => {
    const c = make(true)
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.queryByLabelText('Note for Claude')).toBeNull()
    await userEvent.click(link())
    expect(screen.getByTestId('deny-note-count').textContent).toBe(`0/${PERMISSION_DENY_NOTE_MAX}`)
    expect(screen.getByRole('button', { name: 'Send deny' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Note for Claude')).toBeNull()
  })

  it('Send deny signs a kill carrying the typed words as `note`', async () => {
    const c = make(true)
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(link())
    await userEvent.type(box(), 'use the staging bucket instead')
    expect(screen.getByTestId('deny-note-count').textContent).toBe(`30/${PERMISSION_DENY_NOTE_MAX}`)
    await userEvent.click(screen.getByRole('button', { name: 'Send deny' }))
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    expect(resolves(client)[0]).toMatchObject({
      type: 'card.resolve',
      card_id: c.id,
      action: 'kill',
      payload_hash: c.payload_hash,
      note: 'use the staging bucket instead',
    })
  })

  it('a note of only spaces and line breaks sends a plain kill (nothing to say)', async () => {
    const c = make(true)
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(link())
    await userEvent.type(box(), '   {Enter}  ')
    await userEvent.click(screen.getByRole('button', { name: 'Send deny' }))
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    expect(resolves(client)[0]).toMatchObject({ action: 'kill' })
    expect('note' in (resolves(client)[0] as object)).toBe(false)
  })

  it('the box refuses more than the cap, and the sent note is the cleaned one', async () => {
    const c = make(true)
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(link())
    await userEvent.click(box())
    await userEvent.paste(`${'a'.repeat(PERMISSION_DENY_NOTE_MAX + 40)}`)
    expect(box().value.length).toBe(PERMISSION_DENY_NOTE_MAX)
    await userEvent.click(screen.getByRole('button', { name: 'Send deny' }))
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    expect((resolves(client)[0] as { note: string }).note).toBe('a'.repeat(PERMISSION_DENY_NOTE_MAX))
  })

  it('the cap counts characters, not UTF-16 units: 300 emoji fit, the 301st is refused', async () => {
    const c = make(true)
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(link())
    await userEvent.click(box())
    await userEvent.paste('\u{1F600}'.repeat(PERMISSION_DENY_NOTE_MAX + 20))
    expect([...box().value].length).toBe(PERMISSION_DENY_NOTE_MAX)
    expect(screen.getByTestId('deny-note-count').textContent).toBe(
      `${PERMISSION_DENY_NOTE_MAX}/${PERMISSION_DENY_NOTE_MAX}`,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Send deny' }))
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    expect([...(resolves(client)[0] as { note: string }).note].length).toBe(PERMISSION_DENY_NOTE_MAX)
  })

  it('the full-screen sheet offers it too', async () => {
    const c = make(true)
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(screen.getByTestId('permission-open'))
    const sheet = screen.getByTestId('approval-sheet')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Deny with a note' }))
    await userEvent.type(within(sheet).getByLabelText('Note for Claude'), 'not prod')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Send deny' }))
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    expect(resolves(client)[0]).toMatchObject({ action: 'kill', note: 'not prod' })
  })
})

describe('a card without the flag offers no note', () => {
  it('no link, no box: a channel-relay card or an older bridge', async () => {
    const c = make(false)
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    expect(screen.queryByRole('button', { name: 'Deny with a note' })).toBeNull()
    await userEvent.click(screen.getByTestId('permission-open'))
    expect(screen.queryByRole('button', { name: 'Deny with a note' })).toBeNull()
    expect(screen.queryByLabelText('Note for Claude')).toBeNull()
  })
})
