import { cn } from './cn.ts'

// The brand wordmark TΛLOS: Cinzel Black, the A a Cinzel "V" flipped vertically (matches cap height). Only the exact
// default name gets it; a custom agent name stays plain Cinzel.
export function Wordmark({ name, className }: { name: string; className?: string }) {
  if (name !== 'Talos') return <span className={cn('font-display', className)}>{name}</span>
  return (
    <span role="img" aria-label="Talos" className={cn('wordmark font-display font-black uppercase', className)}>
      <span aria-hidden="true">T</span>
      <span aria-hidden="true" className="wordmark-lambda">
        V
      </span>
      <span aria-hidden="true">LOS</span>
    </span>
  )
}
