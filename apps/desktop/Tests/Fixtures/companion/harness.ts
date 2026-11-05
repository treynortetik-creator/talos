// The page for CompanionFeedGuiTests: the REAL attachShell, shell bridge and companion feed, on a real zustand store
// (the fake client is the same store and frame plumbing the web app runs on in fake mode), inside a real WKWebView.
// Bundled by build-harness.mjs; never shipped.

import { useSession } from '../../../../web/src/features/auth/session.ts'
import { attachShell } from '../../../../web/src/features/native/attach.ts'
import { createMetaStore } from '../../../../web/src/lib/connectionMeta.ts'
import { createFakeClient } from '../../../../web/src/lib/fakeClient.ts'
import { installShell } from '../../../../web/src/lib/native/shell.ts'

type Handler = { postMessage(m: unknown): unknown }
const w = window as unknown as {
  webkit: { messageHandlers: { talos: Handler } }
  __posted: unknown[]
  __h: unknown
}

// Record every raw message the page posts. `messageHandlers.talos` is read-only, but its `postMessage` can be wrapped on the
// object itself, before the shell bridge captures the handler.
const real = w.webkit.messageHandlers.talos
const realPost = real.postMessage.bind(real)
w.__posted = []
;(w as unknown as { __errors: string[] }).__errors = []
window.addEventListener('error', (e) => (w as unknown as { __errors: string[] }).__errors.push(String(e.message)))
window.addEventListener('unhandledrejection', (e) =>
  (w as unknown as { __errors: string[] }).__errors.push(String(e.reason)),
)
Object.defineProperty(real, 'postMessage', {
  configurable: true,
  value(m: unknown) {
    w.__posted.push(JSON.parse(JSON.stringify(m)))
    return realPost(m)
  },
})

const shell = installShell(window)
if (!shell) throw new Error('the page was not detected as the Mac shell')
const client = createFakeClient()
// The fake client has no connection meta, so `failed` would stay 0. The socket client's own store gives the page what the real
// one has: a failed send is a key in `meta.failed`, and the feed reads exactly that.
const meta = createMetaStore()
Object.assign(client, { meta })
useSession.setState({ status: 'authed' })
attachShell(shell, client)

w.__h = {
  client,
  useSession,
  names: () => client.store.getState().threads.map((t) => t.name),
  setStatus(threadId: string, state: string) {
    client.store.setState((s) => ({
      statuses: { ...s.statuses, [threadId]: { thread_id: threadId, state, since: new Date().toISOString() } },
    }))
  },
  signOut() {
    useSession.setState({ status: 'anon' })
  },
  signIn() {
    useSession.setState({ status: 'authed' })
  },
  // A hostile agent reply in the store, to prove none of it crosses in a companion_state frame.
  addReply(threadId: string, text: string) {
    client.store.setState((s) => ({
      messages: {
        ...s.messages,
        [threadId]: [
          ...(s.messages[threadId] ?? []),
          {
            id: `m_01JBF3V7Q8K2M4N6P8R0S2T4ZZ`,
            thread_id: threadId,
            author: 'agent',
            kind: 'text',
            text,
            format: 'markdown',
            attachments: [],
            via: 'app',
            created_at: new Date().toISOString(),
          },
        ],
      },
    }))
  },
  // A send that failed: the same record `socketClient` writes when a message is refused.
  failSend(clientMsgId: string) {
    meta.setState((m) => ({ ...m, failed: { ...m.failed, [clientMsgId]: 'retry' } }))
  },
  clearFailed() {
    meta.setState((m) => ({ ...m, failed: {} }))
  },
  companionFrames: () => (w.__posted as Array<{ type: string }>).filter((m) => m.type === 'companion_state'),
}
