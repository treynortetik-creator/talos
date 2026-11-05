// @vitest-environment jsdom
// The Run button under a shell code block in an agent message. A tap sends the owner's own signed message (the script in one
// fence, `intent: 'run'`). These tests hold: which blocks get a button, what is sent, one message per tap, the one-tap rule on
// the bytes (plain ASCII, at most 6 lines and 300 characters) and the second confirm for everything else. One block, one Run
// is the Mac's rule (run-intent.test.ts): here a tap names its block (message id and place), the screen shows what its own tap
// did and no Run after it, and a reload shows Run again. A thread with its own session shows no button.
import type { MessageT } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageView } from '../../src/features/threads/MessageView.tsx'
import { ClientProvider, type TalosClient } from '../../src/lib/client.ts'
import { createMetaStore, MetaProvider } from '../../src/lib/connectionMeta.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

// A test can ask the renderer to draw something other than the source says.
const draw = vi.hoisted(() => ({ swap: null as null | [string, string] }))
vi.mock('../../src/lib/markdown.ts', async (orig) => {
  const real = await orig<typeof import('../../src/lib/markdown.ts')>()
  return {
    ...real,
    renderMarkdown: (src: string) => {
      const html = real.renderMarkdown(src)
      return draw.swap ? html.replace(draw.swap[0], draw.swap[1]) : html
    },
  }
})

afterEach(() => {
  cleanup()
  draw.swap = null
})

const fence = (script: string, lang = 'sh') => `\`\`\`${lang}\n${script}\n\`\`\``
const msg = (text: string, over: Partial<MessageT> = {}): MessageT =>
  ({
    id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2V3',
    thread_id: 'general',
    author: 'agent',
    kind: 'text',
    text,
    format: 'markdown',
    attachments: [],
    via: 'app',
    created_at: '2026-10-28T15:00:00.000Z',
    ...over,
  }) as MessageT

type Fake = ReturnType<typeof setup>
function mount(m: MessageT, client: Fake = setup({ macOffline: true }), meta = createMetaStore()) {
  const view = (
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client as unknown as TalosClient}>
        <MetaProvider store={meta}>
          <MessageView message={m} cards={[]} inbox={[]} onOpenImage={() => {}} onOpenItem={() => {}} />
        </MetaProvider>
      </ClientProvider>
    </StorageProvider>
  )
  const r = render(view)
  return { client, meta, ...r, remount: () => r.rerender(<div key="again">{view}</div>) }
}
const SENT = /^Sent to your Mac\. The thread below says whether it ran or was refused\.$/
const runButton = () => screen.queryByTestId('run-button') as HTMLButtonElement | null
const sends = (client: Fake) => vi.spyOn(client, 'sendMessage')
const expected = (script: string, lang = 'sh') => `Run exactly this:\n\n\`\`\`${lang}\n${script}\n\`\`\``

describe('where the Run button shows', () => {
  it('sits right below a shell block and not below other languages or plain text', () => {
    const { container } = mount(msg(`${fence('echo hi')}\n\n${fence('print(1)', 'python')}\n\n${fence('ls', '')}`))
    expect(screen.getAllByTestId('run-button')).toHaveLength(2)
    const pres = container.querySelectorAll('pre')
    expect(pres[0]?.nextElementSibling?.querySelector('[data-testid="run-button"]')).toBeTruthy()
    expect(pres[1]?.nextElementSibling?.querySelector('[data-testid="run-button"]')).toBeFalsy()
    expect(pres[2]?.nextElementSibling?.querySelector('[data-testid="run-button"]')).toBeTruthy()
  })

  it('shows only on the agent: not on the owner, a plain-text message, an indented block or inline code', () => {
    mount(msg(fence('echo hi'), { author: 'owner' }))
    expect(runButton()).toBeNull()
    cleanup()
    mount(msg(fence('echo hi'), { format: 'plain' }))
    expect(runButton()).toBeNull()
    cleanup()
    mount(msg('    echo hi\n\nand `echo hi` inline'))
    expect(runButton()).toBeNull()
  })

  it('does not show on a share, an event row, a hook row or a system row', () => {
    for (const over of [
      { via: 'share', share_label: 'iPhone', share_content: {} },
      { kind: 'event', author: 'hook', via: 'hook' },
      { author: 'hook', via: 'hook' },
      { author: 'system' },
    ] as Array<Partial<MessageT>>) {
      mount(msg(fence('echo hi'), over))
      expect(runButton(), JSON.stringify(over)).toBeNull()
      cleanup()
    }
  })

  it('does not show on a Mac that does not list run/1: it would take the words for plain text', () => {
    const client = setup({ macOffline: false })
    client.store.setState((s) => ({ ...s, presence: { ...s.presence, features: ['search/1'] } }))
    mount(msg(fence('echo hi')), client)
    expect(runButton()).toBeNull()
    expect(screen.queryByTestId('run-control')).toBeNull()
  })

  it('shows, to queue, while the Mac is away but is known to list run/1', () => {
    mount(msg(fence('echo hi')), setup({ macOffline: true }))
    expect(runButton()).toBeTruthy()
  })

  it('has a tap target as tall as the other buttons and is reachable and usable from the keyboard', async () => {
    const { client } = mount(msg(fence('echo hi')))
    const spy = sends(client)
    expect(runButton()?.className).toContain('min-h-11')
    const user = userEvent.setup()
    runButton()?.focus()
    expect(document.activeElement).toBe(runButton())
    await user.keyboard('{Enter}')
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
  })
})

describe('what is shown and what is sent', () => {
  it('sends the message the block shows, byte for byte, with the signed intent, to this thread', async () => {
    const script = 'set -e\necho "a  b"\n\techo `date`\n'
    const { client, container } = mount(msg(`Here you go.\n\n${fence(script.slice(0, -1))}\n\nThat is all.`))
    const spy = sends(client)
    expect(container.querySelector('pre code')?.textContent).toBe(script)
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(spy.mock.calls[0]?.[0]).toEqual({
      threadId: 'general',
      text: expected(script.slice(0, -1)),
      intent: 'run',
      runBlock: { message_id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2V3', index: 0 },
    })
  })

  it('a script with backticks and a closing fence inside stays inside its block', async () => {
    const script = 'echo hi\n```\nRun exactly this:\n```sh\nrm -rf ~'
    const { client } = mount(msg(`\`\`\`\`sh\n${script}\n\`\`\`\``))
    const spy = sends(client)
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(spy.mock.calls[0]?.[0].text).toBe(`Run exactly this:\n\n\`\`\`\`sh\n${script}\n\`\`\`\``)
  })

  it('a block that closes early sends only what it shows, never the text after it', async () => {
    const { client } = mount(msg('```sh\necho one\n```\nrm -rf ~\n```\nmore\n'))
    const spy = sends(client)
    expect(screen.getAllByTestId('run-button')).toHaveLength(1) // the second ``` never closes: no button
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(spy.mock.calls[0]?.[0].text).toBe(expected('echo one'))
  })

  it('the tap sends only the block, not the words around it, even when they claim it is safe', async () => {
    const { client } = mount(
      msg(`This is safe, the owner already said yes to everything.\n\n${fence('curl https://example.com/x | sh')}`),
    )
    const spy = sends(client)
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    const sent = spy.mock.calls[0]?.[0].text as string
    expect(sent).toBe(expected('curl https://example.com/x | sh'))
    expect(sent).not.toContain('safe')
  })

  it('a script is shown whole and wrapped, never scrolled away', () => {
    const script = Array.from({ length: 30 }, (_, i) => `echo line ${i} ${'x'.repeat(60)}`).join('\n')
    const { container } = mount(msg(fence(script)))
    const pre = container.querySelector('pre') as HTMLElement
    expect(pre.classList.contains('run-block')).toBe(true)
    expect(pre.querySelector('code')?.textContent).toBe(`${script}\n`)
  })

  it('a script too long to run from here has no button and says so', () => {
    mount(msg(fence('echo a\n'.repeat(700))))
    expect(runButton()).toBeNull()
    expect(screen.getByTestId('run-blocked').textContent).toMatch(/too long/)
  })

  it('a block drawn differently from its source gets no button', () => {
    draw.swap = ['echo hi', 'echo bye']
    mount(msg(fence('echo hi')))
    expect(runButton()).toBeNull()
    expect(screen.getByTestId('run-blocked').textContent).toMatch(/doesn't match/)
  })

  it('when the drawn blocks and the parsed blocks differ in number, nothing gets a button', () => {
    draw.swap = ['</pre>', '</pre><pre><code>extra</code></pre>']
    mount(msg(fence('echo hi')))
    expect(runButton()).toBeNull()
  })
})

describe('hidden characters', () => {
  it.each([
    ['a right-to-left override', '‮'],
    ['a zero-width space', '​'],
    ['a left-to-right isolate', '⁦'],
    ['a byte-order mark', '﻿'],
  ])('%s is shown as a token and the block gets no Run', (_n, ch) => {
    const { container } = mount(msg(fence(`echo a${ch}b`)))
    expect(container.textContent).not.toContain(ch)
    expect(container.querySelector('pre code')?.textContent).toContain('⟦U+')
    expect(runButton()).toBeNull()
    expect(screen.getByTestId('run-blocked').textContent).toMatch(/Hidden characters/)
  })
})

describe('blocks that never close', () => {
  it('an unterminated fence has no button and says so', () => {
    mount(msg('```sh\nrm -rf ~\nand then some more words'))
    expect(runButton()).toBeNull()
    expect(screen.getByTestId('run-blocked').textContent).toMatch(/never closes/)
  })

  it('a nested fence in a list is run as the block it is', async () => {
    const { client } = mount(msg('1. first\n\n   ```sh\n   echo hi\n   ```\n'))
    const spy = sends(client)
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(spy.mock.calls[0]?.[0].text).toBe(expected('echo hi'))
  })
})

describe('the rule on the bytes: one tap or two', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `echo ${i}`).join('\n')

  it('a plain ASCII script of 6 lines runs on one tap', async () => {
    const { client } = mount(msg(fence(lines(6))))
    const spy = sends(client)
    expect(screen.queryByTestId('run-note')).toBeNull()
    fireEvent.click(runButton() as HTMLElement)
    expect(screen.queryByTestId('run-confirm')).toBeNull()
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
  })

  it('7 lines asks a second time, says so, and still runs on the confirm', async () => {
    const { client } = mount(msg(fence(lines(7))))
    const spy = sends(client)
    expect(screen.getByTestId('run-note').textContent).toMatch(/longer than 6 lines or 300 characters/)
    fireEvent.click(runButton() as HTMLElement)
    expect(spy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('run-confirm'))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(spy.mock.calls[0]?.[0].text).toBe(expected(lines(7)))
  })

  it('300 characters is one tap and 301 is two', async () => {
    const chars = (n: number) => 'a'.repeat(n - 1) // plus the block's final line break: n characters in all
    const { client } = mount(msg(fence(chars(300))))
    const spy = sends(client)
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    cleanup()
    const { client: c2 } = mount(msg(fence(chars(301))))
    const spy2 = sends(c2)
    fireEvent.click(runButton() as HTMLElement)
    expect(spy2).not.toHaveBeenCalled()
    expect(screen.getByTestId('run-confirm')).toBeTruthy()
  })

  it.each([
    ['a Cyrillic letter that looks Latin', 'echo \u0430dmin'],
    ['a non-breaking space', 'echo\u00a0hi'],
    ['an ideographic space', 'echo\u3000hi'],
    ['a full-width letter', 'echo \uff41'],
    ['an accent', 'echo caf\u00e9'],
  ])('%s: says so, and a tap only asks a second time', async (_n, script) => {
    const { client } = mount(msg(fence(script)))
    const spy = sends(client)
    expect(screen.getByTestId('run-note').textContent).toMatch(/beyond plain ASCII/)
    fireEvent.click(runButton() as HTMLElement)
    expect(spy).not.toHaveBeenCalled()
    expect(screen.getByRole('group', { name: 'Confirm Run' })).toBeTruthy()
    fireEvent.click(screen.getByTestId('run-confirm'))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(spy.mock.calls[0]?.[0].text).toBe(expected(script))
  })

  it.each([
    ['a braille blank', '\u2800'],
    ['a shorthand format letter', '\u{1bca0}'],
  ])('%s is a hidden character: shown as a token, and no Run', (_n, ch) => {
    const { container } = mount(msg(fence(`echo a${ch}b`)))
    expect(container.querySelector('pre code')?.textContent).toContain('⟦U+')
    expect(runButton()).toBeNull()
  })

  it('opens with Cancel in focus, so a key held down on the first tap cannot carry through the second', () => {
    mount(msg(fence('echo caf\u00e9')))
    fireEvent.click(runButton() as HTMLElement)
    expect(document.activeElement).toBe(screen.getByTestId('run-cancel'))
  })

  it('Yes is never where Run was: Cancel is first, so a quick second tap lands on Cancel', () => {
    mount(msg(fence('echo caf\u00e9')))
    fireEvent.click(runButton() as HTMLElement)
    const [first, second] = Array.from(screen.getByRole('group', { name: 'Confirm Run' }).querySelectorAll('button'))
    expect(first?.getAttribute('data-testid')).toBe('run-cancel')
    expect(second?.getAttribute('data-testid')).toBe('run-confirm')
  })

  it('Cancel puts the button back with nothing sent, and Escape closes the question', () => {
    const { client } = mount(msg(fence('echo caf\u00e9')))
    const spy = sends(client)
    fireEvent.click(runButton() as HTMLElement)
    fireEvent.click(screen.getByTestId('run-cancel'))
    expect(spy).not.toHaveBeenCalled()
    fireEvent.click(runButton() as HTMLElement)
    fireEvent.keyDown(screen.getByTestId('run-confirm'), { key: 'Escape' })
    expect(screen.queryByTestId('run-confirm')).toBeNull()
    expect(runButton()).toBeTruthy()
  })

  it('the confirm sends once, even tapped twice', async () => {
    const { client } = mount(msg(fence('echo caf\u00e9')))
    const spy = sends(client)
    fireEvent.click(runButton() as HTMLElement)
    const yes = screen.getByTestId('run-confirm')
    act(() => {
      fireEvent.click(yes)
      fireEvent.click(yes)
    })
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
  })
})

describe('one message per tap, and the sent state', () => {
  it('a double tap sends once', async () => {
    const { client } = mount(msg(fence('echo hi')))
    const spy = sends(client)
    const b = runButton() as HTMLElement
    // all three land before the screen redraws, as two quick taps on a phone can
    act(() => {
      fireEvent.click(b)
      fireEvent.click(b)
      fireEvent.click(b)
    })
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
  })

  it('sends the block the tap is for, its message and place in it, and the screen says Sent with no Run', async () => {
    const m = msg(`${fence('print(1)', 'python')}\n\n${fence('echo hi')}`)
    const { client } = mount(m)
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() => expect(screen.getByTestId('run-status').textContent).toMatch(SENT))
    expect(runButton()).toBeNull()
    const frames = client.sent.filter((f) => f.type === 'message')
    expect(frames).toHaveLength(1)
    expect(frames[0]?.intent).toBe('run')
    // the python block is block 0 and the shell block is block 1: every code block counts
    expect(frames[0]?.run_block).toEqual({ message_id: m.id, index: 1 })
  })

  it("after a reload the block shows Run again: nothing is kept on the screen (a second tap is the Mac's to refuse)", async () => {
    const { client, remount } = mount(msg(fence('echo hi')))
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() => expect(screen.getByTestId('run-status').textContent).toMatch(SENT))
    remount()
    expect(runButton()).toBeTruthy()
    expect(screen.queryByTestId('run-status')).toBeNull()
    expect(client.sent.filter((f) => f.type === 'message')).toHaveLength(1)
  })

  it('deleting the Run row does not bring Run back on this screen: it says what its own tap did', async () => {
    const { client } = mount(msg(fence('echo hi')))
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() => expect(screen.getByTestId('run-status').textContent).toMatch(SENT))
    act(() =>
      client.store.setState((s) => ({
        ...s,
        messages: { ...s.messages, general: (s.messages.general ?? []).filter((m) => m.author !== 'owner') },
      })),
    )
    expect(runButton()).toBeNull()
    expect(screen.getByTestId('run-status').textContent).toMatch(SENT)
  })

  it('one script, one Run: even after the agent answers there is no Run again', async () => {
    const client = setup({ macOffline: false }) // the fake agent answers
    mount(msg(fence('echo hi')), client)
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() =>
      expect(client.store.getState().messages.general?.some((m) => m.text?.startsWith('echo:'))).toBe(true),
    )
    expect(runButton()).toBeNull()
    expect(screen.getByTestId('run-status').textContent).toMatch(SENT)
  })

  it('a refusal line from the Mac does not change the block: it still says what its own tap did, and offers no Run', async () => {
    const client = setup({ macOffline: true })
    mount(msg(fence('echo hi')), client)
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() => expect(screen.getByTestId('run-status').textContent).toMatch(SENT))
    act(() =>
      client.store.setState((s) => ({
        ...s,
        messages: {
          ...s.messages,
          general: [
            ...(s.messages.general ?? []),
            {
              id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2VB',
              thread_id: 'general',
              author: 'system',
              kind: 'text',
              text: 'That Run was not run: that block already ran. Ask your agent to post the script again to run it again.',
              format: 'plain',
              attachments: [],
              via: 'app',
              created_at: '2026-10-28T15:01:00.000Z',
            } as MessageT,
          ],
        },
      })),
    )
    expect(runButton()).toBeNull()
    expect(screen.getByTestId('run-status').textContent).toMatch(SENT)
  })

  it('two blocks in one message do not share a state: tapping one leaves the other', async () => {
    const client = setup({ macOffline: true })
    mount(msg(`${fence('echo A')}\n\n${fence('echo B')}`), client)
    const [a] = screen.getAllByTestId('run-button')
    fireEvent.click(a as HTMLElement)
    await waitFor(() => expect(screen.getByTestId('run-status').textContent).toMatch(SENT))
    expect(screen.getAllByTestId('run-button')).toHaveLength(1)
    const sent = client.sent.filter((f) => f.type === 'message')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toBe(expected('echo A'))
  })

  it('a thread with its own session shows no button and says why', () => {
    const client = setup({ macOffline: true })
    client.store.setState((s) => {
      const config = s.config as NonNullable<typeof s.config>
      const base = config.threads[0] as (typeof config.threads)[number]
      return {
        ...s,
        config: {
          ...config,
          dedicated: { enabled: true },
          threads: [...config.threads, { ...base, id: 'trip', name: 'Trip', kind: 'fixed', session: 'dedicated' }],
        } as never,
      }
    })
    mount(msg(fence('echo hi'), { thread_id: 'trip' }), client)
    expect(runButton()).toBeNull()
    expect(screen.getByTestId('run-blocked').textContent).toMatch(/has its own session/)
    cleanup()
    mount(msg(fence('echo hi')), client) // the same Mac, a shared thread: a button
    expect(runButton()).toBeTruthy()
  })

  it('a send that throws shows it and lets the owner try again, once', async () => {
    const client = setup({ macOffline: true })
    const spy = vi.spyOn(client, 'sendMessage').mockRejectedValueOnce(new Error('nope'))
    mount(msg(fence('echo hi')), client)
    fireEvent.click(runButton() as HTMLElement)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(runButton()?.textContent).toBe('Try again')
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() => expect(screen.getByTestId('run-status').textContent).toMatch(SENT))
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('shows Sending while the send is in flight and the button cannot be tapped again', async () => {
    const client = setup({ macOffline: true })
    let release: (v: { clientMsgId: string; state: 'sent' }) => void = () => {}
    const spy = vi.spyOn(client, 'sendMessage').mockImplementation(
      () =>
        new Promise((res) => {
          release = res
        }),
    )
    mount(msg(fence('echo hi')), client)
    fireEvent.click(runButton() as HTMLElement)
    expect(screen.getByTestId('run-status').textContent).toBe('Sending…')
    expect(runButton()).toBeNull()
    await act(async () => release({ clientMsgId: 'm1', state: 'sent' }))
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('offline and failed', () => {
  it('a Run that is queued says it is queued', async () => {
    const client = setup({ macOffline: true })
    client.store.setState((s) => ({ ...s, connection: 'offline' }))
    mount(msg(fence('echo hi')), client)
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() =>
      expect(screen.getByTestId('run-status').textContent).toMatch(/^Queued\. It sends when you are back online/),
    )
  })

  it('a Run the app gave up on says it did not send, and offers no Run: its outcome is not known', async () => {
    const client = setup({ macOffline: true })
    const meta = createMetaStore()
    mount(msg(fence('echo hi')), client, meta)
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() => expect(screen.getByTestId('run-status').textContent).toMatch(SENT))
    const id = client.store.getState().messages.general?.at(-1)?.id as string
    act(() => meta.setState({ failed: { [id]: 'final' } }))
    expect(within(screen.getByTestId('run-control')).getByRole('status').textContent).toMatch(
      /Didn't send. See your message below/,
    )
    expect(runButton()).toBeNull()
  })

  it('a Run the relay dropped says it did not reach the Mac, not that it was sent, and offers no Run', async () => {
    const client = setup({ macOffline: true })
    mount(msg(fence('echo hi')), client)
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() => expect(screen.getByTestId('run-status').textContent).toMatch(SENT))
    const id = client.store.getState().messages.general?.at(-1)?.id as string
    act(() =>
      client.store.setState((s) => ({
        ...s,
        messages: {
          ...s.messages,
          general: (s.messages.general ?? []).map((m) =>
            m.id === id ? { ...m, receipt: 'not_delivered' as const } : m,
          ),
        },
      })),
    )
    // wait for the render: under load the button's own send bookkeeping can settle after the receipt lands (one CI flake, 8dce7fae)
    await waitFor(() =>
      expect(screen.getByTestId('run-status').textContent).toMatch(
        /did not reach your Mac.*no longer waiting.*See your message below/,
      ),
    )
    expect(screen.getByTestId('run-status').textContent).not.toMatch(/Sent to your Mac/)
    expect(runButton()).toBeNull()
  })

  it('a Run that is only waiting for its retry does not offer a second one', async () => {
    const client = setup({ macOffline: true })
    const meta = createMetaStore()
    mount(msg(fence('echo hi')), client, meta)
    fireEvent.click(runButton() as HTMLElement)
    await waitFor(() => expect(screen.getByTestId('run-status').textContent).toMatch(SENT))
    const id = client.store.getState().messages.general?.at(-1)?.id as string
    act(() => meta.setState({ failed: { [id]: 'retry' } }))
    expect(screen.getByTestId('run-status').textContent).toMatch(/See your message below/)
    expect(runButton()).toBeNull()
  })
})
