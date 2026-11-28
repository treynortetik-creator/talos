// 0.16: each place that says something to a screen reader through the one announcer, in the real component. Each test asserts the
// words (pinned in announceText.ts) and that nothing else spoke: a visible live line of its own is never said twice.
import { composePermissionCard } from '@talos-app/protocol'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAnnounceNeedsYou } from '../../src/features/cards/useAnnounceNeedsYou.ts'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
import { clearUndo, offerUndo, UndoStrip } from '../../src/features/inbox/undo.tsx'
import { Markdown } from '../../src/features/threads/Markdown.tsx'
import { resetAnnouncerForTests } from '../../src/lib/announce.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { LiveCard, makeCard, makeItem, renderWith, setup } from '../cards/helpers.tsx'
import { installAlwaysVisible } from '../helpers/intersection.ts'

const said = (mode: 'polite' | 'assertive' = 'polite') =>
  Array.from(document.querySelectorAll(`#talos-announcer [aria-live="${mode}"]`), (r) => r.textContent).filter(Boolean)

// The announcer waits 250 ms for focus to settle before it speaks; a negative test moves the fake clock past that and then looks.
const settle = () =>
  act(async () => {
    vi.advanceTimersByTime(400)
  })

beforeEach(() => useComposerStore.setState({ chips: {}, replyTo: {}, prefill: {}, dropped: {} }))
afterEach(() => {
  vi.useRealTimers()
  cleanup()
  clearUndo()
  resetAnnouncerForTests()
  vi.unstubAllGlobals()
})

describe('Copy on a code block', () => {
  const code = '```sh\necho hi\n```'
  it('says Copied, politely', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } })
    render(<Markdown text={code} />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(said()).toEqual(['Copied']))
    expect(said('assertive')).toEqual([])
  })
  it("says Couldn't copy at once, assertively, when the clipboard refuses", async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied')
        }),
      },
    })
    render(<Markdown text={code} />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(said('assertive')).toEqual(["Couldn't copy"]))
    expect(said()).toEqual([])
  })
})

describe('Sending from the box', () => {
  const mount = (client: ReturnType<typeof createFakeClient>) =>
    render(
      <ClientProvider client={client}>
        <Composer threadId="general" />
      </ClientProvider>,
    )
  const sendWords = async () => {
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'hello there')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
  }
  it('says Sent when the message went', async () => {
    const client = createFakeClient()
    vi.spyOn(client, 'sendMessage').mockResolvedValue({ clientMsgId: 'm_1', state: 'sent' })
    mount(client)
    await sendWords()
    await waitFor(() => expect(said()).toEqual(['Sent']))
  })
  it('says it was saved when the message only joined the outbox (offline), and not Sent', async () => {
    const client = createFakeClient()
    vi.spyOn(client, 'sendMessage').mockResolvedValue({ clientMsgId: 'm_1', state: 'queued' })
    mount(client)
    await sendWords()
    await waitFor(() => expect(said()).toEqual(["Saved. It sends when you're back online."]))
  })
  it('says it was saved until this device is approved when the send is held for approval, and not the offline line', async () => {
    const client = createFakeClient()
    vi.spyOn(client, 'sendMessage').mockResolvedValue({ clientMsgId: 'm_1', state: 'held_unpinned' })
    mount(client)
    await sendWords()
    await waitFor(() => expect(said()).toEqual(['Saved. It sends once this device is approved.']))
  })
  it("says nothing of its own when the send fails: the box's alert line is the one voice", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const client = createFakeClient()
    vi.spyOn(client, 'sendMessage').mockRejectedValue(new Error('down'))
    mount(client)
    await sendWords()
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't send. Your message is still here.")
    await settle()
    expect(said()).toEqual([])
    expect(said('assertive')).toEqual([])
  })
})

describe('Answering a card', () => {
  it('says Answered and the label of the pressed button, once', async () => {
    const card = makeCard({ primary_label: 'Send it', kill_label: 'Drop it' })
    const client = setup({ cards: [card] })
    renderWith(<LiveCard id={card.id} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Send it' }))
    await waitFor(() => expect(said()).toEqual(['Answered: Send it']))
  })
  it('says the words of "Allow for this session" when that is the button pressed, not plain Allow', async () => {
    const restoreIO = installAlwaysVisible()
    try {
      const card = composePermissionCard({
        request: {
          request_id: 'abcde',
          tool_name: 'Bash',
          description: 'Make a probe file',
          input_preview: '{"command": "touch probe-1"}',
        },
        card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4F1',
        thread_id: 'general',
        now: Date.parse('2026-10-28T15:00:00.000Z'),
        client_version: '2.1.312',
        deny_note: true,
        session_allow: { rules: [{ tool: 'Bash', content: 'touch probe-*' }] },
      })
      const client = setup({ cards: [card] })
      renderWith(<LiveCard id={card.id} />, client)
      await userEvent.click(await screen.findByRole('button', { name: /for the rest of this session/ }))
      await waitFor(() => expect(said()).toEqual(['Answered: Allow `touch probe-*` for the rest of this session']))
    } finally {
      restoreIO()
    }
  })
  it('echoes the other button too', async () => {
    const card = makeCard({ primary_label: 'Send it', kill_label: 'Drop it' })
    const client = setup({ cards: [card] })
    renderWith(<LiveCard id={card.id} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Drop it' }))
    await waitFor(() => expect(said()).toEqual(['Answered: Drop it']))
  })
  it('says Revision sent after a revise', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    renderWith(<LiveCard id={card.id} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'More' }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Tell Talos what to change/ }))
    await userEvent.type(screen.getByRole('textbox', { name: /What should Talos change/ }), 'shorter please')
    await userEvent.click(screen.getByRole('button', { name: 'Send note' }))
    await waitFor(() => expect(said()).toEqual(['Revision sent']))
  })
  it('says nothing when the answer fails: the card keeps its own alert', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const card = makeCard({ primary_label: 'Send it' })
    const client = setup({ cards: [card] })
    vi.spyOn(client, 'resolveCard').mockRejectedValue(new Error('no'))
    renderWith(<LiveCard id={card.id} />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Send it' }))
    await screen.findByRole('alert')
    await settle()
    expect(said()).toEqual([])
  })
})

describe('Done and Snooze offer Undo', () => {
  it('says so through the announcer; the strip has no live role; Undo cancels what was said', async () => {
    const client = setup({ inbox: [] })
    renderWith(<UndoStrip />, client)
    act(() => offerUndo(makeItem({ title: 'Pay the bill' }), 'done'))
    expect(screen.getByTestId('inbox-undo').getAttribute('role')).toBeNull()
    await waitFor(() => expect(said()).toEqual(['Marked done. Undo is available']))
    act(() => clearUndo())
    expect(said()).toEqual([])
  })
  it('says Snoozed for a snooze', async () => {
    act(() => offerUndo(makeItem(), 'snoozed'))
    await waitFor(() => expect(said()).toEqual(['Snoozed. Undo is available']))
  })
})

function Probe({ viewing }: { viewing: string | null }) {
  useAnnounceNeedsYou(viewing)
  return null
}

describe('Another thread needs you', () => {
  const mount = (viewing: string | null) => {
    const client = createFakeClient()
    client.store.setState((s) => ({
      ...s,
      threads: [
        { id: 'general', name: 'General' },
        { id: 'errands', name: 'Errands' },
        { id: 'taxes', name: 'Taxes' },
      ] as never,
    }))
    render(
      <ClientProvider client={client}>
        <MemoryRouter>
          <Probe viewing={viewing} />
        </MemoryRouter>
      </ClientProvider>,
    )
    return client
  }
  it('says "<thread> needs you" for a card on a thread that is not on screen', async () => {
    const client = mount('general')
    act(() => client.emit('card.create', { card: makeCard({ thread_id: 'errands' }) }))
    await waitFor(() => expect(said()).toEqual(['Errands needs you']))
  })
  it('says nothing for a card on the thread on screen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const client = mount('errands')
    act(() => client.emit('card.create', { card: makeCard({ thread_id: 'errands' }) }))
    await settle()
    expect(said()).toEqual([])
  })
  it('says nothing for a card replayed on reconnect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const client = mount(null)
    let listener: ((f: { card: ReturnType<typeof makeCard> }, meta?: { catchup?: boolean }) => void) | undefined
    vi.spyOn(client, 'onFrame').mockImplementation(((type: string, l: typeof listener) => {
      if (type === 'card.create') listener = l
      return () => {}
    }) as never)
    cleanup()
    render(
      <ClientProvider client={client}>
        <MemoryRouter>
          <Probe viewing={null} />
        </MemoryRouter>
      </ClientProvider>,
    )
    act(() => listener?.({ card: makeCard({ thread_id: 'errands' }) }, { catchup: true }))
    expect(listener).toBeDefined()
    await settle()
    expect(said()).toEqual([])
    act(() => listener?.({ card: makeCard({ thread_id: 'errands' }) }))
    await waitFor(() => expect(said()).toEqual(['Errands needs you']))
  })
  it('makes one sentence with a count for a burst', async () => {
    const client = mount(null)
    act(() => {
      client.emit('card.create', { card: makeCard({ thread_id: 'errands' }) })
      client.emit('card.create', { card: makeCard({ thread_id: 'taxes' }) })
    })
    await waitFor(() => expect(said()).toEqual(['2 threads need you']))
  })
})
