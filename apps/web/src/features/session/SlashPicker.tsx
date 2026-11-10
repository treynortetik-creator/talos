// The composer `/` picker (docs/CLAUDE-CODE.md C4.3). Typing "/" at the start of the box lists the inventory's
// commands, skills and plugin commands; choosing one goes through planPaletteRun (via the controller): a skill becomes
// the ordinary text message "/name", a built-in control becomes a signed session.control.
import type { InventoryCommandT } from '@talos-app/protocol'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { cn } from '../../ui/cn.ts'
import { commandBlock, filterCommands, GROUPS, INSTALL_HINT, routeBadge } from './logic.ts'
import { type Outcome, useSessionController } from './store.ts'

export type PickerItem = { cmd: InventoryCommandT; disabled: boolean; reason: string; id: string }
export type PickResult = { clearText: boolean; fillText?: string; note?: Outcome }

const SLASH = /^\/([^\s]*)$/

export function useSlashPicker(text: string, threadId: string) {
  const ctl = useSessionController()
  const inventory = useStore(ctl.store, (s) => s.inventory)
  const modOnline = useStore(ctl.store, (s) => s.modOnline)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const m = SLASH.exec(text)
  const open = m !== null && dismissedFor !== text
  const query = m?.[1] ?? ''

  const items: PickerItem[] = useMemo(() => {
    if (!open || !inventory) return []
    const found = filterCommands(inventory.commands, query)
    // Keep the group order stable so the arrow keys walk the screen top to bottom.
    const order = new Map(GROUPS.map((g, i) => [g.source, i]))
    const sorted = [...found].sort((a, b) => (order.get(a.source) ?? 9) - (order.get(b.source) ?? 9))
    return sorted.map((cmd, i) => {
      return { cmd, id: `slash-opt-${i}`, ...commandBlock(cmd, modOnline) }
    })
  }, [open, inventory, query, modOnline])

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the top
  useEffect(() => setActive(0), [query])

  const pick = useCallback(
    async (item: PickerItem): Promise<PickResult> => {
      if (item.disabled) return { clearText: false, note: { kind: 'error', text: `${item.reason}.`, local: true } }
      const { cmd } = item
      const o = await ctl.runPalette(threadId, { source: cmd.source, name: cmd.name, args: '' })
      // A command that needs an argument (/model, /effort, /fast): keep typing instead of failing.
      if (o.kind === 'error' && o.local && o.code === 'args_invalid')
        return { clearText: false, fillText: `/${cmd.name} `, note: o }
      if (o.kind === 'error') return { clearText: false, note: o }
      return { clearText: true, note: o }
    },
    [ctl, threadId],
  )

  /** Handles a key while the list is open; true = consumed. */
  const onKey = useCallback(
    (key: string, choose: (item: PickerItem) => void): boolean => {
      if (!open) return false
      if (key === 'Escape') {
        setDismissedFor(text)
        return true
      }
      if (items.length === 0) return false
      if (key === 'ArrowDown') {
        setActive((a) => (a + 1) % items.length)
        return true
      }
      if (key === 'ArrowUp') {
        setActive((a) => (a - 1 + items.length) % items.length)
        return true
      }
      if (key === 'Enter') {
        const it = items[active]
        if (it) choose(it)
        return true
      }
      return false
    },
    [open, items, active, text],
  )

  return { open, hasInventory: Boolean(inventory), items, active, setActive, pick, onKey, query }
}

export type SlashPickerState = ReturnType<typeof useSlashPicker>

export function SlashPicker({ picker, onChoose }: { picker: SlashPickerState; onChoose: (item: PickerItem) => void }) {
  const { open, items, active, hasInventory } = picker
  useEffect(() => {
    document.getElementById(items[active]?.id ?? '')?.scrollIntoView?.({ block: 'nearest' })
  }, [items, active])
  if (!open) return null
  const shell =
    'incised absolute inset-x-2 bottom-full z-10 mb-1 max-h-[45dvh] overflow-y-auto rounded-card border border-line bg-surface p-1'
  if (!hasInventory)
    return (
      <div role="status" data-testid="slash-hint" className={cn(shell, 'px-3 py-3 text-sm text-text-2')}>
        {INSTALL_HINT}
      </div>
    )
  if (items.length === 0)
    return (
      <div role="status" className={cn(shell, 'px-3 py-3 text-sm text-text-2')}>
        No matching commands.
      </div>
    )
  let lastGroup = ''
  return (
    <div className={shell} data-testid="slash-picker">
      <div role="listbox" id="slash-list" aria-label="Commands">
        {items.map((it, i) => {
          const g = GROUPS.find((x) => x.source === it.cmd.source)?.label ?? ''
          const header = g !== lastGroup
          lastGroup = g
          const b = routeBadge(it.cmd)
          return (
            <div key={`${it.cmd.source}:${it.cmd.name}`}>
              {header && (
                <div
                  aria-hidden="true"
                  className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2"
                >
                  {g}
                </div>
              )}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: the textarea owns the keys (combobox pattern) */}
              <div
                role="option"
                id={it.id}
                tabIndex={-1}
                aria-selected={i === active}
                aria-disabled={it.disabled || undefined}
                data-testid="slash-option"
                data-name={it.cmd.name}
                onPointerDown={(e) => e.preventDefault()}
                onMouseEnter={() => picker.setActive(i)}
                onClick={() => onChoose(it)}
                className={cn(
                  'flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-button px-3 py-1.5',
                  i === active && 'bg-surface-2',
                  it.disabled && 'cursor-default italic',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono text-sm">/{it.cmd.name}</span>
                  <span className="block truncate text-xs text-text-2">
                    {it.disabled ? it.reason : it.cmd.description}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-text-2">{it.disabled ? '' : b.text}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
