// Drop files anywhere on the chat to attach them, the same flow as the + button (same limits, many files at once).
// Desktop browsers and the desktop webview only: on touch devices (no hover, coarse pointer) it renders nothing extra.
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { cn } from '../../ui/cn.ts'
import { IconFile } from '../../ui/icons.tsx'
import { mbWord, useRelayLimits } from '../health/limits.ts'
import { useComposerStore } from './composerStore.ts'
import { droppedFiles } from './uploadError.ts'

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
const touchOnly = () => {
  try {
    return window.matchMedia?.('(pointer: coarse)').matches === true
  } catch {
    return false
  }
}

export function DropZone({
  threadId,
  enabled = true,
  className,
  children,
  ...rest
}: {
  threadId: string
  /** Off while a call replaces the composer. */
  enabled?: boolean
  className?: string
  children: ReactNode
  'data-testid'?: string
}) {
  const dropFiles = useComposerStore((s) => s.dropFiles)
  const { uploadMaxMb } = useRelayLimits(false) // read only: the number is there once Health or an error has fetched it
  const [over, setOver] = useState(false)
  const depth = useRef(0) // dragenter/leave fire for every child; count them
  const active = enabled && !touchOnly()
  // A file dropped just outside the chat column must not make the browser navigate away to it.
  useEffect(() => {
    if (!active) return
    const stop = (e: Event) => {
      if (Array.from((e as unknown as DragEvent).dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
    }
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [active])
  if (!active)
    return (
      <div className={className} {...rest}>
        {children}
      </div>
    )
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drag target, not a control; the + button stays the accessible path
    <div
      className={cn('relative', className)}
      {...rest}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current += 1
        setOver(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault() // required, or the browser opens the file instead
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        dropFiles(threadId, droppedFiles(e.dataTransfer))
      }}
    >
      {children}
      {over && (
        <div
          data-testid="drop-overlay"
          aria-hidden="true"
          className="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-bubble border-2 border-dashed border-accent bg-bg/90"
        >
          <div className="flex flex-col items-center gap-2 text-accent-text">
            <IconFile width={32} height={32} />
            <span className="font-display text-lg font-semibold">Drop to attach</span>
            <span className="text-sm text-text-2">
              Files go to your message box. Max {mbWord(uploadMaxMb)} MB each.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
