// The Terminal screen's tabs: what the Mac app last said about the sessions (`terminal_sessions`) and what it answered to the
// last Resume press (`terminal_resume_result`). The shell is the only writer; the screen reads. It is cleared when the page
// signs out, so a signed-out page never keeps a thread's name.
import type { TerminalSessionItemT } from '@talos-app/protocol'
import { create } from 'zustand'

export type ResumeOutcome = 'asked' | 'already_pending' | 'park_pending' | 'failed'

/** One answer to a Resume/Start press, with the tab's state when it came: a later state change makes it stale. */
export type ResumeResult = { outcome: ResumeOutcome; at: number; sig: string }
const sigOf = (i: TerminalSessionItemT | undefined) => (i ? `${i.state}|${i.panel}` : '')

export type TerminalSessionsState = {
  /** null until the shell has sent a list: an older Mac app never does, and the screen shows the one terminal it always did. */
  items: TerminalSessionItemT[] | null
  /** The answers the shell gave, by thread id. One tab's answer is never shown on, or cleared by, another tab. */
  resume: Record<string, ResumeResult>
  /** The shell switched the tab itself (Ctrl+digit while its terminal held the keyboard). `n` makes a repeat count. */
  selectRequest: { id: string; n: number } | null
  setItems(items: TerminalSessionItemT[]): void
  setResume(threadId: string, outcome: ResumeOutcome): void
  clearResume(threadId: string): void
  requestSelect(id: string): void
  reset(): void
}

export const useTerminalSessions = create<TerminalSessionsState>((set, get) => ({
  items: null,
  resume: {},
  selectRequest: null,
  setItems: (items) =>
    set((st) => {
      // an answer belongs to the state the tab was in: once the tab has moved on, the answer is old news
      const kept = Object.fromEntries(
        Object.entries(st.resume).filter(([id, r]) => sigOf(items.find((i) => i.id === id)) === r.sig),
      )
      return { items, resume: Object.keys(kept).length === Object.keys(st.resume).length ? st.resume : kept }
    }),
  setResume: (threadId, outcome) =>
    set((st) => ({
      resume: {
        ...st.resume,
        [threadId]: { outcome, at: Date.now(), sig: sigOf(get().items?.find((i) => i.id === threadId)) },
      },
    })),
  clearResume: (threadId) =>
    set((st) => {
      if (!(threadId in st.resume)) return st
      const { [threadId]: _gone, ...rest } = st.resume
      return { resume: rest }
    }),
  requestSelect: (id) => set((st) => ({ selectRequest: { id, n: (st.selectRequest?.n ?? 0) + 1 } })),
  reset: () => set({ items: null, resume: {}, selectRequest: null }),
}))

/** The words under a Resume button after the shell answered. Same sentences the Terminals window uses. */
export function resumeSentence(outcome: ResumeOutcome, verb: 'resume' | 'start'): string {
  switch (outcome) {
    case 'asked':
      return `Asked to ${verb} the session. It shows here as soon as it is up.`
    case 'already_pending':
      return `A ${verb} is already waiting. It shows here as soon as the session is up.`
    case 'park_pending':
      return 'A park is pending; try again in a moment.'
    case 'failed':
      return `Couldn't ask to ${verb} the session. Send the thread a message instead.`
  }
}

const KEY = 'talos.terminal.tab'
/** The tab picked last in this window (sessionStorage is per window). Unreadable storage reads as "main". */
export function rememberedTab(): string {
  try {
    return sessionStorage.getItem(KEY) ?? 'main'
  } catch {
    return 'main'
  }
}
export function rememberTab(id: string): void {
  try {
    sessionStorage.setItem(KEY, id)
  } catch {
    // a window that cannot store simply forgets
  }
}
