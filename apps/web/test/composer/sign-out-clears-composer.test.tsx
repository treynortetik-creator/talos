// What the composer holds in memory (words of a send that failed, a prefill, dropped files, attachments, a quoted message)
// goes when any session ends, whatever the reason: it is per-tab memory that no queue, Discard or other tab can reach, so
// words left in it could go out later under another device key or after the owner signed out elsewhere. A send or an
// attach that was started before a wipe never puts anything back after it.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearAfterSessionEnd, clearLocalData, useSession } from '../../src/features/auth/session.ts'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { type Chip, prefillComposer, useComposerStore } from '../../src/features/composer/composerStore.ts'
import { AccountSection } from '../../src/features/settings/sections.tsx'
import { ClientProvider, TalosClientError } from '../../src/lib/client.ts'
import { deleteDeviceKey, ensureDeviceKey } from '../../src/lib/deviceKey.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createSocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage, type Storage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { discardUnsent } from '../../src/lib/unsent.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useComposerStore.setState(useComposerStore.getInitialState())
  useSession.setState({ status: 'loading', me: null, offline: false })
  localStorage.clear()
})

const REFUSED = new DOMException('The quota has been exceeded.', 'QuotaExceededError')
const chip = (key: string): Chip => ({
  key,
  name: `${key}.txt`,
  state: 'ready',
  ref: { id: key, name: `${key}.txt`, mime: 'text/plain', size: 1 } as never,
  file: new File(['x'], `${key}.txt`),
})

const boxOn = (storage: Storage, client: unknown) => (
  <StorageProvider storage={storage}>
    <ClientProvider client={client as never}>
      <Composer threadId="general" />
    </ClientProvider>
  </StorageProvider>
)
const textbox = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
const sendButton = () => screen.getByRole('button', { name: 'Send' })

/** Every send stays in flight until the test fails it. */
function setup() {
  const storage = createMemoryStorage()
  const client = createFakeClient()
  const rejects: Array<(e: Error) => void> = []
  vi.spyOn(client, 'sendMessage').mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejects.push(reject)
      }),
  )
  const ui = boxOn(storage, client)
  const failAll = () =>
    act(async () => {
      for (const reject of rejects) reject(REFUSED)
    })
  return { storage, client, ui, failAll }
}

/** The next box on the thread: its text, and what it left in the drafts store once it is gone. */
async function nextBoxIsEmpty(s: { storage: Storage; ui: React.ReactElement }) {
  const box = render(s.ui)
  await waitFor(() => expect(textbox()).toBeTruthy())
  expect(textbox().value).toBe('')
  box.unmount()
  expect(await s.storage.get('drafts', 'general')).toBeUndefined()
}

describe('a session end', () => {
  it('the words of a failed send are gone, and the next box does not save them', async () => {
    const s = setup()
    const first = render(s.ui)
    await userEvent.type(textbox(), 'private words')
    await userEvent.click(sendButton())
    first.unmount()
    await s.failAll() // the send failed after the owner left: the words wait in the store
    expect(useComposerStore.getState().sendFailure.general?.texts).toEqual(['private words'])
    await clearLocalData(s.storage)
    expect(useComposerStore.getState().sendFailure).toEqual({})
    await nextBoxIsEmpty(s)
  })

  it('a prefill, dropped files, attachments and a quoted message are gone', async () => {
    const s = setup()
    act(() => {
      prefillComposer('general', 're: private item')
      useComposerStore.getState().dropFiles('general', [new File(['x'], 'dropped.txt')])
      useComposerStore.getState().setChips('general', [chip('a')])
      useComposerStore.getState().setReplyTo('general', { id: 'm_1', author: 'agent', excerpt: 'private excerpt' })
    })
    await clearLocalData(s.storage)
    const st = useComposerStore.getState()
    expect([st.prefill, st.dropped, st.chips, st.replyTo]).toEqual([{}, {}, {}, {}])
    await nextBoxIsEmpty(s)
  })

  // Settings runs: stop the client, wipe, and only then mark the session anonymous. A send that fails while the wipe is
  // still running must not put its words back after the composer was emptied.
  it('a send that fails while Settings is wiping does not come back (the real order: wipe first, anon last)', async () => {
    useSession.setState({ status: 'authed', me: null, offline: false })
    const base = createMemoryStorage()
    let openGate!: () => void
    const gate = new Promise<void>((r) => {
      openGate = r
    })
    let atDrafts = false
    const storage: Storage = {
      ...base,
      async clear(name) {
        if (name === 'drafts') {
          atDrafts = true
          await gate
        }
        return base.clear(name)
      },
    }
    const s = { ...setup(), storage }
    const sends: Array<(e: Error) => void> = []
    vi.spyOn(s.client, 'sendMessage').mockImplementation(
      () =>
        new Promise((_, reject) => {
          sends.push(reject)
        }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('logout') ? new Response(null, { status: 204 }) : Response.json([]),
      ),
    )
    const first = render(boxOn(storage, s.client))
    await userEvent.type(textbox(), 'private words')
    await userEvent.click(sendButton())
    first.unmount() // the owner goes to Settings
    render(
      <ClientProvider client={s.client}>
        <StorageProvider storage={storage}>
          <MemoryRouter initialEntries={['/settings']}>
            <Routes>
              <Route path="*" element={<AccountSection readOnly={false} />} />
            </Routes>
          </MemoryRouter>
        </StorageProvider>
      </ClientProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Sign out of this device' }))
    await waitFor(() => expect(atDrafts).toBe(true))
    expect(useSession.getState().status).toBe('authed') // setAnon is the last step
    await act(async () => {
      for (const reject of sends) reject(new TalosClientError('internal', 'Signed out'))
    })
    await act(async () => openGate())
    await waitFor(() => expect(useSession.getState().status).toBe('anon'))
    expect(useComposerStore.getState().sendFailure).toEqual({})
    await nextBoxIsEmpty({ storage: base, ui: boxOn(base, s.client) })
  })

  it('files still waiting in an attach loop do not come back as attachments after the wipe', async () => {
    const s = setup()
    const rejects: Array<(e: Error) => void> = []
    vi.spyOn(s.client, 'uploadMedia').mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejects.push(reject)
        }),
    )
    const first = render(s.ui)
    await waitFor(() => expect(textbox()).toBeTruthy())
    act(() =>
      useComposerStore.getState().dropFiles('general', [new File(['a'], 'one.txt'), new File(['secret'], 'two.txt')]),
    )
    await waitFor(() => expect(rejects.length).toBe(1))
    await clearLocalData(s.storage) // sign-out, while the first upload is still going
    expect(useComposerStore.getState().chips).toEqual({})
    await act(async () => rejects[0]?.(new TypeError('Failed to fetch')))
    first.unmount()
    // the second file was never started: the loop saw the wipe
    expect(rejects.length).toBe(1)
    expect(useComposerStore.getState().chips.general ?? []).toEqual([])
  })

  it('a draft not yet saved when the box goes away is not saved after the wipe', async () => {
    const s = setup()
    const first = render(s.ui)
    await userEvent.type(textbox(), 'typed a moment ago') // the 300 ms save has not fired
    const wiping = clearLocalData(s.storage)
    first.unmount() // the page leaves: the box flushes what it has not saved
    await wiping
    await act(async () => {})
    expect(await s.storage.get('drafts', 'general')).toBeUndefined()
  })

  it.each([
    ['revoked'],
    ['logged_out'],
    ['logged_out_everywhere'],
    [null],
    ['a_reason_nobody_knows'],
    ['expired'],
    ['signed_in_again'],
    ['device_changed'],
  ])('a session that ends with reason %j empties the composer', async (reason) => {
    const s = setup()
    act(() => {
      useComposerStore.getState().addSendFailure('general', 'words', 'Could not send')
      prefillComposer('general', 're: item')
      useComposerStore.getState().setChips('general', [chip('a')])
    })
    await clearAfterSessionEnd(s.storage, reason)
    const st = useComposerStore.getState()
    expect([st.sendFailure, st.prefill, st.chips]).toEqual([{}, {}, {}])
  })
})

describe('words that were in the composer when the session ended', () => {
  it.each([['expired'], ['signed_in_again'], ['device_changed']])(
    'do not come back after reason %j, a real device-key replacement, Discard, or another tab signing out',
    async (reason) => {
      const s = setup()
      const first = render(s.ui)
      await userEvent.type(textbox(), 'private words')
      await userEvent.click(sendButton())
      first.unmount()
      await s.failAll() // the send failed after the owner left: the words wait in the store
      expect(useComposerStore.getState().sendFailure.general?.texts).toEqual(['private words'])
      await clearAfterSessionEnd(s.storage, reason)
      expect(useComposerStore.getState().sendFailure).toEqual({}) // nothing is left in this tab's memory to come back
      // the key is replaced for real: the next sign-in on this device signs with a different key
      const before = await ensureDeviceKey(s.storage)
      await deleteDeviceKey(s.storage)
      expect((await ensureDeviceKey(s.storage)).deviceId).not.toBe(before.deviceId)
      await discardUnsent(s.storage) // "Discard" on the sign-in page
      // another tab signs out: it empties the shared storage, which cannot reach this tab's memory
      for (const name of ['cache', 'drafts', 'outbox', 'blobs', 'schedules'] as const) await s.storage.clear(name)
      await nextBoxIsEmpty(s)
      expect(s.client.sendMessage).toHaveBeenCalledTimes(1) // only the first, failed one
    },
  )

  // The close can also land while the message is being signed. The row is still saved, and the box does not give up silently.
  it.each([
    ['expired', true],
    ['expired', false],
    ['signed_in_again', true],
    ['signed_in_again', false],
  ])(
    'a message pressed as the session ends (%s) while it is being signed stays queued (box mounted: %s)',
    async (reason, mounted) => {
      useSession.setState({ status: 'authed', me: null, offline: false })
      const storage = createMemoryStorage()
      let openGate!: () => void
      const gate = new Promise<void>((r) => {
        openGate = r
      })
      let atSigning = false
      const real = crypto.subtle.sign.bind(crypto.subtle)
      vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (alg, key, data) => {
        if (!atSigning) {
          atSigning = true // the first signing after the box is mounted is the message
          await gate
        }
        return real(alg as never, key, data as BufferSource)
      })
      const client = createSocketClient({ storage, wsUrl: 'ws://127.0.0.1:9/ws', isOnline: () => false })
      await client.ensureDevice()
      render(boxOn(storage, client))
      await userEvent.type(textbox(), 'signed words')
      await userEvent.click(sendButton())
      await waitFor(() => expect(atSigning).toBe(true))
      client.close({ keepQueue: true })
      act(() => useSession.getState().setAnon())
      await clearAfterSessionEnd(storage, reason)
      if (!mounted) cleanup()
      await act(async () => openGate())
      await waitFor(async () => expect((await storage.all('outbox')).length).toBe(1))
      expect(useComposerStore.getState().sendFailure).toEqual({})
      cleanup()
      expect(await storage.get('drafts', 'general')).toBeUndefined()
      vi.restoreAllMocks()
    },
  )

  // A send caught by the close is left in the queue (where its removal routes apply) and the caller is told it is queued,
  // so the words are not also given back to the box.
  it.each([['expired'], ['signed_in_again']])(
    'a message pressed as the session ends (%s) stays queued and is not given back to the box',
    async (reason) => {
      useSession.setState({ status: 'authed', me: null, offline: false })
      const base = createMemoryStorage()
      let openGate!: () => void
      const gate = new Promise<void>((r) => {
        openGate = r
      })
      let atOutbox = false
      const storage: Storage = {
        ...base,
        async put(name, key, value) {
          if (name === 'outbox') {
            atOutbox = true
            await gate
          }
          return base.put(name, key, value)
        },
      }
      const client = createSocketClient({ storage, wsUrl: 'ws://127.0.0.1:9/ws', isOnline: () => false })
      await client.ensureDevice()
      render(boxOn(storage, client))
      await userEvent.type(textbox(), 'queued words')
      await userEvent.click(sendButton())
      await waitFor(() => expect(atOutbox).toBe(true))
      // what the session code does on the end: stop the client, go anonymous, empty what that reason empties
      client.close({ keepQueue: true })
      act(() => useSession.getState().setAnon())
      await clearAfterSessionEnd(storage, reason)
      cleanup() // the Gate unmounts the box
      await act(async () => openGate())
      await waitFor(async () => expect((await base.all('outbox')).length).toBe(1))
      expect(useComposerStore.getState().sendFailure).toEqual({})
      expect(await base.get('drafts', 'general')).toBeUndefined()
    },
  )
})
