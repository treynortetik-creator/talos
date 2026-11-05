// A bottom sheet that portals INTO the app card instead of <body>. In real element fullscreen only the fullscreen
// element and its descendants are drawn, so a sheet on <body> (the shared `ui/sheet`) would be invisible there.
import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'

export function BoxSheet({
  open,
  onOpenChange,
  container,
  title,
  description,
  children,
  testId,
  onOpenAutoFocus,
  onCloseAutoFocus,
  outsideDismisses = true,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  container: HTMLElement | null
  title: string
  description?: string
  children: ReactNode
  testId?: string
  /** Where focus lands when the sheet opens (default: Radix picks the first control). */
  onOpenAutoFocus?: (e: Event) => void
  onCloseAutoFocus?: (e: Event) => void
  /** False: a tap on the backdrop is swallowed and does nothing, so only the sheet's own buttons (or Escape) close it. */
  outsideDismisses?: boolean
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
        <Dialog.Content
          data-testid={testId}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          onPointerDownOutside={outsideDismisses ? undefined : (e) => e.preventDefault()}
          onInteractOutside={outsideDismisses ? undefined : (e) => e.preventDefault()}
          className="fixed inset-x-0 bottom-0 z-[61] max-h-[85dvh] overflow-y-auto rounded-t-card border-t border-line bg-surface p-4 text-text focus-visible:outline-2 focus-visible:outline-focus md:inset-x-auto md:left-1/2 md:w-[min(32rem,100vw)] md:-translate-x-1/2"
        >
          <Dialog.Title className="m-0 text-lg font-semibold [overflow-wrap:anywhere]">{title}</Dialog.Title>
          {description ? (
            <Dialog.Description className="m-0 mt-1 text-sm text-text-2 [overflow-wrap:anywhere]">
              {description}
            </Dialog.Description>
          ) : (
            <Dialog.Description className="sr-only">{title}</Dialog.Description>
          )}
          <div className="mt-3">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
