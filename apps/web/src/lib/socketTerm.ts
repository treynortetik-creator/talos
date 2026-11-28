// The socket TermClient: signed open, resume and close (never queued, never retried: a stale one is refused by the Mac), and the
// unsigned credit. The Mac's answers arrive as frames on `client.onFrame`; this only sends, and waits for the answer to an open.
import { newUlid, signOwnerFrame } from '@talos-app/protocol'
import { NotSentError, TalosClientError } from './client.ts'
import { APP_REQUEST_SETTLE_MS } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'
import type { TermClient } from './termClient.ts'

/** How long an open may wait for its `term.opened` before the page says the Mac did not answer. */
export const TERM_OPEN_WAIT_MS = 20_000

export function createSocketTerm(c: SocketCtx): TermClient {
  /** Signs `frame` as the device and puts it on the socket; the relay's `error{ref}` for it rejects `answered`. */
  async function sendSigned(
    frame: Record<string, unknown>,
    answered: (done: () => void) => () => void,
    waitMs: number,
  ) {
    if (!c.canSend()) throw new NotSentError('mac_offline', "You're offline.")
    const k = await c.ensureKey()
    if (!c.store.getState().devicePinned)
      throw new NotSentError('device_not_pinned', 'Waiting for your Mac to confirm this device.')
    const id = newUlid()
    const signed = await signOwnerFrame({ v: 1, id, ts: c.signedTs(), ...frame, device_id: k.deviceId }, k.privateKey)
    // The socket may have gone while this was being signed: nothing may be sent into it.
    if (!c.canSend()) throw new NotSentError('mac_offline', "You're offline.")
    await new Promise<void>((resolve, reject) => {
      let off: () => void = () => {}
      const finish = () => {
        clearTimeout(timer)
        off()
        c.pending.delete(id)
        resolve()
      }
      const timer = setTimeout(finish, waitMs)
      off = answered(finish)
      // an `error{ref}` for this frame lands on the pending map (the `error` case of the dispatch)
      c.pending.set(id, {
        resolve: () => {},
        reject: (e) => {
          clearTimeout(timer)
          off()
          reject(e)
        },
        timer,
      })
      try {
        c.ws?.send(JSON.stringify(signed))
      } catch {
        clearTimeout(timer)
        off()
        c.pending.delete(id)
        reject(new NotSentError('mac_offline', "You're offline."))
      }
    })
  }

  const none = () => () => {}
  return {
    async open({ termId, target, cols, rows }) {
      let answeredIn = false
      await sendSigned(
        { type: 'term.open', term_id: termId, tier: 'view', target, cols, rows },
        (done) => {
          const offs = (['term.opened', 'term.closed'] as const).map((t) =>
            c.client.onFrame(t, (f) => {
              if (f.term_id !== termId) return
              answeredIn = true
              done()
            }),
          )
          return () => {
            for (const o of offs) o()
          }
        },
        TERM_OPEN_WAIT_MS,
      )
      // the wait ended without the Mac's word: it did not answer
      if (!answeredIn) throw new TalosClientError('mac_offline', 'Your Mac did not answer.')
    },
    resume: (termId, from) => sendSigned({ type: 'term.resume', term_id: termId, from }, none, APP_REQUEST_SETTLE_MS),
    close: (termId) => sendSigned({ type: 'term.close', term_id: termId }, none, APP_REQUEST_SETTLE_MS),
    ack(termId, upto) {
      c.send({ type: 'term.ack', term_id: termId, upto })
    },
  }
}
