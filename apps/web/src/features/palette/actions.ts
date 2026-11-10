// The one dispatcher: the keyboard (Shell) and the palette both run a keymap entry's `act` through here.
// Nothing here answers a card. Needs-you only OPENS /card/:id; the answer is that card's own buttons.
import type { ActionSpec } from '../../lib/keymap.ts'
import type { PaletteMode } from './store.ts'

export type ActionCtx = {
  nav: (to: string) => void
  /** Visible threads in sidebar order. */
  threads: ReadonlyArray<{ id: string }>
  currentThreadId: string | null
  topCardId: string | null
  togglePalette: (mode: PaletteMode) => void
  /** Returns false when there is no Session panel to toggle here. */
  toggleSession: () => boolean
  toggleSidebar: () => void
  closeDetail: () => void
}

/** True when it did something (false leaves the browser's own key alone). */
export function runAction(act: ActionSpec, ctx: ActionCtx): boolean {
  switch (act.kind) {
    case 'thread': {
      const t = ctx.threads[act.index]
      if (t) ctx.nav(`/t/${t.id}`)
      return true
    }
    case 'threadStep': {
      const at = ctx.threads.findIndex((t) => t.id === ctx.currentThreadId)
      const to = at < 0 ? (act.by > 0 ? 0 : ctx.threads.length - 1) : at + act.by
      const t = ctx.threads[to]
      if (t) ctx.nav(`/t/${t.id}`)
      return true
    }
    case 'nav':
      ctx.nav(act.to)
      return true
    case 'ui':
      switch (act.name) {
        case 'palette':
          ctx.togglePalette('palette')
          return true
        case 'needs':
          ctx.togglePalette('needs')
          return true
        case 'newThread':
          ctx.togglePalette('new')
          return true
        case 'topCard':
          if (!ctx.topCardId) return false
          ctx.nav(`/card/${ctx.topCardId}`)
          return true
        case 'findInThread':
          if (!ctx.currentThreadId) return false
          ctx.nav(`/search?thread=${encodeURIComponent(ctx.currentThreadId)}`)
          return true
        case 'sessionPanel':
          return ctx.toggleSession()
        case 'sidebar':
          ctx.toggleSidebar()
          return true
        case 'close':
          ctx.closeDetail()
          return true
        case 'call':
          return false // not wired anywhere today
      }
  }
}

/** Entries that open a box of their own. They stay out of an open dialog and of the approval sheet: a dialog owns the keyboard. */
export const DIALOG_GUARDED: ReadonlySet<string> = new Set(['palette', 'needsYou', 'findInThread', 'shortcuts'])

/** A dialog other than the palette's own is open, or the approval sheet owns the screen. */
export function dialogOpen(approving: boolean): boolean {
  return (
    approving ||
    document.querySelector(
      '[role="dialog"][data-state="open"]:not([data-palette]), [role="alertdialog"][data-state="open"]',
    ) !== null
  )
}
