import * as TabsPrimitive from '@radix-ui/react-tabs'
import type { ComponentProps } from 'react'
import { cn } from './cn.ts'

export const Tabs = TabsPrimitive.Root

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('inline-flex gap-1 border-b border-line', className)} {...props} />
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        '-mb-px min-h-11 border-b-[3px] border-transparent px-3 text-sm text-text-2 transition-colors duration-[var(--dur-1)] ease-talos hover:text-text focus-visible:outline-2 focus-visible:outline-focus data-[state=active]:border-accent data-[state=active]:font-semibold data-[state=active]:text-text',
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn('focus-visible:outline-2 focus-visible:outline-focus', className)}
      {...props}
    />
  )
}
