// Composer drafts live in IndexedDB per thread and are emptied with the rest of the device's data when a session ends (an
// expiry included; only the queued messages survive that). What this store holds in memory (words of a failed send, a
// prefill, dropped files, attachments, a quote) is emptied on every session end, whatever the reason. Other features (the
// inbox item sheet's "Ask <agent>") prefill a thread's composer through `prefillComposer`.
import type { AttachmentRefT } from '@talos-app/protocol'
import { ownValue } from '@talos-app/protocol'
import { create } from 'zustand'
import type { TalosClient } from '../../lib/client.ts'
import { MAX_UPLOAD_BYTES } from '../../lib/socketClient.ts'
import type { Storage } from '../../lib/storage.ts'
import { tooBigNote, uploadFailureNote } from './uploadError.ts'

/** One attachment waiting to be sent. Kept per thread, outside the component, so a thread switch loses nothing. */
export type Chip = {
  key: string
  name: string
  state: 'uploading' | 'ready' | 'error'
  ref?: AttachmentRefT
  note?: string
  /** 0..1 while uploading (only when the client reports it). */
  progress?: number
  /** The bytes, kept so a failed upload can be retried. Not stored anywhere durable. */
  file?: File
  /** Set when this file is a message too long for the box ("Send as a text file"): the words it was made from. */
  fromText?: string
}
export type SendFailure = { texts: string[]; message: string }
export type Prefill = { text: string; mode: 'replace' | 'append' }
/** What a message is quoting: its id (sent as `reply_to`) and a short excerpt to show. */
export type ReplyTarget = { id: string; author: 'owner' | 'agent' | 'other'; excerpt: string }

type State = {
  prefill: Record<string, Prefill | undefined>
  /** `append` adds the text after what is already in the box (Edit on a failed message); the default replaces it. */
  prefillComposer(threadId: string, text: string, mode?: 'replace' | 'append'): void
  consumePrefill(threadId: string): Prefill | undefined
  /** Files dropped on the chat, waiting for that thread's composer to take them through its attach flow. */
  dropped: Record<string, File[]>
  dropFiles(threadId: string, files: File[]): void
  takeDropped(threadId: string): File[]
  chips: Record<string, Chip[]>
  setChips(threadId: string, next: Chip[] | ((cur: Chip[]) => Chip[])): void
  /** Sends that failed after the owner left their thread: the words in the order the sends failed, and the failure line. */
  sendFailure: Record<string, SendFailure | undefined>
  addSendFailure(threadId: string, text: string, message: string): void
  /** The thread's box takes the failed words and the line; they are not kept after that. */
  takeSendFailure(threadId: string): SendFailure | undefined
  replyTo: Record<string, ReplyTarget | undefined>
  setReplyTo(threadId: string, target: ReplyTarget | undefined): void
}

export const useComposerStore = create<State>((set, get) => ({
  prefill: {},
  prefillComposer(threadId, text, mode = 'replace') {
    set((s) => ({ prefill: { ...s.prefill, [threadId]: { text, mode } } }))
  },
  dropped: {},
  dropFiles(threadId, files) {
    if (files.length === 0) return
    set((s) => ({ dropped: { ...s.dropped, [threadId]: [...(ownValue(s.dropped, threadId) ?? []), ...files] } }))
  },
  takeDropped(threadId) {
    const v = ownValue(get().dropped, threadId) ?? []
    if (v.length > 0) set((s) => ({ dropped: { ...s.dropped, [threadId]: [] } }))
    return v
  },
  chips: {},
  setChips(threadId, next) {
    set((s) => {
      const cur = ownValue(s.chips, threadId) ?? []
      const v = typeof next === 'function' ? next(cur) : next
      return { chips: { ...s.chips, [threadId]: v } }
    })
  },
  sendFailure: {},
  addSendFailure(threadId, text, message) {
    set((s) => ({
      sendFailure: {
        ...s.sendFailure,
        [threadId]: { texts: [...(ownValue(s.sendFailure, threadId)?.texts ?? []), text], message },
      },
    }))
  },
  takeSendFailure(threadId) {
    const v = ownValue(get().sendFailure, threadId)
    if (v !== undefined) set((s) => ({ sendFailure: { ...s.sendFailure, [threadId]: undefined } }))
    return v
  },
  replyTo: {},
  setReplyTo(threadId, target) {
    set((s) => ({ replyTo: { ...s.replyTo, [threadId]: target } }))
  },
  consumePrefill(threadId) {
    const v = ownValue(get().prefill, threadId)
    if (v !== undefined) set((s) => ({ prefill: { ...s.prefill, [threadId]: undefined } }))
    return v
  },
}))
/** Counts the wipes of the composer. A send or an attach loop notes it when it starts and gives up if it has changed. */
let resets = 0
export const composerResets = (): number => resets
/** A session end: nothing the previous owner put in a box (words, files, quotes) outlives the session. */
export const resetComposer = () => {
  resets++
  useComposerStore.setState(useComposerStore.getInitialState(), true)
}
export const prefillComposer = (threadId: string, text: string, mode?: 'replace' | 'append') =>
  useComposerStore.getState().prefillComposer(threadId, text, mode)

export async function loadDraft(storage: Storage, threadId: string): Promise<string> {
  return (await storage.get<string>('drafts', threadId)) ?? ''
}
export async function saveDraft(storage: Storage, threadId: string, text: string): Promise<void> {
  if (text) await storage.put('drafts', threadId, text)
  else await storage.del('drafts', threadId)
}

export const EMPTY_CHIPS: Chip[] = []

const aborts = new Map<string, AbortController>()

/** Uploads one file into a thread's chips. Resolves true when it is ready; false when it failed or was cancelled. */
export async function uploadChip(
  client: TalosClient,
  threadId: string,
  file: File,
  existingKey?: string,
  fromText?: string,
): Promise<boolean> {
  const { setChips } = useComposerStore.getState()
  const key = existingKey ?? `${file.name}-${Date.now()}-${Math.random()}`
  const patch = (p: Partial<Chip>) => setChips(threadId, (c) => c.map((x) => (x.key === key ? { ...x, ...p } : x)))
  if (file.size > MAX_UPLOAD_BYTES) {
    const chip: Chip = { key, name: file.name, state: 'error', note: tooBigNote(), ...(fromText ? { fromText } : {}) }
    setChips(threadId, (c) => (existingKey ? c.map((x) => (x.key === key ? chip : x)) : [...c, chip]))
    return false
  }
  const chip: Chip = {
    key,
    name: file.name,
    state: 'uploading',
    progress: 0,
    file,
    ...(fromText ? { fromText } : {}),
  }
  setChips(threadId, (c) => (existingKey ? c.map((x) => (x.key === key ? chip : x)) : [...c, chip]))
  const ctl = new AbortController()
  aborts.set(key, ctl)
  try {
    const ref = await client.uploadMedia(file, {
      name: file.name,
      signal: ctl.signal,
      onProgress: (f) => patch({ progress: f }),
    })
    if (ctl.signal.aborted) return false
    patch({ state: 'ready', ref, progress: 1 })
    return true
  } catch (e) {
    if (ctl.signal.aborted) return false // cancelled: the chip is already gone
    const note = uploadFailureNote(e)
    patch({ state: 'error', ...(note ? { note } : {}) })
    return false
  } finally {
    aborts.delete(key)
  }
}

/** Removes a chip; an upload still in flight is cancelled. */
export function removeChip(threadId: string, key: string): void {
  aborts.get(key)?.abort()
  aborts.delete(key)
  useComposerStore.getState().setChips(threadId, (c) => c.filter((x) => x.key !== key))
}
