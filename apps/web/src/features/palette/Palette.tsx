// The Cmd+K palette (and the Cmd+J Needs-you list, which is the same box with another list). One component for the desktop dialog and the
// phone's full-screen sheet. It only ever OPENS things: a Needs-you card opens at /card/:id, and the answer is that card's own buttons.
import { useEffect, useId, useMemo, useState } from 'react'
import { useLocation, useMatch, useNavigate } from 'react-router'
import { useStore } from 'zustand'
import { DEFAULT_KEYMAP, isMacPlatform, type KeyEntry } from '../../lib/keymap.ts'
import { cn } from '../../ui/cn.ts'
import { Dialog, DialogContent, DialogTitle } from '../../ui/index.ts'
import { useAwaitingOwner } from '../cards/useAwaitingOwner.ts'
import { commandBlock, filterCommands } from '../session/logic.ts'
import { useSessionController } from '../session/store.ts'
import { ThreadEditor } from '../threads/manage/ThreadEditor.tsx'
import { useVisibleThreads } from '../threads/useThreads.ts'
import { type ActionCtx, runAction } from './actions.ts'
import { buildItems, type PaletteItem } from './items.ts'
import { usePalette } from './store.ts'
import { swallowEnterUntilKeyUp } from './swallow.ts'
import { PALETTE_TEXT } from './text.ts'

export function Palette({
  phone = false,
  macApp = false,
  mac = isMacPlatform(),
  keymap = DEFAULT_KEYMAP,
  hasSession = false,
  hasSidebar = true,
  ctx = {},
}: {
  phone?: boolean
  macApp?: boolean
  /** Mac glyphs (⌘K) rather than Ctrl+K. */
  mac?: boolean
  keymap?: readonly KeyEntry[]
  hasSession?: boolean
  hasSidebar?: boolean
  /** What Shell owns: the Session panel, the sidebar. */
  ctx?: Partial<Pick<ActionCtx, 'toggleSession' | 'toggleSidebar'>>
}) {
  const mode = usePalette((s) => s.mode)
  const close = usePalette((s) => s.close)
  const nav = useNavigate()
  const { pathname } = useLocation()
  // the thread on screen, if any: Search this thread and slash commands follow it
  const onThread = useMatch('/t/:thread')?.params.thread ?? null
  const threads = useVisibleThreads()
  const cards = useAwaitingOwner()
  const ctl = useSessionController()
  const inventory = useStore(ctl.store, (s) => s.inventory)
  const modOnline = useStore(ctl.store, (s) => s.modOnline)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [note, setNote] = useState('')
  const listId = useId()

  // A new route ends it: an opened card or thread is on screen, the box is not.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a route change closes it
  useEffect(() => close(), [pathname])
  // biome-ignore lint/correctness/useExhaustiveDependencies: every opening starts blank
  useEffect(() => {
    setQuery('')
    setActive(0)
    setNote('')
  }, [mode])

  // Commands are listed for a query that starts with `/` only; the blocked rule is the composer picker's own (commandBlock).
  const commands = useMemo(
    () =>
      inventory && query.trim().startsWith('/')
        ? filterCommands(inventory.commands, query.trim().slice(1), 8).map((cmd) => ({
            cmd,
            ...commandBlock(cmd, modOnline),
          }))
        : [],
    [inventory, query, modOnline],
  )
  const items = useMemo(
    () =>
      mode === 'palette' || mode === 'needs'
        ? buildItems({
            mode,
            query,
            keymap,
            macApp,
            mac,
            showKeys: !phone,
            threads: threads.map((t) => ({ id: t.id, name: t.name })),
            cards,
            currentThreadId: onThread,
            commands,
            hasSession,
            hasSidebar,
          })
        : [],
    [mode, query, keymap, macApp, mac, phone, threads, cards, onThread, commands, hasSession, hasSidebar],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the top
  useEffect(() => setActive(0), [query])

  const run = (it: PaletteItem | undefined, viaKey = false) => {
    if (!it) return
    const r = it.run
    if (r.type === 'slash') {
      if (!onThread) return
      if (it.disabled) return void setNote(`${it.hint ?? ''}.`) // say why, send nothing
      if (viaKey) swallowEnterUntilKeyUp()
      setNote('Sending…')
      void ctl.runPalette(onThread, { source: r.cmd.source, name: r.cmd.name, args: '' }).then((o) => setNote(o.text))
      return
    }
    // A palette item that opens another box (New thread, the Needs-you list) swaps the mode and keeps where focus goes back to.
    if (r.type === 'act' && r.act.kind === 'ui' && (r.act.name === 'newThread' || r.act.name === 'needs'))
      return void usePalette.getState().open(r.act.name === 'needs' ? 'needs' : 'new')
    // Something ran: focus is not sent back to the old button (the key that ran it must not land there), and a held Enter stops here.
    if (viaKey) swallowEnterUntilKeyUp()
    usePalette.setState({ returnTo: null })
    if (r.type === 'card') return void nav(`/card/${r.id}`) // OPEN only
    if (r.type === 'search') return void nav(`/search?q=${encodeURIComponent(r.q)}`)
    close() // the box goes first, so a toggled panel or a sidebar fold does not happen under it
    runAction(r.act, {
      nav,
      threads,
      currentThreadId: onThread,
      topCardId: cards[0]?.id ?? null,
      togglePalette: (m) => usePalette.getState().open(m),
      toggleSession: ctx.toggleSession ?? (() => false),
      toggleSidebar: ctx.toggleSidebar ?? (() => {}),
      closeDetail: close,
    })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return // an input method is still choosing
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (items.length === 0) return
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.repeat) return // a held Enter opens at most one thing
      run(items[Math.min(active, items.length - 1)], true)
    }
  }

  if (mode === 'new')
    return (
      <ThreadEditor
        open
        onOpenChange={(o) => !o && close()}
        onCreated={(id) => {
          close()
          nav(`/t/${id}`)
        }}
      />
    )
  const needs = mode === 'needs'
  return (
    <Dialog open={mode === 'palette' || needs} onOpenChange={(o) => !o && close()}>
      <DialogContent
        aria-describedby={undefined}
        data-palette=""
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          const back = usePalette.getState().returnTo
          if (back?.isConnected) back.focus()
        }}
        className={cn(
          'flex flex-col gap-2 p-3',
          phone
            ? 'top-0 left-0 h-dvh w-screen translate-x-0 translate-y-0 rounded-none border-0'
            : 'top-[12%] max-h-[70dvh] w-[min(92vw,36rem)] -translate-y-0',
        )}
      >
        <DialogTitle className="sr-only">{PALETTE_TEXT.title}</DialogTitle>
        {phone && (
          // a phone has no Esc key
          <button
            type="button"
            onClick={close}
            className="min-h-11 self-end px-3 text-sm font-medium text-text-2 underline focus-visible:outline-2 focus-visible:outline-focus"
          >
            {PALETTE_TEXT.close}
          </button>
        )}
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={needs ? PALETTE_TEXT.needsPlaceholder : PALETTE_TEXT.placeholder}
          aria-activedescendant={items.length > 0 ? `${listId}-${Math.min(active, items.length - 1)}` : undefined}
          placeholder={needs ? PALETTE_TEXT.needsPlaceholder : PALETTE_TEXT.placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          enterKeyHint="go"
          className="min-h-11 w-full rounded-button border border-line bg-surface px-3 text-md text-text placeholder:text-text-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        />
        <div
          role="listbox"
          id={listId}
          aria-label={needs ? PALETTE_TEXT.needsGroup : PALETTE_TEXT.title}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {items.map((it, n) => (
            <div
              key={it.id}
              id={`${listId}-${n}`}
              role="option"
              tabIndex={-1}
              aria-selected={n === Math.min(active, items.length - 1)}
              onMouseMove={() => setActive(n)}
              onClick={() => run(it)}
              aria-disabled={it.disabled ? true : undefined}
              onKeyDown={() => {}}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-button px-3 text-sm aria-selected:bg-surface-2"
            >
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.hint && <span className="shrink-0 text-xs text-text-2">{it.hint}</span>}
              {it.shortcut && (
                <kbd className="shrink-0 rounded-button border border-line px-1.5 font-mono text-xs text-text-2">
                  {it.shortcut}
                </kbd>
              )}
            </div>
          ))}
          {items.length === 0 && (
            <p role="status" className="m-0 px-3 py-3 text-sm text-text-2">
              {needs ? PALETTE_TEXT.nothingNeeds : PALETTE_TEXT.nothing}
            </p>
          )}
        </div>
        {note && (
          <p role="status" className="m-0 px-1 text-sm text-text-2">
            {note}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
