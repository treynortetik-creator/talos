import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from './cn.ts'

export const badgeVariants = cva(
  'inline-flex items-center rounded-pill px-2 py-0.5 text-xs font-semibold uppercase tracking-[var(--tracking-caps)]',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-2 text-text-2',
        accent: 'bg-accent text-on-accent',
        ok: 'bg-surface-2 text-ok',
        warn: 'bg-surface-2 text-warn',
        danger: 'bg-surface-2 text-danger',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}
