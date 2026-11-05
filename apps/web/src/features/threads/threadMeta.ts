// Per-viewer thread helpers. Before `Thread.topic` (docs/THREADS.md) the "what goes here" note lived on this device only;
// the settings sheet now saves it to config (where the agent reads it) and clears the local copy, which stays only as a
// fallback for a Mac that predates `threads/2`. Everything is wrapped: storage can be blocked or throw.
import type { ThreadT } from '@talos-app/protocol'
import { ownValue } from '@talos-app/protocol'
import { useCallback, useSyncExternalStore } from 'react'

const DESC_KEY = 'talos.thread-descriptions'
const EXPLAIN_KEY = 'talos.threads-explainer-dismissed'
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

function read(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? ''
  } catch {
    return ''
  }
}
function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    /* private window or blocked storage: the note simply doesn't persist */
  }
  emit()
}

export const MAX_DESCRIPTION = 200

export function parseDescriptions(raw: string): Record<string, string> {
  try {
    const v: unknown = JSON.parse(raw || '{}')
    if (!v || typeof v !== 'object') return {}
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
    )
  } catch {
    return {}
  }
}

export function setDescription(id: string, text: string): void {
  const all = parseDescriptions(read(DESC_KEY))
  const t = text.trim().slice(0, MAX_DESCRIPTION)
  if (t) all[id] = t
  else delete all[id]
  write(DESC_KEY, JSON.stringify(all))
}

/** Sign-out: the local "what goes here" notes go with the rest of the device's private data. */
export function clearThreadDescriptions(): void {
  try {
    globalThis.localStorage?.removeItem(DESC_KEY)
  } catch {
    /* blocked storage: nothing to clear */
  }
  emit()
}

export function useDescription(id: string): string {
  const raw = useSyncExternalStore(
    subscribe,
    () => read(DESC_KEY),
    () => '',
  )
  return ownValue(parseDescriptions(raw), id) ?? ''
}

export function useExplainerDismissed(): [boolean, () => void] {
  const v = useSyncExternalStore(
    subscribe,
    () => read(EXPLAIN_KEY),
    () => '1',
  )
  const dismiss = useCallback(() => write(EXPLAIN_KEY, '1'), [])
  return [v === '1', dismiss]
}

export const NOTIFY_LABEL: Record<ThreadT['notify'], string> = {
  all: 'All activity',
  needs_you: 'Needs you only',
  off: 'Off',
}
export const NOTIFY_SHORT: Record<ThreadT['notify'], string> = {
  all: 'All',
  needs_you: 'Needs you',
  off: 'Off',
}
