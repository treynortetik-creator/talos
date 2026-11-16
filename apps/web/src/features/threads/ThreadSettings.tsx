// Entry points to the thread settings sheet (manage/ThreadEditor.tsx): the "..." menu in a thread's header, and "New thread".
import type { ThreadT } from '@talos-app/protocol'
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { cn } from '../../ui/cn.ts'
import { IconBook, IconBug, IconMore, IconPlus, IconSettings, IconTerminal } from '../../ui/icons.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover.tsx'
import { openBugReport } from '../bugreport/store.ts'
import { usePaneMenuItems } from '../panes/Panes.tsx'
import { ThreadEditor } from './manage/ThreadEditor.tsx'

/**
 * The sheet has no Radix trigger, so on close focus would fall to the page. This hands it back to the button that opened
 * the sheet, when that button is still on screen.
 */
const backTo = (btn: RefObject<HTMLButtonElement | null>) => (e: Event) => {
  if (!btn.current?.isConnected) return
  e.preventDefault()
  btn.current.focus()
}

export const THREAD_MENU_TEXT = {
  trigger: 'Thread menu',
  settings: 'Thread settings',
  bug: 'Report a bug',
} as const

/**
 * The "..." in a thread's header: a small menu with the thread's settings sheet and the bug reporter (which was only in Help
 * and the palette, where the owner did not find it). The reporter takes its picture once the menu has closed.
 */
export function ThreadSettings({ thread, paneRows = false }: { thread: ThreadT; paneRows?: boolean }) {
  const panes = usePaneMenuItems(thread.id)
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // Settings -> Notifications links to /t/<id>?settings=1: open this thread's settings once, then drop the flag so a
  // refresh or Back does not reopen it.
  const [params, setParams] = useSearchParams()
  const wantsOpen = params.get('settings') === '1'
  useEffect(() => {
    if (!wantsOpen) return
    setOpen(true)
    const next = new URLSearchParams(params)
    next.delete('settings')
    setParams(next, { replace: true })
  }, [wantsOpen, params, setParams])
  const items = () => [
    ...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]') ?? []),
  ]
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = items()
    const i = all.indexOf(document.activeElement as HTMLElement)
    const to =
      e.key === 'ArrowDown' ? (i + 1) % all.length : e.key === 'ArrowUp' ? (i - 1 + all.length) % all.length : null
    if (to === null) return
    e.preventDefault()
    all[to]?.focus()
  }
  const item = 'flex min-h-11 w-full items-center gap-2.5 rounded-button px-3 text-left text-sm hover:bg-surface-2'
  return (
    <>
      <Popover open={menu} onOpenChange={setMenu}>
        <PopoverTrigger asChild>
          <button
            ref={btn}
            type="button"
            aria-label={THREAD_MENU_TEXT.trigger}
            aria-haspopup="menu"
            data-testid="thread-settings-trigger"
            className="grid size-11 place-items-center rounded-pill hover:bg-surface-2"
          >
            <IconMore />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-56 p-1"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            items()[0]?.focus()
          }}
        >
          <div ref={list} role="menu" aria-label={THREAD_MENU_TEXT.trigger} onKeyDown={onKey}>
            <button
              type="button"
              role="menuitem"
              data-testid="thread-settings-open"
              className={item}
              onClick={() => {
                setMenu(false)
                setOpen(true)
              }}
            >
              <IconSettings width={18} height={18} aria-hidden="true" />
              {THREAD_MENU_TEXT.settings}
            </button>
            {/* the header had no room to show the panes by name: they are here */}
            {paneRows &&
              panes.map((p) => (
                <button
                  key={p.pane}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={p.on}
                  data-testid={`thread-menu-pane-${p.pane}`}
                  className={item}
                  onClick={() => {
                    setMenu(false)
                    p.toggle()
                  }}
                >
                  {p.pane === 'library' ? (
                    <IconBook width={18} height={18} aria-hidden="true" />
                  ) : (
                    <IconTerminal width={18} height={18} aria-hidden="true" />
                  )}
                  {p.label}
                </button>
              ))}
            <button
              type="button"
              role="menuitem"
              data-testid="thread-menu-bug"
              className={item}
              onClick={() => {
                setMenu(false)
                // after the menu is gone, so it is not in the picture
                void openBugReport()
              }}
            >
              <IconBug width={18} height={18} aria-hidden="true" />
              {THREAD_MENU_TEXT.bug}
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <ThreadEditor open={open} onOpenChange={setOpen} thread={thread} onCloseAutoFocus={backTo(btn)} />
    </>
  )
}

/** "+ New thread": opens the sheet in create mode. `compact` is the icon-only header/sidebar button. */
export function NewThread({
  compact,
  tone = 'surface',
  onCreated,
  className,
  defaultName,
}: {
  defaultName?: string
  compact?: boolean
  tone?: 'surface' | 'chrome'
  onCreated?: (id: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  // After a thread is made the caller decides what comes next (often opening it), so focus is left alone then.
  const made = useRef(false)
  return (
    <>
      <button
        ref={btn}
        type="button"
        data-testid={compact ? 'new-thread' : 'new-thread-bottom'}
        aria-label={compact ? 'Add a thread' : undefined}
        title={compact ? 'Add a thread' : undefined}
        onClick={() => {
          made.current = false
          setOpen(true)
        }}
        className={cn(
          'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-button text-sm font-semibold',
          compact ? 'min-w-11' : 'border px-4',
          tone === 'chrome'
            ? 'text-on-chrome-2 hover:bg-chrome-hover hover:text-on-chrome'
            : 'border-line text-text hover:bg-surface-2',
          className,
        )}
      >
        <IconPlus width={20} height={20} />
        {!compact && 'New thread'}
      </button>
      <ThreadEditor
        open={open}
        onOpenChange={setOpen}
        onCreated={(id) => {
          made.current = true
          onCreated?.(id)
        }}
        onCloseAutoFocus={(e) => {
          if (!made.current) backTo(btn)(e)
        }}
        {...(defaultName ? { defaultName } : {})}
      />
    </>
  )
}
