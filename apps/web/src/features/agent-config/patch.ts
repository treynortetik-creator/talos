// Draft ⇄ config.patch for the Agent settings section. Pure: builds an RFC 7386 merge patch that touches only
// allowlisted fields (CONFIG_PATCH_ALLOWLIST) and only what the owner actually changed.
import {
  type AgentConfigT,
  applyMergePatch,
  checkConfigPatch,
  isIanaZone,
  isInheritedName,
  type ThreadT,
} from '@talos-app/protocol'

export type AgentDraft = {
  agentName: string
  ownerName: string
  defaultThread: string
  timezone: string
}

export function draftFromConfig(c: AgentConfigT): AgentDraft {
  return {
    agentName: c.agent.name,
    ownerName: c.owner.display_name,
    defaultThread: c.default_thread,
    timezone: c.timezone,
  }
}

/**
 * The merge patch that turns `base` into `draft`; `{}` when nothing changed. Never includes non-allowlisted keys. Threads,
 * quiet hours, voice-note replies and the work thread are no longer part of this draft: each has its
 * own home and saves at once.
 */
export function buildAgentPatch(base: AgentConfigT, draft: AgentDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (draft.agentName.trim() !== base.agent.name) patch.agent = { name: draft.agentName.trim() }
  if (draft.ownerName.trim() !== base.owner.display_name) patch.owner = { display_name: draft.ownerName.trim() }
  if (draft.defaultThread !== base.default_thread) patch.default_thread = draft.defaultThread
  if (draft.timezone !== base.timezone) patch.timezone = draft.timezone
  return patch
}

export type DraftIssues = Partial<Record<'agentName' | 'ownerName' | 'timezone', string>>

export function validateDraft(d: AgentDraft): DraftIssues {
  const issues: DraftIssues = {}
  const an = d.agentName.trim()
  if (an.length < 1 || an.length > 32) issues.agentName = 'Use 1 to 32 characters.'
  const on = d.ownerName.trim()
  if (on.length < 1 || on.length > 40) issues.ownerName = 'Use 1 to 40 characters.'
  if (!isIanaZone(d.timezone)) issues.timezone = 'Pick a timezone from the list, like UTC or Europe/Paris.'
  return issues
}

/** What the patch would produce, checked against the allowlist: the UI never sends a forbidden path. */
export function patchIsAllowed(patch: Record<string, unknown>): boolean {
  return checkConfigPatch(patch).ok
}

export function previewConfig(base: AgentConfigT, patch: Record<string, unknown>): unknown {
  return applyMergePatch(base, patch)
}

/** A thread id from a name: `^[a-z][a-z0-9_]{0,31}$`, unique among `taken`, never `all`. */
export function slugThreadId(name: string, taken: Set<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28)
  if (!/^[a-z]/.test(base)) base = `t_${base}`.replace(/_+$/, '')
  if (base === '' || base === 't') base = 'thread'
  if (isInheritedName(base)) base = `${base}_thread`
  let id = base.slice(0, 32)
  for (let n = 2; taken.has(id) || id === 'all'; n++) id = `${base.slice(0, 28)}_${n}`
  return id
}

export function newThread(name: string, existing: ThreadT[], nowIso: string): ThreadT {
  const id = slugThreadId(name, new Set(existing.map((t) => t.id)))
  return {
    id,
    name: name.trim(),
    kind: 'fixed',
    order: existing.length,
    notify: 'all',
    voice_context: 'recent',
    archived: false,
    created_at: nowIso,
  }
}

/** Renumbers `order` to match array position so the saved config order is explicit. */
export function renumber(threads: ThreadT[]): ThreadT[] {
  return threads.map((t, i) => (t.order === i ? t : { ...t, order: i }))
}

export type Rebased = { draft: AgentDraft; conflicts: string[] }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const SCALAR_LABELS: Array<[keyof AgentDraft, string]> = [
  ['agentName', 'Agent name'],
  ['ownerName', 'Your name'],
  ['defaultThread', 'Default thread'],
  ['timezone', 'Timezone'],
]

/**
 * Three-way merge of an edit in progress onto a newer config (audit D32). `base` is the config the draft started from,
 * `draft` the edits, `current` the config now. A field the owner did not change follows `current`; a field the owner did
 * change keeps the owner's value. `conflicts` names the fields that changed on both sides to different values (the owner's value wins on Save).
 * The patch Save sends is `buildAgentPatch(current, result.draft)`, so it touches only what he changed.
 */
export function rebaseDraft(base: AgentConfigT, draft: AgentDraft, current: AgentConfigT): Rebased {
  const b = draftFromConfig(base)
  const c = draftFromConfig(current)
  const conflicts: string[] = []
  const out: AgentDraft = { ...c }
  const o = out as Record<string, unknown>
  for (const [k, label] of SCALAR_LABELS) {
    if (same(draft[k], b[k])) o[k] = c[k]
    else {
      o[k] = draft[k]
      if (!same(c[k], b[k]) && !same(c[k], draft[k])) conflicts.push(label)
    }
  }
  return { draft: out, conflicts: [...new Set(conflicts)] }
}
