// The Settings > Agent draft lives here, not in the component, so every way out of the screen (another section, the
// phone's back button, the edge swipe, a deep link) keeps the edits (audit D32). In memory only: nothing is written to
// localStorage or the stores, and `resetAgentDraft` runs from `clearLocalData`, so a sign-out cannot leave a draft behind
// for the next person on this device.
//
// The store keeps the config the draft started from (`base`), not just its revision, so a config change made anywhere
// (this device's other sections, another device, the agent) is merged under the edits instead of throwing them away.

import type { AgentConfigT } from '@talos-app/protocol'
import { useMemo, useSyncExternalStore } from 'react'
import { useTalos } from '../../lib/client.ts'
import { type AgentDraft, buildAgentPatch, rebaseDraft } from './patch.ts'

type State = {
  draft: AgentDraft | null
  base: AgentConfigT | null
  baseRev: number | null
  /** Fields that changed on both sides at the last merge. */
  conflicts: string[]
}
const EMPTY: State = { draft: null, base: null, baseRev: null, conflicts: [] }
let state: State = EMPTY
const subs = new Set<() => void>()
const emit = () => {
  for (const s of subs) s()
}

export const getAgentDraftState = (): State => state

export function setAgentDraft(draft: AgentDraft | null, base: AgentConfigT | null, conflicts: string[] = []) {
  state = { draft, base, baseRev: base?.rev ?? null, conflicts }
  emit()
}

/** Forget the draft (sign-out, revoke, a 401). */
export function resetAgentDraft() {
  if (state === EMPTY) return
  state = EMPTY
  emit()
}

export function useAgentDraftState(): State {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => void subs.delete(cb)
    },
    getAgentDraftState,
    () => EMPTY,
  )
}

/** The draft as it stands against the live config: merged when the config moved, so it is always relative to `config`. */
export function effectiveDraft(
  s: State,
  config: AgentConfigT | null,
): { draft: AgentDraft | null; conflicts: string[]; moved: boolean } {
  if (!s.draft || !s.base || !config) return { draft: s.draft, conflicts: s.conflicts, moved: false }
  if (s.base.rev === config.rev) return { draft: s.draft, conflicts: s.conflicts, moved: false }
  const r = rebaseDraft(s.base, s.draft, config)
  return { draft: r.draft, conflicts: [...new Set([...s.conflicts, ...r.conflicts])], moved: true }
}

export function useEffectiveAgentDraft() {
  const s = useAgentDraftState()
  const config = useTalos((st) => st.config)
  const eff = useMemo(() => effectiveDraft(s, config), [s, config])
  const patch = useMemo(() => (config && eff.draft ? buildAgentPatch(config, eff.draft) : {}), [config, eff.draft])
  return { ...eff, state: s, config, patch, edited: Object.keys(patch).length > 0 }
}
