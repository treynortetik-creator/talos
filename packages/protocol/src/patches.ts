// RFC 7386 JSON merge patch and the config.patch allowlist walk (spec 3.4). Shared by the bridge (enforces), the web
// app (builds) and the testkit fakes, so all of them agree on which paths a patch may touch.
import { IntegrationId } from './ids.ts'
import {
  PHONE_PATCH_ENTRIES,
  SESSION_STEPUP_TOP_FIELDS,
  STEPUP_ON_TRUE_TOP_FIELDS,
  WORK_STEPUP_PATHS,
} from './settings-table.ts'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * RFC 7386 MergePatch. Objects merge recursively, `null` deletes a key, arrays and scalars replace. Never mutates its
 * inputs, and drops `__proto__` / `constructor` / `prototype` keys outright, so a caller that skips checkConfigPatch
 * still can't write them.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch
  const out: Record<string, unknown> = isObject(target) ? { ...target } : {}
  for (const k of UNSAFE_KEYS) delete out[k]
  for (const [k, v] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(k)) continue
    if (v === null) {
      delete out[k]
    } else {
      Object.defineProperty(out, k, {
        value: applyMergePatch(out[k], v),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
  }
  return out
}

export type ConfigPatchCheck =
  | { ok: true; touchesWorkEnabled: boolean; stepupPurpose?: 'config:session'; turnsOnTrust?: true }
  | { ok: false; path: string }

/**
 * Walks a `config.patch` against the settings table (`settings-table.ts`). A top-level entry (`agent`) allows its whole subtree; a dotted
 * entry (`work.enabled`, `work.thread`) allows only that leaf. Returns the first forbidden path
 * (the bridge answers `config_field_forbidden`) and whether the patch touches `work.enabled` or `work.retention` (needs step-up
 * `config:work`). `stepupPurpose: 'config:session'` is set when the patch touches a setting the table marks `config:session`
 * (docs/CLAUDE-CODE.md C3.6). A patch that would need both step-ups is refused at the session path, since one step-up
 * token carries one purpose: send them separately. `trust_mode` is a boolean (or null) that needs the session step-up only
 * when set to `true`: that sets `turnsOnTrust`, which a relay must honour even with trust mode already on (the copy of
 * the Mac's config it holds can be stale). Any other value for it is refused.
 */
export function checkConfigPatch(patch: unknown): ConfigPatchCheck {
  if (!isObject(patch)) return { ok: false, path: '' }
  const whole = new Set<string>()
  const leaves = new Map<string, Set<string>>()
  for (const entry of PHONE_PATCH_ENTRIES) {
    const dot = entry.indexOf('.')
    if (dot < 0) whole.add(entry)
    else {
      const top = entry.slice(0, dot)
      if (!leaves.has(top)) leaves.set(top, new Set())
      leaves.get(top)?.add(entry.slice(dot + 1))
    }
  }
  let touchesWorkEnabled = false
  for (const [k, v] of Object.entries(patch)) {
    if (whole.has(k)) continue
    const allowed = leaves.get(k)
    if (!allowed || !isObject(v)) return { ok: false, path: k } // includes `null`, which would delete the whole section
    for (const sub of Object.keys(v)) {
      if (!allowed.has(sub)) return { ok: false, path: `${k}.${sub}` }
    }
    // a work list is written strictly: every entry is an id this build knows
    if (k === 'work' && 'enabled' in v) {
      const e = (v as Record<string, unknown>).enabled
      const known = (x: unknown) => IntegrationId.safeParse(x).success
      if (e !== null && (!Array.isArray(e) || !e.every(known))) return { ok: false, path: 'work.enabled' }
    }
    // what leaves a work system and how long the relay keeps it: both need the work step-up
    if (WORK_STEPUP_PATHS.some((p) => p.startsWith(`${k}.`) && p.slice(k.length + 1) in v)) touchesWorkEnabled = true
  }
  let turnsOnTrust = false
  for (const k of STEPUP_ON_TRUE_TOP_FIELDS) {
    if (!(k in patch)) continue
    const v = patch[k]
    if (v !== null && typeof v !== 'boolean') return { ok: false, path: k }
    if (v === true) turnsOnTrust = true
  }
  const session = Object.keys(patch).find((k) => SESSION_STEPUP_TOP_FIELDS.includes(k))
  const sessionPath =
    session ?? (turnsOnTrust ? (STEPUP_ON_TRUE_TOP_FIELDS.find((k) => patch[k] === true) ?? '') : undefined)
  if (sessionPath !== undefined && touchesWorkEnabled) return { ok: false, path: sessionPath }
  if (sessionPath !== undefined)
    return {
      ok: true,
      touchesWorkEnabled,
      stepupPurpose: 'config:session',
      ...(turnsOnTrust ? { turnsOnTrust: true as const } : {}),
    }
  return { ok: true, touchesWorkEnabled }
}

/**
 * Thread-level patch semantics for a `config.patch` that carries `threads` (docs/THREADS.md). The array replaces the
 * list (order, membership), but inside a thread that already exists a key the client left out keeps its current value,
 * so an older app that doesn't know `color` or `topic` can't wipe them by editing something else. A key sent as `null`
 * is cleared. Never mutates its inputs; non-object entries are passed through for the schema to refuse.
 */
export function resolveThreadsPatch(current: readonly unknown[], patched: unknown): unknown {
  if (!Array.isArray(patched)) return patched
  const byId = new Map<string, Record<string, unknown>>()
  for (const t of current) if (isObject(t) && typeof t.id === 'string') byId.set(t.id, t)
  return patched.map((t) => {
    if (!isObject(t)) return t
    const was = typeof t.id === 'string' ? byId.get(t.id) : undefined
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(was ?? {})) if (!UNSAFE_KEYS.has(k) && !(k in t)) out[k] = v
    for (const [k, v] of Object.entries(t)) if (!UNSAFE_KEYS.has(k) && v !== null) out[k] = v
    return out
  })
}

/** Patch-time rules the stored-config check can't take (a config that already breaks them must still load). */
export function threadPatchIssue(config: {
  threads: ReadonlyArray<{ id: string; archived: boolean }>
  default_thread: string
}): string | null {
  const d = config.threads.find((t) => t.id === config.default_thread)
  if (d?.archived) return "the default thread can't be archived: make another thread the default first"
  return null
}
