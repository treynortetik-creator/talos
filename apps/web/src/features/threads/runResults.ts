// What the Mac app said became of each pane Run (`run_result`), by the Run's message id. The shell is the only writer; the Run
// control reads its own tap's. Cleared when the page signs out. Holds ids and a fixed reason, never any text of a script.
import type { RUN_RESULT_REASONS } from '@talos-app/protocol'
import { create } from 'zustand'

export type RunResult = { ok: boolean; reason?: (typeof RUN_RESULT_REASONS)[number] }

/** Enough for every tap in a long session; the oldest go first. */
const KEEP = 100

export type RunResultsState = { byId: Record<string, RunResult>; reset(): void }

export const useRunResults = create<RunResultsState>((set) => ({ byId: {}, reset: () => set({ byId: {} }) }))

export function setRunResult(id: string, r: RunResult): void {
  useRunResults.setState((s) => {
    const next = { ...s.byId, [id]: r.reason ? { ok: r.ok, reason: r.reason } : { ok: r.ok } }
    const ids = Object.keys(next)
    for (const old of ids.slice(0, Math.max(0, ids.length - KEEP))) delete next[old]
    return { byId: next }
  })
}
