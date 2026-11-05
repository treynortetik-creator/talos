// Attachments: the + menu and its file inputs, files dropped on the chat, pasted images, and the over-the-cap text sent as
// a .txt file.

import { ownValue } from '@talos-app/protocol'
import {
  type ChangeEvent,
  type ClipboardEvent,
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { TalosClient } from '../../lib/client.ts'
import { coarsePointer, hasKeyboardPlugin } from '../../lib/native.ts'
import type { Storage as AppStorage } from '../../lib/storage.ts'
import { composerResets, EMPTY_CHIPS, removeChip, saveDraft, uploadChip, useComposerStore } from './composerStore.ts'

export function useComposerAttachments(o: {
  client: TalosClient
  storage: AppStorage
  threadId: string
  text: string
  taRef: RefObject<HTMLTextAreaElement | null>
  setText: Dispatch<SetStateAction<string>>
}) {
  const { client, storage, threadId, text, taRef, setText } = o
  // The + menu. Its three file inputs live OUTSIDE the popover (always mounted): the menu closes the moment a choice is
  // made, and an input unmounted with it would never deliver the picked files (iOS returns from the picker later).
  const [menuOpen, setMenuOpen] = useState(false)
  const pickers = {
    photos: useRef<HTMLInputElement>(null),
    camera: useRef<HTMLInputElement>(null),
    files: useRef<HTMLInputElement>(null),
  }
  const choseOnce = useRef(false) // a choice closed the menu: Radix must not hand focus back to the + button

  const attach = async (files: FileList | File[] | null) => {
    if (!files) return
    const resetsAtStart = composerResets()
    for (const file of Array.from(files)) {
      if (composerResets() !== resetsAtStart) return // a sign-out wiped the composer: the rest are not attached
      await uploadChip(client, threadId, file)
    }
  }
  // A paste over the cap: the text goes up as a .txt attachment, the box keeps it until that has arrived.
  const chipsNow = () => ownValue(useComposerStore.getState().chips, threadId) ?? EMPTY_CHIPS
  const sendAsFile = async () => {
    const body = taRef.current?.value ?? text
    const file = new File([body], 'message.txt', { type: 'text/plain' })
    // A text file left over from an earlier try (failed) is replaced, not added to: two copies of the paste is never wanted.
    for (const c of chipsNow().filter((x) => x.fromText !== undefined)) removeChip(threadId, c.key)
    if (await uploadChip(client, threadId, file, undefined, body)) clearIfUnchanged(body)
  }
  /** The text went up as a file: empty the box, unless the owner has changed the words since. */
  const clearIfUnchanged = (body: string) => {
    if ((taRef.current?.value ?? '') !== body) return
    setText('')
    void saveDraft(storage, threadId, '')
  }
  // Files dropped anywhere on the chat (see DropZone) come in through the same flow as the + button.
  const dropped = useComposerStore((s) => ownValue(s.dropped, threadId))
  const takeDropped = useComposerStore((s) => s.takeDropped)
  // biome-ignore lint/correctness/useExhaustiveDependencies: attach reads fresh state through setChips only
  useEffect(() => {
    if (dropped && dropped.length > 0) void attach(takeDropped(threadId))
  }, [dropped, takeDropped, threadId])
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    let imgs: File[] = []
    try {
      imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
    } catch {
      // A lazily rendered clipboard (dictation tools) can refuse the file list: it is plain text, let the box take it.
    }
    if (imgs.length > 0) {
      e.preventDefault()
      void attach(imgs)
      return
    }
    // Insert plain text ourselves, synchronously. Chrome's default paste re-reads the system clipboard and silently
    // drops the insert if it changed meanwhile, which dictation tools do (they restore the old clipboard right after).
    let pasted = ''
    try {
      pasted = e.clipboardData.getData('text/plain')
    } catch {
      // Unreadable clipboard: leave it to the browser's default paste.
    }
    if (pasted === '') return
    e.preventDefault()
    const ta = e.currentTarget
    ta.setRangeText(pasted, ta.selectionStart, ta.selectionEnd, 'end')
    setText(ta.value) // the auto-grow effect runs off `text`
  }
  // The picker is over (files chosen or dismissed): the menu is closed, and typing continues in the box.
  // biome-ignore lint/correctness/useExhaustiveDependencies: taRef is stable; the list is kept as it was
  const pickerDone = useCallback(() => {
    setMenuOpen(false)
    // In the shell the plugin resizes the view with the keyboard, so refocusing is measured safe. Elsewhere on touch
    // (Safari, Home Screen) the refocus is unmeasured and main does not do it: skip it. Desktop keeps it.
    if (hasKeyboardPlugin() || !coarsePointer()) taRef.current?.focus({ preventScroll: true })
  }, [])
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    void attach(e.target.files)
    e.target.value = ''
    pickerDone()
  }
  const choosePicker = (which: keyof typeof pickers) => {
    choseOnce.current = true
    setMenuOpen(false)
    pickers[which].current?.click() // inside the tap, or iOS refuses to open the picker
  }
  // `cancel` fires on a dismissed picker (Safari 16.4+, Chromium); nothing else reports it. The inputs are unmounted
  // while a voice note is locked and come back new, so the listener goes on through the ref, every time one mounts.
  const pickerRef = (which: keyof typeof pickers) => (n: HTMLInputElement | null) => {
    pickers[which].current = n
    n?.addEventListener('cancel', pickerDone) // same function, same node: adding twice is a no-op
  }

  return { menuOpen, setMenuOpen, choseOnce, sendAsFile, clearIfUnchanged, onPaste, onPick, choosePicker, pickerRef }
}
