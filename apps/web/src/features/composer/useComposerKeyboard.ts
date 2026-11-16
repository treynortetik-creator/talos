// Keys in the box: the `/` picker takes its keys first; Enter sends on a desktop keyboard (Shift+Enter is a newline, and
// on a phone Enter is always a newline).

import { type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction, useRef } from 'react'
import type { Storage as AppStorage } from '../../lib/storage.ts'
import type { PickerItem, useSlashPicker } from '../session/SlashPicker.tsx'
import { loadDraft, saveDraft } from './composerStore.ts'
import type { Note } from './useComposerSend.ts'

export function useComposerKeyboard(o: {
  picker: ReturnType<typeof useSlashPicker>
  storage: AppStorage
  threadId: string
  taRef: RefObject<HTMLTextAreaElement | null>
  setText: Dispatch<SetStateAction<string>>
  setNote: Dispatch<SetStateAction<Note | null>>
  send: () => Promise<void>
}) {
  const { picker, storage, threadId, taRef, setText, setNote, send } = o
  // The thread the box shows now. A picked command can take minutes at the Mac; by then the box may be another thread's.
  const threadNow = useRef(threadId)
  threadNow.current = threadId
  const choose = async (item: PickerItem) => {
    const before = taRef.current?.value ?? ''
    const r = await picker.pick(item)
    // What the pick does to the box applies only to the words it was picked from. Anything written while it ran stays,
    // and so does its draft.
    const sameBox = threadNow.current === threadId && taRef.current !== null
    const untouched = sameBox && taRef.current?.value === before
    if (r.fillText !== undefined) {
      if (untouched) {
        setText(r.fillText)
        taRef.current?.focus()
      }
    } else if (r.clearText) {
      if (untouched) {
        setText('')
        void saveDraft(storage, threadId, '')
      } else if (!sameBox) {
        // The owner left this thread while it ran: its box is gone, so only a stored draft that is still the picked
        // words is cleared.
        const stored = await loadDraft(storage, threadId).catch(() => null)
        if (stored === before) void saveDraft(storage, threadId, '')
      }
    }
    // The answer belongs to the thread it was picked in; it is not shown in another thread's box.
    if (!sameBox) return
    // A sent message shows in the timeline; only controls and refusals need a line here.
    setNote(r.note && r.note.text !== 'Sent.' ? r.note : null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!e.nativeEvent.isComposing && picker.onKey(e.key, (it) => void choose(it))) {
      e.preventDefault()
      return
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
    if (window.matchMedia?.('(pointer: coarse)').matches) return // soft keyboards: Enter is a newline
    e.preventDefault()
    void send()
  }
  return { choose, onKeyDown }
}
