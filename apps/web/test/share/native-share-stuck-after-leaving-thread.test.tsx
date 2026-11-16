// Share on an attachment in the iPhone app asks the shell to fetch the file and open the share sheet. One share runs at a
// time, so a module-level flag (`nativePending`) makes every other Share tap do nothing until the shell answers with the
// `talos:share-media-done` window event, or a fallback timer runs out. Both of those live in the attachment's own hook:
// the window listener is removed and the timer is cleared when the row unmounts, and neither clears the flag. So a Share
// tap followed by leaving the thread before the shell answers (it downloads the file first) leaves the flag set for good:
// the answer arrives with nobody listening, and every Share button in the app is dead until the app is restarted.
import type { AttachmentRefT } from '@talos-app/protocol'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { MouseEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SHARE_MEDIA_DONE_EVENT } from '../../src/features/threads/shareAttachment.ts'
import { useDelivery } from '../../src/features/threads/useDelivery.ts'

const posted: unknown[] = []
const scope = globalThis as unknown as Record<string, unknown>

beforeEach(() => {
  posted.length = 0
  // the iPhone shell: Capacitor on iOS, with the share handler
  scope.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }
  scope.webkit = { messageHandlers: { talosShareMedia: { postMessage: (m: unknown) => posted.push(m) } } }
})
afterEach(() => {
  cleanup()
  delete scope.Capacitor
  delete scope.webkit
})

const att = (n: number): AttachmentRefT =>
  ({
    media_id: `md_01JBF3V7Q8K2M4N6P8R0S2T4A${n}`,
    kind: 'file',
    name: `report-${n}.pdf`,
    mime: 'application/pdf',
    size: 2048,
  }) as AttachmentRefT

const tap = { preventDefault: () => {} } as unknown as MouseEvent

describe('Share in the iPhone app', () => {
  it('still works after a share was started and the thread was left before the shell answered', () => {
    const first = renderHook(() => useDelivery(att(1), 'ready'))
    expect(first.result.current.mode).toBe('native')
    act(() => first.result.current.onClick(tap))
    expect(posted).toHaveLength(1)

    // the owner goes back to the thread list while the shell is still fetching the file: no attachment is on screen
    first.unmount()
    // the shell's answer ("the sheet is up" / "the fetch failed") arrives now
    window.dispatchEvent(new CustomEvent(SHARE_MEDIA_DONE_EVENT))

    // later, in any thread: Share on another file
    const second = renderHook(() => useDelivery(att(2), 'ready'))
    act(() => second.result.current.onClick(tap))
    expect(posted).toHaveLength(2)
  })
})
