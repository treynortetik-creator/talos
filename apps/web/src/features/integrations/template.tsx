// Setup-step helpers: `{{VAR}}` substitution and a tiny markdown subset that builds React nodes (never HTML), so a
// catalog entry can't inject markup into the wizard.
import { HttpsUrl } from '@talos-app/protocol'
import type { ReactNode } from 'react'

export type TemplateContext = Record<string, string | undefined>

/** Fills `{{VAR}}`. Returns null when any variable has no value, so the UI can say "not available yet". */
export function fillTemplate(template: string, ctx: TemplateContext): string | null {
  let missing = false
  const out = template.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = ctx[key]
    if (v === undefined || v === '') {
      missing = true
      return ''
    }
    return v
  })
  return missing ? null : out
}

/** The value if it is a plain http(s) URL (no javascript:, no data:, no whitespace); otherwise null. */
export function safeUrl(value: string | null): string | null {
  if (!value) return null
  const r = HttpsUrl.safeParse(value)
  return r.success ? r.data : null
}

let keySeed = 0

/** `**bold**` and `` `code` `` only. Paragraphs split on blank lines. Everything else is literal text. */
export function MiniMd({ md }: { md: string }): ReactNode {
  return md.split(/\n{2,}/).map((para) => {
    const parts: ReactNode[] = []
    for (const piece of para.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
      if (!piece) continue
      keySeed += 1
      if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4)
        parts.push(<strong key={keySeed}>{piece.slice(2, -2)}</strong>)
      else if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 2)
        parts.push(
          <code key={keySeed} className="rounded bg-surface-2 px-1 font-mono text-sm">
            {piece.slice(1, -1)}
          </code>,
        )
      else parts.push(piece)
    }
    keySeed += 1
    return (
      <p key={keySeed} className="whitespace-pre-wrap text-text">
        {parts}
      </p>
    )
  })
}
