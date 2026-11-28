// The last pane lines of a quiet session (protocol quiet-lines.ts), held by the id of the notice they belong to. Memory only, on purpose: they
// are never put in the thread's rows, the saved cache or storage, so a reload shows the notice alone. A few are kept (the oldest go).
import { create } from 'zustand'

const KEEP = 40

type QuietLinesState = {
  byMessage: Record<string, string[]>
  set(messageId: string, lines: string[]): void
  clear(): void
}

export const useQuietLines = create<QuietLinesState>((set) => ({
  byMessage: {},
  set: (messageId, lines) =>
    set((s) => {
      const next = { ...s.byMessage, [messageId]: lines }
      const ids = Object.keys(next)
      for (const old of ids.slice(0, Math.max(0, ids.length - KEEP))) delete next[old]
      return { byMessage: next }
    }),
  clear: () => set({ byMessage: {} }),
}))
