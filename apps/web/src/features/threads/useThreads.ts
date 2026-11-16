import type { ThreadT } from '@talos-app/protocol'
import { useMemo } from 'react'
import { useTalos } from '../../lib/client.ts'
import { inDrawnOrder } from './subThreads.ts'

/** Non-archived threads in config order, each parent followed by its sub-threads (the order every list draws). */
export function useVisibleThreads(): ThreadT[] {
  const threads = useTalos((s) => s.threads)
  return useMemo(() => inDrawnOrder(threads.filter((t) => !t.archived).sort((a, b) => a.order - b.order)), [threads])
}

/** A thread's name as the owner set it; its id only when the thread is not in the list. */
export function useThreadName(id: string | undefined): string {
  return useTalos((s) => (id ? (s.threads.find((t) => t.id === id)?.name ?? id) : ''))
}

export function useAgentName(): string {
  return useTalos((s) => s.config?.agent.name ?? 'Talos')
}
