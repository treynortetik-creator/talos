import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { ComponentProps } from 'react'
import { cn } from './cn.ts'

// A sheet is a dialog that slides in from an edge. Bottom on phones, right on desktop.
export const Sheet = DialogPrimitive.Root
export const SheetClose = DialogPrimitive.Close
export const SheetTitle = DialogPrimitive.Title
export const SheetDescription = DialogPrimitive.Description

export function SheetContent({
  className,
  children,
  side = 'bottom',
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { side?: 'bottom' | 'right' | 'left' }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 bg-black/50" />
      <DialogPrimitive.Content
        className={cn(
          'fixed border-line bg-surface p-4 text-text focus-visible:outline-2 focus-visible:outline-focus',
          side === 'bottom' && 'inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-card border-t',
          side === 'right' && 'inset-y-0 right-0 w-[min(100vw,26rem)] overflow-y-auto border-l',
          side === 'left' && 'inset-y-0 left-0 w-[min(88vw,22rem)] overflow-y-auto border-r',
          className,
        )}
        data-side={side}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}
