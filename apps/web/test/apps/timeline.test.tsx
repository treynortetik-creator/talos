// @vitest-environment jsdom
// App rows in the timeline (MessageView): the card, the echo row, a broken row, an old peer's rows, and the preview
// that shares the extracted overlay.
import { newId, newUlid } from '@talos-app/protocol'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSlots } from '../../src/features/apps/liveSlots.ts'
import { AttachmentView } from '../../src/features/threads/Attachments.tsx'
import { MessageView } from '../../src/features/threads/MessageView.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { makeView, viewReply } from './helpers.ts'

beforeEach(() => resetSlots())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

type Msg = Parameters<typeof MessageView>[0]['message']
const show = (message: Msg, client = createFakeClient()) =>
  render(
    <ClientProvider client={client}>
      <MessageView message={message} cards={[]} inbox={[]} onOpenImage={() => {}} onOpenItem={() => {}} />
    </ClientProvider>,
  )
const base = {
  thread_id: 'general',
  format: 'plain' as const,
  attachments: [],
  via: 'app' as const,
  created_at: '2026-10-28T15:00:00.000Z',
}

describe('app rows', () => {
  it('a view row shows the agent caption (markdown) above the card', async () => {
    const view = makeView()
    const m = viewReply(view, { text: 'Here is **your note**.', format: 'markdown' }).message as unknown as Msg
    show(m)
    expect(await screen.findByTestId('app-view')).toBeTruthy()
    expect(document.querySelector('strong')?.textContent).toBe('your note')
    const row = screen.getByTestId('msg-app')
    expect(row.firstElementChild?.textContent).toContain('your note')
  })

  it('a row whose view did not parse says so instead of crashing', () => {
    const m = { ...base, id: newId('m'), author: 'app' as const, kind: 'app' as const, text: 'cap' } as Msg
    show(m)
    expect(screen.getByTestId('app-unreadable').textContent).toMatch(/can't be shown/)
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('the echo row is plain text with the label and the badge; markup stays text', async () => {
    const client = createFakeClient()
    const view = makeView({ label: 'Notes' })
    const row = viewReply(view).message as unknown as Msg
    client.store.setState((s) => ({ ...s, messages: { ...s.messages, general: [...(s.messages.general ?? []), row] } }))
    const echo = {
      ...base,
      id: newId('m'),
      author: 'app' as const,
      kind: 'text' as const,
      text: '**hi** <img src=x onerror=alert(1)>',
      app_view_id: view.view_id,
    } as Msg
    show(echo, client)
    const el = await screen.findByTestId('app-echo')
    expect(el.textContent).toContain('↳ Notes sent to Talos:')
    expect(el.textContent).toContain('**hi** <img src=x onerror=alert(1)>')
    expect(el.querySelector('img, strong, a')).toBeNull()
    expect(el.textContent).toContain('Third-party app')
  })

  it('an echo for a view we never saw still renders, with a generic name', async () => {
    const echo = {
      ...base,
      id: newId('m'),
      author: 'app' as const,
      kind: 'text' as const,
      text: 'hi',
      app_view_id: `av_${newUlid()}`,
    } as Msg
    show(echo)
    expect((await screen.findByTestId('app-echo')).textContent).toContain('An app sent to Talos')
  })

  it('an older peer: plain agent and owner rows render exactly as before, with no app markup', () => {
    show({ ...base, id: newId('m'), author: 'agent', kind: 'text', text: 'hello' } as Msg)
    expect(screen.getByText('hello')).toBeTruthy()
    expect(screen.getByTestId('msg-agent')).toBeTruthy()
    expect(document.querySelector('[data-testid^="app"]')).toBeNull()
    cleanup()
    show({ ...base, id: newId('m'), author: 'owner', kind: 'text', text: 'mine' } as Msg)
    expect(screen.getByTestId('msg-owner')).toBeTruthy()
  })
})

describe('previews still work on the extracted overlay', () => {
  const att = {
    media_id: newId('md'),
    kind: 'html' as const,
    role: 'attachment' as const,
    mime: 'text/html',
    name: 'report.html',
    size: 4,
    sha256: 'a'.repeat(64),
  }
  const msg = { ...base, id: newId('m'), author: 'agent' as const, kind: 'text' as const } as Msg
  // The page card probes the relay first (HEAD, so an expired page can be asked back from the Mac); here the relay has it.
  beforeEach(() =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    ),
  )

  it('same sandbox, /page, and "Open in new tab" in the overlay (previews keep theirs)', async () => {
    render(
      <ClientProvider client={createFakeClient()}>
        <AttachmentView att={att} message={msg} onOpenImage={() => {}} />
      </ClientProvider>,
    )
    const inline = await screen.findByTitle('report.html')
    expect(inline.getAttribute('sandbox')).toBe('allow-scripts')
    expect(inline.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(inline.getAttribute('src')).toBe(`/media/${att.media_id}/page?c=2`)
    expect(inline.getAttribute('loading')).toBe('lazy')
    await userEvent.click(screen.getByRole('button', { name: /expand report.html/i }))
    const full = screen.getByTitle('report.html (full screen)')
    expect(full.getAttribute('sandbox')).toBe('allow-scripts')
    expect(full.hasAttribute('allow')).toBe(false)
    const link = screen.getByRole('link', { name: /open in new tab/i })
    expect(link.getAttribute('href')).toBe(`/media/${att.media_id}/page?c=2`)
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.body.style.overflow).not.toBe('hidden')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /expand report.html/i })),
    )
  })

  it('Tab cycles inside the overlay bar', async () => {
    render(
      <ClientProvider client={createFakeClient()}>
        <AttachmentView att={att} message={msg} onOpenImage={() => {}} />
      </ClientProvider>,
    )
    await screen.findByTitle('report.html') // the page is probed first; Expand is live once it is there
    await userEvent.click(screen.getByRole('button', { name: /expand report.html/i }))
    const link = screen.getByRole('link', { name: /open in new tab/i })
    const close = screen.getByRole('button', { name: 'Close' })
    close.focus()
    await userEvent.tab()
    expect(document.activeElement).toBe(link)
    await userEvent.tab({ shift: true })
    expect(document.activeElement).toBe(close)
  })
})
