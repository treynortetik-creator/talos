// M2.5: Talos tokens -> the MCP Apps style variables, resolved for the current theme and resent when it changes.
// The keys are exactly the spec's literal union (test/apps/host.test.ts checks each against the SDK's schema).

export type Theme = 'light' | 'dark'

/** [spec variable, Talos CSS token]. */
export const TOKEN_MAP: ReadonlyArray<readonly [string, string]> = [
  ['--color-background-primary', '--surface'],
  ['--color-background-secondary', '--surface-2'],
  ['--color-background-tertiary', '--bg'],
  ['--color-text-primary', '--text'],
  ['--color-text-secondary', '--text-2'],
  ['--color-border-primary', '--line'],
  ['--color-border-secondary', '--hairline'],
  ['--color-background-danger', '--danger'],
  ['--color-text-danger', '--danger'],
  ['--color-border-danger', '--danger'],
  ['--color-background-success', '--ok'],
  ['--color-text-success', '--ok'],
  ['--color-border-success', '--ok'],
  ['--color-background-warning', '--warn'],
  ['--color-text-warning', '--warn'],
  ['--color-border-warning', '--warn'],
  ['--color-background-info', '--info'],
  ['--color-text-info', '--info'],
  ['--color-border-info', '--info'],
  ['--color-ring-primary', '--focus'],
  ['--border-radius-sm', '--radius-button'],
  ['--border-radius-md', '--radius-card'],
  ['--border-radius-lg', '--radius-card'],
  ['--border-radius-full', '--radius-pill'],
]

/** Talos fonts live on the relay origin, which the frame cannot load (opaque origin, strict CSP): system stacks. */
export const FONT_VARIABLES = {
  '--font-sans': 'system-ui, -apple-system, sans-serif',
  '--font-mono': 'ui-monospace, monospace',
} as const

/** The theme in force: the owner's explicit choice (`data-theme`), else the system's. */
export function currentTheme(): Theme {
  const set = document.documentElement.dataset.theme
  if (set === 'light' || set === 'dark') return set
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Resolved values for the current theme. A token that resolves to nothing is left out (never sent as an empty string). */
export function hostVariables(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const out: Record<string, string> = {}
  for (const [spec, token] of TOKEN_MAP) {
    const v = cs.getPropertyValue(token).trim()
    if (v) out[spec] = v
  }
  Object.assign(out, FONT_VARIABLES)
  return out
}

/** Calls `cb` when the theme changes: the `data-theme` attribute, or the system preference while on "System". */
export function watchTheme(cb: () => void): () => void {
  const mo = new MutationObserver(cb)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
  mq?.addEventListener('change', cb)
  return () => {
    mo.disconnect()
    mq?.removeEventListener('change', cb)
  }
}
