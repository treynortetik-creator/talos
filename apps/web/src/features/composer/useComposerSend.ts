// Sending the box: a message with its ready attachments, or a typed session control. The words are taken off the box
// first and handed back (with the chips) if the send fails.

import type { AttachmentRefT } from '@talos-app/protocol'
import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
} from 'react'
import { type TalosClient, TalosClientError } from '../../lib/client.ts'
import { getPlatform } from '../../lib/platform.ts'
import { MAX_MESSAGE_CHARS } from '../../lib/socketClient.ts'
import type { Storage as AppStorage } from '../../lib/storage.ts'
import type { useSessionController } from '../session/store.ts'
import type { ReplyTarget } from './composerStore.ts'
import { type Chip, composerResets, saveDraft, useComposerStore } from './composerStore.ts'

export type Note = { kind: 'ok' | 'pending' | 'error'; text: string }

/** False once the owner has left this thread: a send still in flight then reports through the store, not this box. */
export function useThreadAlive(threadId: string): MutableRefObject<boolean> {
  const alive = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: threadId re-arms the flag when the box is reused for another thread
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [threadId])
  return alive
}

export function useComposerSend(o: {
  client: TalosClient
  storage: AppStorage
  threadId: string
  text: string
  taRef: RefObject<HTMLTextAreaElement | null>
  chips: Chip[]
  setChips: (next: Chip[] | ((cur: Chip[]) => Chip[])) => void
  replyTarget: ReplyTarget | undefined
  setReplyTo: (threadId: string, target: ReplyTarget | undefined) => void
  session: ReturnType<typeof useSessionController>
  setText: Dispatch<SetStateAction<string>>
  setError: Dispatch<SetStateAction<string | null>>
  setNote: Dispatch<SetStateAction<Note | null>>
  /** The "not sent" note is showing. */
  leftNote: MutableRefObject<boolean>
  alive: MutableRefObject<boolean>
  keepFocus: () => void
  emptyBox: () => void
}) {
  const {
    client,
    storage,
    threadId,
    text,
    taRef,
    chips,
    setChips,
    replyTarget,
    setReplyTo,
    session,
    setText,
    setError,
    setNote,
    leftNote,
    alive,
    keepFocus,
    emptyBox,
  } = o
  const ready = chips.filter((c) => c.state === 'ready' && c.ref)
  const uploading = chips.some((c) => c.state === 'uploading')
  const tooLong = text.length > MAX_MESSAGE_CHARS
  const canSend = (text.trim().length > 0 || ready.length > 0) && !uploading

  // biome-ignore lint/correctness/useExhaustiveDependencies: refs and state setters are stable; the list is kept as it was
  const send = useCallback(async () => {
    const sentText = taRef.current?.value ?? text
    if (!((sentText.trim().length > 0 || ready.length > 0) && !uploading)) return
    // Over the protocol's cap: nothing is cleared or queued (a retry could never work). The box offers "Send as a text file".
    if (sentText.trim().length > MAX_MESSAGE_CHARS) return
    const attachments = ready.map((c) => c.ref as AttachmentRefT)
    const body = sentText.trim()
    // CC-C3: /compact, /clear, /model x ... typed out run as session controls when the mod's list knows them.
    const typed = ready.length === 0 ? session.typed(threadId, body) : null
    if (typed) {
      emptyBox()
      setText('')
      void saveDraft(storage, threadId, '')
      const o = await typed()
      setNote(o)
      if (o.kind === 'error' && o.local) setText((cur) => (cur.trim() ? `${sentText}\n\n${cur}` : sentText))
      return
    }
    const sentChips = chips
    const resetsAtStart = composerResets()
    // A photo that failed to upload is not sent, and must not vanish unseen: it stays, with a line saying so.
    const left = chips.filter((c) => c.state === 'error')
    setError(null)
    emptyBox()
    setText('')
    setChips(left)
    if (left.length > 0) {
      leftNote.current = true
      setNote({
        kind: 'error',
        text:
          left.length === 1
            ? "A file didn't upload and was not sent. Remove it or add it again."
            : `${left.length} files didn't upload and were not sent. Remove them or add them again.`,
      })
    }
    void saveDraft(storage, threadId, '')
    getPlatform().haptic('light')
    keepFocus()
    try {
      await client.sendMessage({
        threadId,
        text: body,
        attachments,
        ...(replyTarget ? { replyTo: replyTarget.id } : {}),
      })
      if (replyTarget) setReplyTo(threadId, undefined)
    } catch (e) {
      // A sign-out wiped the composer while this was in flight: its words are not given back.
      if (composerResets() !== resetsAtStart) return
      const message =
        e instanceof TalosClientError && e.code === 'too_large'
          ? e.message
          : "Couldn't send. Your message is still here."
      if (!alive.current) {
        // The owner left the thread while this was in flight: this box is gone. The words wait in the store for the
        // thread's box to take, with the failure line (see the effect that takes them).
        setChips((cur) => [...sentChips, ...cur.filter((c) => !sentChips.some((s) => s.key === c.key))])
        useComposerStore.getState().addSendFailure(threadId, sentText, message)
        return
      }
      // Nothing was queued: give the words back without losing what was typed while it was in flight. A merged text
      // over the cap just stays in the box for the owner to trim.
      setText((cur) => (cur.trim() ? `${sentText}\n\n${cur}` : sentText))
      // Chips attached while the send was in flight stay too.
      setChips((cur) => [...sentChips, ...cur.filter((c) => !sentChips.some((s) => s.key === c.key))])
      setError(message)
    }
    keepFocus()
  }, [
    ready,
    uploading,
    text,
    chips,
    storage,
    threadId,
    client,
    keepFocus,
    emptyBox,
    session,
    setChips,
    replyTarget,
    setReplyTo,
  ])

  return { send, ready, uploading, tooLong, canSend }
}
