// The real TalosClient: WebSocket to the relay (cookie auth), hello/ready, catch-up, signed-bytes outbox, reconnect
// backoff, history paging. Every owner frame is signed over the RAW object (spec 3.5) with explicit empty arrays and the
// exact bytes that were signed are what goes on the wire, now or after a reconnect.
//
// This file puts the parts together; each part is one file (socket-*.ts) that fills in its functions on a shared context
// (socket-ctx.ts): state and persistence (socket-state), frame dispatch (socket-dispatch, with the socket-frames-*
// handlers), the inbox queue (socket-inbox), the outbox (socket-outbox-*), the connection (socket-connection), requests
// that wait for an answer (socket-requests), media upload (socket-upload), page lifecycle (socket-lifecycle) and the
// client methods (socket-client-*).
import { routes } from '@talos-app/protocol'
import type { TalosApi } from './client.ts'
import { createClientOwner } from './socket-client-owner.ts'
import { createClientSend } from './socket-client-send.ts'
import { createClientSession } from './socket-client-session.ts'
import { createSocketConnection } from './socket-connection.ts'
import { createSocketCtx } from './socket-ctx.ts'
import { createSocketDispatch } from './socket-dispatch.ts'
import { createSocketInbox } from './socket-inbox.ts'
import { createSocketLifecycle } from './socket-lifecycle.ts'
import { createOutboxEnqueue } from './socket-outbox-enqueue.ts'
import { createOutboxFlush } from './socket-outbox-flush.ts'
import { createOutboxQueue } from './socket-outbox-queue.ts'
import { createOutboxSend } from './socket-outbox-send.ts'
import { createSocketRequests } from './socket-requests.ts'
import { createSocketState } from './socket-state.ts'
import type { SocketClient, SocketClientOptions } from './socket-types.ts'
import { createSocketUpload } from './socket-upload.ts'
import { createSocketFolders } from './socketFolders.ts'
import { createSocketMemory } from './socketMemory.ts'
import { createSocketSchedules, NO_ANSWER_MS } from './socketSchedules.ts'
import { createSocketSearch } from './socketSearch.ts'
import { createSocketSpeak } from './socketSpeak.ts'

export { MAX_MESSAGE_CHARS, MAX_UPLOAD_BYTES } from './socket-constants.ts'
export type { OutboxEntry, SocketClient, SocketClientOptions } from './socket-types.ts'

export function createSocketClient(opts: SocketClientOptions): SocketClient {
  const c = createSocketCtx(opts)
  const { http, meta, set, store } = c
  // Each part fills in its functions on `c`. A part only defines functions when it is created and calls none of another
  // part's until a frame, a tap or a timer runs them, except the dispatch part, which reads the others: it goes last.
  createSocketState(c)
  createSocketInbox(c)
  createOutboxQueue(c)
  createOutboxSend(c)
  createOutboxFlush(c)
  createOutboxEnqueue(c)
  createSocketConnection(c)
  createSocketRequests(c)
  createSocketUpload(c)
  createSocketLifecycle(c)
  createSocketDispatch(c)

  // ---- api -------------------------------------------------------------------------------------------------------
  const sub = (path: string, id: string) => path.replace(':id', encodeURIComponent(id))
  const api: TalosApi = {
    catalog: async () => routes.catalog.res.parse(await http.get(routes.catalog.path)),
    connections: {
      list: async () => routes.connectionsList.res.parse(await http.get(routes.connectionsList.path)),
      create: async (body) =>
        routes.connectionCreate.res.parse(await http.json('POST', routes.connectionCreate.path, body)),
      get: async (id) => routes.connectionGet.res.parse(await http.get(sub(routes.connectionGet.path, id))),
      patch: async (id, body) =>
        routes.connectionPatch.res.parse(await http.json('PATCH', sub(routes.connectionPatch.path, id), body)),
      delete: async (id) => void (await http.json('DELETE', sub(routes.connectionDelete.path, id))),
      rotate: async (id) =>
        routes.connectionRotate.res.parse(await http.json('POST', sub(routes.connectionRotate.path, id), {})),
      test: async (id) =>
        routes.connectionTest.res.parse(await http.json('POST', sub(routes.connectionTest.path, id), {})),
      credentials: async (id, fields) =>
        routes.connectionCredentials.res.parse(
          await http.json('POST', sub(routes.connectionCredentials.path, id), { fields }),
        ),
      deliveries: async (id) =>
        routes.connectionDeliveries.res.parse(await http.get(sub(routes.connectionDeliveries.path, id))),
    },
    inbox: async (tab) => {
      const res = routes.inboxList.res.parse(await http.get(`${routes.inboxList.path}?tab=${tab}`))
      set((s) => {
        const other = s.inbox.filter((i) => (i.priority !== 'low') !== (tab === 'priority'))
        return { inbox: [...res.items, ...other], inboxTruncated: Boolean(res.truncated) }
      })
      return res
    },
  }

  // ---- the client ------------------------------------------------------------------------------------------------
  const schedules = createSocketSchedules({
    // schedule frames get the Mac's 20 s (S2.2), not card.resolve's 12 s: the bridge acks a patch or a get after its adapter calls
    sendAndWait: (frame) => c.sendAndWait(frame, NO_ANSWER_MS),
    on: (type, cb) => client.onFrame(type, cb as never),
    getSlice: () => store.getState().schedules,
    setSlice: (next) => set((s) => ({ schedules: { ...s.schedules, ...next } })),
    features: () => store.getState().presence.features,
    relayFeatures: () => store.getState().relayFeatures,
    macOnline: () => store.getState().presence.bridge_online,
    onOnline: (cb) => {
      let was = store.getState().connection
      return store.subscribe((s) => {
        const now = s.connection
        if (now === 'online' && was !== 'online') cb()
        was = now
      })
    },
  })

  const memory = createSocketMemory({ ask: (frame, answer) => c.askRead(frame, answer) as never })
  const speak = createSocketSpeak({ ask: (frame) => c.askRead(frame, 'speak.result') })
  const folders = createSocketFolders({ ask: (frame) => c.askRead(frame, 'fs.listing') })

  const search = createSocketSearch({
    sendAndWait: (frame, ms) => c.sendAndWait(frame, ms),
    on: (type, cb) => client.onFrame(type, cb as never),
    requestPage: (frame, ms) => {
      const { type: _type, ...fields } = frame
      return c.requestHistory(fields, ms, "Your Mac didn't answer.", true)
    },
    features: () => store.getState().presence.features,
    macOnline: () => store.getState().presence.bridge_online,
  })
  const client: SocketClient = {
    schedules,
    search,
    memory,
    speak,
    folders,
    store,
    meta,
    api,
    ...createClientSession(c),
    ...createClientSend(c),
    ...createClientOwner(c),
  }
  c.client = client
  return client
}
