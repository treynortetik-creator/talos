import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes, Ref } from 'react'
import { cn } from './cn.ts'

// Primary is the pottery itself: terracotta with black-figure ink, identical in both modes.
export const buttonVariants = cva(
  'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-button px-4 text-sm font-semibold transition-[background-color,color,filter,transform] active:translate-y-px duration-[var(--dur-1)] ease-talos focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-on-accent hover:brightness-95',
        outline: 'border border-line bg-transparent text-text hover:bg-surface-2',
        ghost: 'bg-transparent text-text hover:bg-surface-2',
        danger: 'bg-transparent text-danger hover:bg-surface-2',
      },
    },
    defaultVariants: { variant: 'primary' },
  },
)

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean; ref?: Ref<HTMLButtonElement> }

export function Button({ className, variant, asChild, ref, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(buttonVariants({ variant }), className)}
      {...props}
    />
  )
}
