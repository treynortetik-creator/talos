// The screenshot hotkey (Mac app): `capture_drop` puts the image into a thread's composer as a pending attachment, ready for
// a line of text. Nothing is sent until the owner sends. The page answers `capture_ack`: ok once that composer has taken
// the image (it may still be uploading), or why not, so the Mac app can tell the owner and drop the image.

import type { NativeToWebT, WebToNativeT } from '@talos-app/protocol'
import { ownValue } from '@talos-app/protocol'
import type { TalosClient } from '../../lib/client.ts'
import { composerResets, useComposerStore } from '../composer/composerStore.ts'

type CaptureDrop = Extract<NativeToWebT, { type: 'capture_drop' }>
type Ack = Extract<WebToNativeT, { type: 'capture_ack' }>

/** How long the image waits for its thread's composer to take it; the Mac app gives up at 30 s, so this answers first. */
export const CAPTURE_TAKE_MS = 20_000

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// The thread last on screen (/t/:thread, or a card's thread), kept by the Shell. A capture with no pinned thread goes there.
let lastViewed: string | null = null
export function noteViewedThread(thread: string | null): void {
  if (thread) lastViewed = thread
}
/** Tests only. */
export function resetCaptureState(): void {
  lastViewed = null
}

/** The thread a capture goes to: the pinned one, else the one last on screen, else the default one; only a live thread. */
export function captureThread(client: TalosClient, pinned: string | null): string | null {
  const st = client.store.getState()
  const live = (id: string | null | undefined): id is string =>
    !!id && st.threads.some((t) => t.id === id && !t.archived && t.kind !== 'system')
  for (const id of [pinned, lastViewed, st.config?.default_thread, 'general']) if (live(id)) return id
  return null
}

/**
 * The PNG as a File named like a Mac screenshot, in local time. null unless the bytes are a PNG whose header (IHDR) states
 * exactly the size the message says: a picture claiming to be small cannot be a huge one to decode.
 */
export function captureFile(
  m: Pick<CaptureDrop, 'data_b64' | 'width' | 'height'>,
  now: Date = new Date(),
): File | null {
  let bytes: Uint8Array
  try {
    const bin = atob(m.data_b64)
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } catch {
    return null
  }
  if (bytes.length < 24 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ihdr = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0)
  if (ihdr !== 'IHDR' || view.getUint32(16) !== m.width || view.getUint32(20) !== m.height) return null
  const p = (n: number) => String(n).padStart(2, '0')
  const when = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} at ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}`
  return new File([bytes as BlobPart], `Screenshot ${when}.png`, { type: 'image/png' })
}

/**
 * Handles one `capture_drop`. `send` answers the shell. Resolves once the answer is sent: ok when the thread's composer has
 * taken the image, or not ok (not signed in, not a PNG, no thread, or the composer did not take it in time).
 */
export function handleCaptureDrop(
  m: CaptureDrop,
  o: {
    client: TalosClient
    signedIn: () => boolean
    nav: (path: string) => void
    send: (ack: Ack) => void
    takeMs?: number
  },
): Promise<void> {
  const ack = (ok: boolean, reason?: Ack['reason']) =>
    o.send({ type: 'capture_ack', req: m.req, ok, ...(reason ? { reason } : {}) })
  if (!o.signedIn()) return Promise.resolve(ack(false, 'not_signed_in'))
  const file = captureFile(m)
  if (!file) return Promise.resolve(ack(false, 'bad_image'))
  const thread = captureThread(o.client, m.thread_id)
  if (!thread) return Promise.resolve(ack(false, 'no_thread'))
  const store = useComposerStore
  const resetsAtStart = composerResets()
  store.getState().dropFiles(thread, [file], { focus: true })
  const path = `/t/${encodeURIComponent(thread)}`
  if (typeof location === 'undefined' || location.pathname !== path) o.nav(path) // already there: no extra history entry
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean, reason?: Ack['reason']) => {
      if (done) return
      done = true
      clearTimeout(timer)
      off()
      if (!ok) {
        // Not taken: take it back, so it cannot turn up in the composer after the Mac app was told it failed. The focus
        // request goes with it when nothing else waits for that thread, or a later ordinary drop would take the focus.
        store.setState((s) => {
          const left = (ownValue(s.dropped, thread) ?? []).filter((f) => f !== file)
          return {
            dropped: { ...s.dropped, [thread]: left },
            ...(left.length === 0 ? { dropFocus: { ...s.dropFocus, [thread]: undefined } } : {}),
          }
        })
      }
      ack(ok, reason)
      resolve()
    }
    const taken = () => !(ownValue(store.getState().dropped, thread) ?? []).includes(file)
    const off = store.subscribe(() => {
      // A sign-out wipes the composer (resetComposer): gone is not taken.
      if (composerResets() !== resetsAtStart || !o.signedIn()) finish(false, 'not_signed_in')
      else if (taken()) finish(true)
    })
    const timer = setTimeout(() => finish(false, 'no_thread'), o.takeMs ?? CAPTURE_TAKE_MS)
    if (taken()) finish(true) // the composer was already up and took it at once
  })
}
