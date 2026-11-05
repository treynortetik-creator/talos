// Which phone panel is open. The header buttons and the edge swipes both write here, so there is one source of truth.
import { create } from 'zustand'

export type PhonePanel = 'menu' | 'session' | null

/** `path` is where the panel was opened: a panel closes when the screen under it changes, not when a late render catches up. */
export const usePhonePanel = create<{
  open: PhonePanel
  path: string
  /** The thread on screen: ThreadView publishes it, so /t/:id and /card/:id (a push lands there) behave the same. */
  thread: string | null
  setThread: (id: string | null) => void
  set: (p: PhonePanel) => void
}>((set) => ({
  open: null,
  path: '',
  thread: null,
  setThread: (thread) => set({ thread }),
  set: (open) => set({ open, path: typeof location === 'undefined' ? '' : location.pathname }),
}))
