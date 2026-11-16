// What the fake relay refuses when a connection is made or its credentials are saved, as the real one does
// (apps/relay/src/hooks/api.ts splitFields and missingRequired): an unknown field, a value its pattern refuses, a Slack
// identity sent after the connection exists, and a required field still missing. So the wizard's error paths run in fake
// mode and in tests, not only against a real relay.
import type { SetupSpecT } from '@talos-app/protocol'

/** Setup values that are not wizard fields (plain): Slack's identity (only when made) and bot user id. */
const SETUP_EXTRA: Partial<Record<string, Record<string, { pattern: RegExp; createOnly?: boolean }>>> = {
  slack: {
    identity: { pattern: /^(owner|bot)$/, createOnly: true },
    bot_user_id: { pattern: /^[UW][A-Z0-9]{2,20}$/ },
  },
}

export type FieldCheck =
  | { ok: true; extra: Record<string, string>; secrets: Record<string, string> }
  | { ok: false; error: string }

export function checkFields(spec: SetupSpecT | undefined, fields: Record<string, string>, create: boolean): FieldCheck {
  const extra: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  const specs = new Map((spec?.connect ?? []).flatMap((s) => (s.type === 'field' ? ([[s.key, s]] as const) : [])))
  const plain = (spec && SETUP_EXTRA[spec.id]) ?? {}
  for (const [k, v] of Object.entries(fields)) {
    const p = Object.hasOwn(plain, k) ? plain[k] : undefined
    if (p && !specs.has(k)) {
      if (p.createOnly && !create) return { ok: false, error: `${k} is set when the connection is made` }
      if (v === '') continue
      if (!p.pattern.test(v)) return { ok: false, error: `${k} does not look right` }
      extra[k] = v
      continue
    }
    const f = specs.get(k)
    if (!f) return { ok: false, error: `unknown field: ${k.slice(0, 40)}` }
    if (v === '') continue
    if (v.length > 2000) return { ok: false, error: `${k} is too long` }
    if (f.pattern && !new RegExp(f.pattern).test(v)) return { ok: false, error: `${k} does not look right` }
    ;(f.secret ? secrets : extra)[k] = v
  }
  return { ok: true, extra, secrets }
}

/** The first required field (help not starting with "Optional") not yet given, or null. */
export function missingRequired(spec: SetupSpecT | undefined, have: Set<string>): string | null {
  for (const s of spec?.connect ?? [])
    if (s.type === 'field' && !/^optional/i.test(s.help ?? '') && !have.has(s.key)) return s.key
  return null
}
