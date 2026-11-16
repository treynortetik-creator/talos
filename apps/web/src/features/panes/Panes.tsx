// Stacked panes beside the chat (owner-approved design, 2026-11-11). The thread header's toolbar adds and removes them; they
// stack in a column on the right of the chat, each with a title bar that folds it to just that bar or closes it. The layout
// is kept per thread on this device (panesStore.ts). Library is the pages and files sent in Talos, every thread (features/files,
// SentFiles). Terminal is the Mac app's own (only there; a remote shell over the relay is never offered).
import { type ReactNode, useEffect, useState } from 'react'
import { getShell } from '../../lib/native/shell.ts'
import { cn } from '../../ui/cn.ts'
import { IconBook, IconClose, IconTerminal } from '../../ui/icons.tsx'
import { FilesSheet as LibrarySheet } from '../files/FilesSheet.tsx'
import { SentFiles } from '../files/SentFiles.tsx'
import { SENT_TEXT } from '../files/sentLogic.ts'
import { useMediaQuery } from '../settings/useMedia.ts'
import { closePane, type PaneId, setPaneCollapsed, togglePane, usePaneLayout } from './panesStore.ts'
import { closeShellPane, TerminalSlot } from './TerminalSlot.tsx'

export const PANE_TEXT = {
  toolbar: 'Panes',
  column: 'Panes',
  add: 'Add a pane',
  collapse: (t: string) => `Collapse ${t}`,
  expand: (t: string) => `Expand ${t}`,
  close: (t: string) => `Close ${t}`,
  show: (t: string) => `Show ${t}`,
  hide: (t: string) => `Hide ${t}`,
} as const

const TITLES: Record<PaneId, string> = { library: SENT_TEXT.title, terminal: 'Terminal' }

/** The panes this device can show: the Library always (its pages need no Mac), the terminal only in the Mac app. */
export function availablePanes(): PaneId[] {
  return ['library', ...(getShell()?.kind === 'desktop' ? (['terminal'] as const) : [])]
}
const useAvailablePanes = () => availablePanes()

const ICONS: Record<PaneId, (p: { width?: number; height?: number }) => ReactNode> = {
  library: (p) => <IconBook {...p} aria-hidden="true" />,
  terminal: (p) => <IconTerminal {...p} aria-hidden="true" />,
}

/** The pane column needs a desktop: narrower than this, the header's Library button opens the Library sheet instead. */
export const PANES_QUERY = '(min-width: 1024px)'

/** The toolbar in the thread header: one button per pane (pressed while open), and + for a menu of them. */
export function PaneToolbar({ threadId, cramped = false }: { threadId: string; cramped?: boolean }) {
  const wide = useMediaQuery(PANES_QUERY)
  // a header too narrow to name its panes shows none here: they are rows in the thread menu (usePaneMenuItems)
  if (wide && cramped) return null
  return wide ? <WideToolbar threadId={threadId} /> : <NarrowFiles threadId={threadId} />
}

/** The panes as rows of the thread menu, for a header too narrow to show them by name (owner, 2026-11-15). */
export function usePaneMenuItems(
  threadId: string,
): Array<{ pane: PaneId; label: string; on: boolean; toggle: () => void }> {
  const layout = usePaneLayout(threadId)
  const panes = useAvailablePanes()
  return panes.map((p) => ({
    pane: p,
    label: layout.open.includes(p) ? PANE_TEXT.hide(TITLES[p]) : PANE_TEXT.show(TITLES[p]),
    on: layout.open.includes(p),
    toggle: () => togglePane(threadId, p),
  }))
}

/** A tablet: no room for a column beside the chat, so the Library is a sheet, as on a phone. */
function NarrowFiles({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false)
  const button =
    'inline-flex h-9 items-center gap-1.5 rounded-button border border-line px-2.5 text-sm text-text-2 hover:bg-surface-2 hover:text-text'
  return (
    <>
      <button type="button" aria-haspopup="dialog" onClick={() => setOpen(true)} className={button}>
        {ICONS.library({ width: 15, height: 15 })}
        {TITLES.library}
      </button>
      <LibrarySheet threadId={threadId} open={open} onOpenChange={setOpen} />
    </>
  )
}

function WideToolbar({ threadId }: { threadId: string }) {
  const layout = usePaneLayout(threadId)
  const panes = useAvailablePanes()
  return (
    <div role="toolbar" aria-label={PANE_TEXT.toolbar} className="flex shrink-0 items-center gap-1.5">
      {panes.map((p) => {
        const on = layout.open.includes(p)
        const Icon = ICONS[p]
        return (
          <button
            key={p}
            type="button"
            aria-pressed={on}
            aria-label={TITLES[p]}
            title={TITLES[p]}
            onClick={() => togglePane(threadId, p)}
            className={cn(
              'inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-button border px-2.5 text-sm',
              on
                ? 'border-accent bg-accent/10 text-text'
                : 'border-line text-text-2 hover:bg-surface-2 hover:text-text',
            )}
          >
            <Icon width={15} height={15} />
            <span aria-hidden="true">{TITLES[p]}</span>
          </button>
        )
      })}
    </div>
  )
}

/** The column of open panes on the right of the chat; nothing when none is open. */
export function PaneColumn({ threadId }: { threadId: string }) {
  const layout = usePaneLayout(threadId)
  const panes = useAvailablePanes()
  const shown = layout.open.filter((p) => panes.includes(p))
  // folding a pane only helps when another pane can take the room (owner, 2026-11-15): alone, a pane is never folded, and
  // one left folded in a saved layout opens full and stays so
  const alone = shown.length === 1 ? shown[0] : undefined
  useEffect(() => {
    if (alone && layout.collapsed.includes(alone)) setPaneCollapsed(threadId, alone, false)
  }, [alone, layout.collapsed, threadId])
  if (shown.length === 0) return null
  return (
    <aside
      aria-label={PANE_TEXT.column}
      className="flex w-[min(36rem,40vw)] shrink-0 flex-col gap-2 border-l border-line bg-bg p-2"
    >
      {shown.map((p) => (
        <Pane
          key={p}
          threadId={threadId}
          pane={p}
          collapsed={!alone && layout.collapsed.includes(p)}
          canFold={!alone}
        />
      ))}
    </aside>
  )
}

function Pane({
  threadId,
  pane,
  collapsed,
  canFold,
}: {
  threadId: string
  pane: PaneId
  collapsed: boolean
  canFold: boolean
}) {
  const title = TITLES[pane]
  return (
    <section
      aria-label={title}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-card border border-line bg-surface',
        collapsed ? 'shrink-0' : 'flex-1 basis-0',
      )}
    >
      {pane === 'library' ? (
        <FilesBody threadId={threadId} collapsed={collapsed} canFold={canFold} />
      ) : (
        <>
          {/* the owner's own close ends the pane's shells; the slot unmounting alone only hides them */}
          <TitleBar
            threadId={threadId}
            pane={pane}
            collapsed={collapsed}
            canFold={canFold}
            onClose={() => closeShellPane(threadId)}
          />
          {!collapsed && <TerminalSlot threadId={threadId} showing />}
        </>
      )}
    </section>
  )
}

function FilesBody({ threadId, collapsed, canFold }: { threadId: string; collapsed: boolean; canFold: boolean }) {
  // the pages and files sent in Talos, across every thread: the thread's folder on the Mac is under Memory
  return (
    <>
      <TitleBar threadId={threadId} pane="library" collapsed={collapsed} canFold={canFold} note={SENT_TEXT.subtitle} />
      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col p-2">
          <SentFiles layout="table" />
        </div>
      )}
    </>
  )
}

function TitleBar({
  threadId,
  pane,
  collapsed,
  canFold,
  note,
  onClose,
}: {
  threadId: string
  pane: PaneId
  collapsed: boolean
  /** Another pane shares the column: folding this one gives it the room. */
  canFold: boolean
  note?: ReactNode
  /** Runs before the pane is closed by the owner's own tap (the Terminal pane ends its shells). */
  onClose?: () => void
}) {
  const title = TITLES[pane]
  return (
    <div className={cn('flex h-10 shrink-0 items-center gap-2 pr-1 pl-3.5', !collapsed && 'border-b border-line')}>
      <h2 className="m-0 text-sm font-semibold">{title}</h2>
      {note ? <span className="min-w-0 truncate text-xs text-text-2">{note}</span> : null}
      <span className="flex-1" />
      {canFold && (
        <button
          type="button"
          aria-label={collapsed ? PANE_TEXT.expand(title) : PANE_TEXT.collapse(title)}
          aria-expanded={!collapsed}
          onClick={() => setPaneCollapsed(threadId, pane, !collapsed)}
          className="grid size-8 place-items-center rounded-button text-text-2 hover:bg-surface-2 hover:text-text"
        >
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path d={collapsed ? 'M6 9l6 6 6-6' : 'M5 12h14'} />
          </svg>
        </button>
      )}
      <button
        type="button"
        aria-label={PANE_TEXT.close(title)}
        onClick={() => {
          onClose?.()
          closePane(threadId, pane)
        }}
        className="grid size-8 place-items-center rounded-button text-text-2 hover:bg-surface-2 hover:text-text"
      >
        <IconClose width={14} height={14} />
      </button>
    </div>
  )
}
