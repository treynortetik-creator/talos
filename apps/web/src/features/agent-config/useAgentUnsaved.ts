import { useEffectiveAgentDraft } from './draftStore.ts'

/** True while there are edits not saved: the section and the Agent row in the Settings list both read it. */
export function useAgentUnsaved(): boolean {
  return useEffectiveAgentDraft().edited
}
