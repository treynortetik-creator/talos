// What the palette lists. Pure: the Palette component feeds it the live threads, cards and commands.
import type { CardT, InventoryCommandT } from '@talos-app/protocol'
import { type ActionSpec, chordLabel, isActive, type KeyEntry } from '../../lib/keymap.ts'
import { PALETTE_TEXT } from './text.ts'

export type PaletteRun =
  | { type: 'act'; act: ActionSpec }
  | { type: 'search'; q: string }
  | { type: 'card'; id: string }
  | { type: 'slash'; cmd: InventoryCommandT }

export type PaletteItem = {
  id: string
  label: string
  hint?: string
  shortcut: string
  group: string
  run: PaletteRun
  /** A command the composer's picker would block: shown, with why, and never run. */
  disabled?: boolean
}

/** Entries the palette offers besides the threads (digits, the palette itself, Esc and the unwired Call are not items). */
const OFFERED = [
  'needsYou',
  'topCard',
  'newThread',
  'searchMessages',
  'schedules',
  'memory',
  'settings',
  'shortcuts',
  'findInThread',
  'sessionPanel',
  'sidebar',
  'threadPrev',
  'threadNext',
]

export type ItemInput = {
  mode: 'palette' | 'needs'
  query: string
  keymap: readonly KeyEntry[]
  macApp: boolean
  /** Mac glyphs (⌘K) rather than Ctrl+K. */
  mac: boolean
  /** Phones show no shortcuts. */
  showKeys: boolean
  threads: ReadonlyArray<{ id: string; name: string }>
  cards: ReadonlyArray<Pick<CardT, 'id' | 'title' | 'thread_id'>>
  currentThreadId: string | null
  /** Only for a query that starts with `/`; each carries the composer picker's own blocked rule. */
  commands: ReadonlyArray<{ cmd: InventoryCommandT; disabled: boolean; reason: string }>
  /** Whether the Session panel can be toggled here. */
  hasSession: boolean
  /** Whether the sidebar exists at this width. */
  hasSidebar: boolean
}

const norm = (s: string) => s.toLowerCase()

export function buildItems(i: ItemInput): PaletteItem[] {
  const q = norm(i.query.trim())
  const keys = (entry: KeyEntry | undefined) =>
    entry && i.showKeys && isActive(entry, i.macApp) ? chordLabel(entry.chord, i.mac) : ''
  const byId = new Map(i.keymap.map((e) => [e.id, e]))
  const threadName = new Map(i.threads.map((t) => [t.id, t.name]))

  let items: PaletteItem[]
  if (i.mode === 'needs') {
    items = i.cards.map((c) => ({
      id: `card-${c.id}`,
      label: c.title,
      ...(threadName.get(c.thread_id) ? { hint: threadName.get(c.thread_id) as string } : {}),
      shortcut: '',
      group: PALETTE_TEXT.needsGroup,
      run: { type: 'card', id: c.id },
    }))
  } else {
    const own: PaletteItem[] = []
    for (const id of OFFERED) {
      const entry = byId.get(id)
      if (!entry || !isActive(entry, i.macApp)) continue
      if (id === 'topCard' && i.cards.length === 0) continue
      if (id === 'findInThread' && !i.currentThreadId) continue
      if (id === 'sessionPanel' && !i.hasSession) continue
      if (id === 'sidebar' && !i.hasSidebar) continue
      // the Settings section that lists the shortcuts is not on a phone, so neither is the item that opens it
      if (id === 'shortcuts' && !i.showKeys) continue
      own.push({
        id: entry.id,
        label: entry.label,
        shortcut: keys(entry),
        group: entry.group,
        run: id === 'searchMessages' && q ? { type: 'search', q: i.query.trim() } : { type: 'act', act: entry.act },
        ...(id === 'searchMessages' && q ? { hint: PALETTE_TEXT.searchHint } : {}),
      })
    }
    const threads: PaletteItem[] = i.threads.map((t, n) => ({
      id: `thread-${t.id}`,
      label: t.name,
      shortcut: n < 9 ? keys(byId.get(`thread${n + 1}`)) : '',
      group: 'Threads',
      run: { type: 'act', act: { kind: 'thread', index: n } },
    }))
    // A command is listed only for a query that starts with `/`: a plain word is a search, and Enter must never send a command.
    const cmds: PaletteItem[] =
      i.currentThreadId && q.startsWith('/')
        ? i.commands.map(({ cmd, disabled, reason }) => ({
            id: `slash-${cmd.source}-${cmd.name}`,
            label: `/${cmd.name}`,
            ...(disabled ? { hint: reason, disabled: true } : {}),
            shortcut: '',
            group: PALETTE_TEXT.commands,
            run: { type: 'slash', cmd },
          }))
        : []
    // Search messages stays last: it is what you get when nothing else matches.
    const search = own.filter((x) => x.id === 'searchMessages')
    items = [...own.filter((x) => x.id !== 'searchMessages'), ...threads, ...cmds, ...search]
  }

  if (!q) return items
  const hit = (it: PaletteItem) =>
    it.id === 'searchMessages' || it.id.startsWith('slash-') || norm(`${it.label} ${it.hint ?? ''}`).includes(q)
  const rank = (it: PaletteItem) => (norm(it.label).startsWith(q) ? 0 : 1)
  return items
    .filter(hit)
    .map((it, n) => ({ it, n }))
    .sort((a, b) => rank(a.it) - rank(b.it) || a.n - b.n)
    .map((x) => x.it)
}
