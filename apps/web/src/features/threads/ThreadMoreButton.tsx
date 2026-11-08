// The "..." at the right end of a thread row (the sidebar, the Threads list): it opens THAT thread's settings sheet
// (manage/ThreadEditor.tsx). The header pencil and "Edit" stay for reordering and renaming many threads at once.
//
// On a mouse it is there on hover and whenever focus is anywhere in the row (the group). On touch it is always there.
// It sits NEXT to the row's link, never inside it, so pressing it cannot follow the link. Rows that carry it also hold
// the sheet (below), outside any press or swipe handler of the row.
import type { ThreadT } from '@talos-app/protocol'
import { forwardRef, type ReactNode, useRef, useState } from 'react'
import { cn } from '../../ui/cn.ts'
import { IconMore } from '../../ui/icons.tsx'
import { ThreadEditor } from './manage/ThreadEditor.tsx'

export const moreLabel = (name: string) => `Thread settings for ${name}`

export const ThreadMoreButton = forwardRef<
  HTMLButtonElement,
  { thread: ThreadT; onOpen: () => void; tone?: 'chrome' | 'surface'; className?: string }
>(function ThreadMoreButton({ thread, onOpen, tone = 'surface', className }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={moreLabel(thread.name)}
      title="Thread settings"
      data-testid={`thread-more-${thread.id}`}
      onClick={onOpen}
      className={cn(
        'absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-pill pointer-coarse:size-11',
        // mouse: hidden until the row is hovered or has focus; touch: always shown
        'opacity-0 transition-opacity duration-[var(--dur-1)] group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100',
        tone === 'chrome'
          ? 'text-on-chrome-2 hover:bg-chrome-hover hover:text-on-chrome'
          : 'text-text-2 hover:bg-surface-2 hover:text-text',
        className,
      )}
    >
      <IconMore width={20} height={20} aria-hidden="true" />
    </button>
  )
})

/**
 * One row with its "...": `children` is the row's link; the sheet opens for `thread` and gives focus back to the button.
 * `outside` renders beside the group (the sheet must not sit inside a row's long-press or swipe handlers: events of a
 * portal bubble through React's tree).
 */
export function ThreadRowWithSettings({
  thread,
  tone,
  className,
  wrap,
  onOpenSettings,
  children,
}: {
  thread: ThreadT
  tone?: 'chrome' | 'surface'
  className?: string
  /** The caller owns the settings sheet (it must outlive this row: archiving takes the row out of the list). */
  onOpenSettings?: (thread: ThreadT) => void
  /** Wraps the link and the button (the Threads list puts its press and swipe menu around both). */
  wrap?: (inner: ReactNode) => ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const inner = (
    <div className={cn('group relative', className)}>
      {children}
      <ThreadMoreButton
        ref={btn}
        thread={thread}
        tone={tone}
        onOpen={() => (onOpenSettings ? onOpenSettings(thread) : setOpen(true))}
      />
    </div>
  )
  return (
    <>
      {wrap ? wrap(inner) : inner}
      {!onOpenSettings && (
        <ThreadEditor
          open={open}
          onOpenChange={setOpen}
          thread={thread}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            btn.current?.focus()
          }}
        />
      )}
    </>
  )
}
