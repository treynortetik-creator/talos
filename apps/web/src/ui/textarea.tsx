import type { Ref, TextareaHTMLAttributes } from 'react'
import { cn } from './cn.ts'

export function Textarea({
  className,
  ref,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'min-h-20 w-full rounded-button border border-line bg-surface px-3 py-2 text-md text-text placeholder:text-text-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
