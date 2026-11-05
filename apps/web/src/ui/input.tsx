import type { InputHTMLAttributes, Ref } from 'react'
import { cn } from './cn.ts'

const field =
  'w-full rounded-button border border-line bg-surface px-3 text-md text-text placeholder:text-text-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50'

export function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={cn(field, 'min-h-11', className)} {...props} />
}
