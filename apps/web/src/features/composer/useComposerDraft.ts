// The box's text across time: the stored draft per thread (read on open, saved as the owner types, flushed on leaving),
// a prefill from other features, and words handed back from a send that failed after the owner left.

import { ownValue } from '@talos-app/protocol'
import { type Dispatch, type RefObject, type SetStateAction, useEffect, useRef, useState } from 'react'
import type { Storage as AppStorage } from '../../lib/storage.ts'
import { loadDraft, saveDraft, useComposerStore } from './composerStore.ts'

export function useComposerDraft(o: {
  storage: AppStorage
  threadId: string
  text: string
  setText: Dispatch<SetStateAction<string>>
  setError: Dispatch<SetStateAction<string | null>>
  taRef: RefObject<HTMLTextAreaElement | null>
}): void {
  const { storage, threadId, text, setText, setError, taRef } = o
  // Draft: restore per thread, save on change; prefill from other features.
  const unsaved = useRef<string | null>(null)
  const loaded = useRef(false)
  // The thread whose stored draft has been read. A prefill waits for it, so it lands after the draft and cannot be
  // overwritten by it (or overwrite it by being saved first).
  const [draftFor, setDraftFor] = useState<string | null>(null)
  const draftRead = draftFor === threadId
  const prefill = useComposerStore((s) => ownValue(s.prefill, threadId))
  const consume = useComposerStore((s) => s.consumePrefill)
  // biome-ignore lint/correctness/useExhaustiveDependencies: setText is a state setter; the list is kept as it was
  useEffect(() => {
    let live = true
    void loadDraft(storage, threadId)
      .catch(() => '') // an unreadable draft must not hold a prefill back forever
      .then((d) => {
        if (!live) return
        setText((cur) => cur || d)
        loaded.current = true
        setDraftFor(threadId)
      })
    return () => {
      live = false
    }
  }, [storage, threadId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: setText and taRef are stable; the list is kept as it was
  useEffect(() => {
    if (prefill !== undefined && draftRead) {
      const v = consume(threadId)
      if (v !== undefined) {
        // Append keeps a draft the owner typed meanwhile; replace is for "Ask <agent>" and the like.
        setText((cur) => (v.mode === 'append' && cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${v.text}` : v.text))
        // After the commit: focusing now fires onFocus -> syncFromDom, which reads the not-yet-updated DOM ('') and wipes the prefill
        setTimeout(() => taRef.current?.focus(), 0)
      }
    }
  }, [prefill, consume, threadId, draftRead])
  // Words from a send that failed after the owner left: they go in front of whatever the box holds now, after the draft
  // is read and after a prefill is applied (this effect comes after that one), so neither can overwrite them.
  const sendFailure = useComposerStore((s) => ownValue(s.sendFailure, threadId))
  // biome-ignore lint/correctness/useExhaustiveDependencies: setText and setError are state setters; the list is kept as it was
  useEffect(() => {
    if (sendFailure === undefined || !draftRead) return
    const f = useComposerStore.getState().takeSendFailure(threadId)
    if (!f) return
    const words = f.texts.join('\n\n')
    setText((cur) => (cur.trim() ? `${words}\n\n${cur}` : words))
    setError(f.message)
  }, [sendFailure, threadId, draftRead])
  // Saved 300 ms after the last keystroke; leaving the thread inside that window flushes it, so a draft typed just
  // before switching threads is not lost.
  useEffect(() => {
    if (loaded.current) unsaved.current = text
    const t = setTimeout(() => {
      unsaved.current = null
      void saveDraft(storage, threadId, text)
    }, 300)
    return () => clearTimeout(t)
  }, [storage, threadId, text])
  useEffect(
    () => () => {
      if (unsaved.current !== null) void saveDraft(storage, threadId, unsaved.current)
    },
    [storage, threadId],
  )
}
