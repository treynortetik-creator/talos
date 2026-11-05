// The Greek-key rule (spec 8.10): at most once per screen, under the main header. Inked by --meander-ink.
import { cn } from './cn.ts'

export function Meander({ className }: { className?: string }) {
  return <div aria-hidden="true" data-meander="" className={cn('meander-rule', className)} />
}
