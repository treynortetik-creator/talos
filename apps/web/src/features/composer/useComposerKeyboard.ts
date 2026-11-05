// Keys in the box: the `/` picker takes its keys first; Enter sends on a desktop keyboard (Shift+Enter is a newline, and
// on a phone Enter is always a newline).

import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react'
import type { Storage as AppStorage } from '../../lib/storage.ts'
import type { PickerItem, useSlashPicker } from '../session/SlashPicker.tsx'
import { saveDraft } from './composerStore.ts'
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
  const choose = async (item: PickerItem) => {
    const r = await picker.pick(item)
    if (r.fillText !== undefined) {
      setText(r.fillText)
      taRef.current?.focus()
    } else if (r.clearText) {
      setText('')
      void saveDraft(storage, threadId, '')
    }
    // A sent message shows in the timeline; only controls and refusals need a line here.
    setNote(r.note && r.note.text !== 'Sent.' ? r.note : null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!e.nativeEvent.isComposing && picker.onKey(e.key, (it) => void choose(it))) {
      e.preventDefault()
      return
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    if (window.matchMedia?.('(pointer: coarse)').matches) return // soft keyboards: Enter is a newline
    e.preventDefault()
    void send()
  }
  return { choose, onKeyDown }
}
