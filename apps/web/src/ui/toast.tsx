import * as ToastPrimitive from '@radix-ui/react-toast'
import type { ComponentProps } from 'react'
import { cn } from './cn.ts'

export const ToastProvider = ToastPrimitive.Provider
export const ToastAction = ToastPrimitive.Action
export const ToastClose = ToastPrimitive.Close

export function ToastViewport({ className, ...props }: ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      className={cn(
        // top, not bottom: on a phone the bottom is the composer. The inset keeps it clear of the notch.
        'fixed inset-x-0 top-0 z-50 flex flex-col gap-2 p-4 pt-[max(1rem,env(safe-area-inset-top))] outline-none',
        className,
      )}
      {...props}
    />
  )
}

export function Toast({ className, ...props }: ComponentProps<typeof ToastPrimitive.Root>) {
  return (
    <ToastPrimitive.Root
      className={cn('rounded-card border border-line bg-surface p-3 text-sm text-text', className)}
      {...props}
    />
  )
}

export function ToastTitle({ className, ...props }: ComponentProps<typeof ToastPrimitive.Title>) {
  return <ToastPrimitive.Title className={cn('font-medium', className)} {...props} />
}

export function ToastDescription({ className, ...props }: ComponentProps<typeof ToastPrimitive.Description>) {
  return <ToastPrimitive.Description className={cn('text-text-2', className)} {...props} />
}
