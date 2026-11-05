// Per-connection filters (spec 7.3): module toggles first, then the owner's advanced rules. The first advanced rule that
// matches decides (keep rescues an event a toggle would drop, drop removes one); with no match the toggles decide.

import type { IntegrationModule, NormalizeConnection } from '@talos-app/integrations'
import { moduleExtras } from '@talos-app/integrations'
import type { NormalizedEventT } from '@talos-app/protocol'
import { z } from 'zod'
import type { AdvancedFilter } from './types.ts'

export const AdvancedFilterSchema = z.object({
  field: z.enum(['kind', 'title', 'summary', 'url', 'actor.name', 'actor.id', 'actor.email', 'priority']),
  op: z.enum(['equals', 'contains', 'matches', 'in']),
  value: z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]),
  effect: z.enum(['keep', 'drop']),
})
export const AdvancedFilters = z.array(AdvancedFilterSchema).max(30)

function fieldValue(e: NormalizedEventT, field: string): string {
  switch (field) {
    case 'actor.name':
      return e.actor.name ?? ''
    case 'actor.id':
      return e.actor.id ?? ''
    case 'actor.email':
      return e.actor.email ?? ''
    case 'url':
      return e.url ?? ''
    case 'kind':
    case 'title':
    case 'summary':
    case 'priority':
      return e[field]
    default:
      return ''
  }
}

function matches(f: AdvancedFilter, e: NormalizedEventT): boolean {
  const v = fieldValue(e, f.field).slice(0, 500)
  const lower = v.toLowerCase()
  switch (f.op) {
    case 'equals':
      return typeof f.value === 'string' && lower === f.value.toLowerCase()
    case 'contains':
      return typeof f.value === 'string' && lower.includes(f.value.toLowerCase())
    case 'in':
      return Array.isArray(f.value) && f.value.some((x) => x.toLowerCase() === lower)
    case 'matches':
      try {
        return typeof f.value === 'string' && new RegExp(f.value.slice(0, 200), 'i').test(v)
      } catch {
        return false
      }
  }
}

export function defaultToggles(module: IntegrationModule): Record<string, boolean> {
  return Object.fromEntries(module.setup.filters.map((f) => [f.key, f.default]))
}

/** Toggle state with defaults filled in. Unknown keys are ignored. */
export function effectiveToggles(module: IntegrationModule, stored: Record<string, boolean>): Record<string, boolean> {
  const out = defaultToggles(module)
  for (const k of Object.keys(out)) if (typeof stored[k] === 'boolean') out[k] = stored[k] as boolean
  return out
}

/** The connection as a normalizer sees it: `extra` plus `filter:<key>` = '1' | '0' for every toggle. */
export function withToggleState(conn: NormalizeConnection, toggles: Record<string, boolean>): NormalizeConnection {
  const extra = { ...conn.extra }
  for (const [k, v] of Object.entries(toggles)) extra[`filter:${k}`] = v ? '1' : '0'
  return { ...conn, extra }
}

export function keepEvent(
  module: IntegrationModule,
  event: NormalizedEventT,
  toggles: Record<string, boolean>,
  advanced: AdvancedFilter[],
  conn: NormalizeConnection,
): boolean {
  for (const rule of advanced) if (matches(rule, event)) return rule.effect === 'keep'
  const toggle = moduleExtras(module).toggle
  if (!toggle) return true
  for (const [key, enabled] of Object.entries(toggles)) if (!toggle(key, enabled, event, conn)) return false
  return true
}
