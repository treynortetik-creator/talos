import * as SwitchPrimitive from '@radix-ui/react-switch'
import type { ComponentProps } from 'react'
import { cn } from './cn.ts'

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        // 48 x 28 drawn, 48 x 44 to the finger: the ::before pads the hit area without moving anything.
        "relative inline-flex h-7 w-12 shrink-0 before:absolute before:inset-x-0 before:-inset-y-[9px] before:content-[''] items-center rounded-pill border border-line bg-surface-2 transition-colors duration-[var(--dur-1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus data-[state=checked]:bg-accent",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-5 translate-x-1 rounded-pill bg-text transition-transform duration-[var(--dur-1)] data-[state=checked]:translate-x-6 data-[state=checked]:bg-on-accent" />
    </SwitchPrimitive.Root>
  )
}
