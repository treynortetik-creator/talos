// The preview on a theme card: the drafted theme applied to a small sample (a thread, the composer, a card) inside this
// box only. The tokens come from `themeDeclarations`, which rebuilds every value from the validated theme, so a crafted
// draft cannot put anything but a colour, a pixel size or a bundled font stack into `style`. The page itself is not touched
// until the owner taps Apply.
import { ConfigCardPayload, type ThemeMode } from '@talos-app/protocol'
import { type CSSProperties, useState } from 'react'
import { themeDeclarations } from '../../lib/theme.ts'
import { Button } from '../../ui/index.ts'

/** The theme a config card proposes, or null when the card is not about the theme. */
export function themeOfCard(payload: unknown): unknown | null {
  const p = ConfigCardPayload.safeParse(payload)
  return p.success ? (p.data.changes.find((c) => c.path === 'theme')?.new ?? null) : null
}

export function ThemePreview({ theme }: { theme: unknown }) {
  const [mode, setMode] = useState<ThemeMode>('light')
  const { vars, problems } = themeDeclarations(theme, mode)
  if (problems.length > 0) return <p className="m-0 mt-2 text-sm text-danger">This theme cannot be previewed.</p>
  return (
    <div className="mt-2" data-testid="theme-preview">
      <div className="mb-2 flex gap-2">
        {(['light', 'dark'] as const).map((m) => (
          <Button
            key={m}
            variant={mode === m ? 'primary' : 'outline'}
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
          >
            {m === 'light' ? 'Light' : 'Dark'}
          </Button>
        ))}
      </div>
      <div
        data-testid="theme-preview-sample"
        style={vars as CSSProperties}
        className="flex flex-col gap-2 rounded-card border border-line bg-bg p-3 font-ui text-text"
      >
        <div className="figure-ground self-end rounded-bubble rounded-br-md px-3.5 py-2.5 text-md">
          Move lunch to 1pm?
        </div>
        <div className="text-md">Done. Lunch with Sam is now at 1pm.</div>
        <div className="rounded-card border border-line bg-surface p-2 text-sm">
          <div className="font-display text-md">Send the invoice</div>
          <div className="text-text-2">Fictional Studio Ltd, 120.00</div>
          <div className="mt-2 flex gap-2">
            <span className="rounded-button bg-accent px-3 py-1 text-on-accent">Approve</span>
            <span className="rounded-button border border-line px-3 py-1 text-accent-text">Not now</span>
          </div>
        </div>
        <div className="rounded-button border border-line bg-surface px-3 py-2 text-sm text-text-2">Message Talos</div>
      </div>
    </div>
  )
}
