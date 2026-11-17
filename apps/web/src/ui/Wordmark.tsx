import { cn } from './cn.ts'

// The brand wordmark TΛLOS: Cinzel Black under every theme (.wordmark in app.css), the A a Cinzel "V" flipped vertically
// (matches cap height). Only the exact default name gets it; a custom agent name is in the theme's display font.
export function Wordmark({ name, className }: { name: string; className?: string }) {
  if (name !== 'Talos') return <span className={cn('font-display', className)}>{name}</span>
  return (
    <span role="img" aria-label="Talos" className={cn('wordmark uppercase', className)}>
      <span aria-hidden="true">T</span>
      <span aria-hidden="true" className="wordmark-lambda">
        V
      </span>
      <span aria-hidden="true">LOS</span>
    </span>
  )
}
