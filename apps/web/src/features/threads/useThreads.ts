import type { ThreadT } from '@talos-app/protocol'
import { useMemo } from 'react'
import { useTalos } from '../../lib/client.ts'

/** Non-archived threads in config order. */
export function useVisibleThreads(): ThreadT[] {
  const threads = useTalos((s) => s.threads)
  return useMemo(() => threads.filter((t) => !t.archived).sort((a, b) => a.order - b.order), [threads])
}

export function useAgentName(): string {
  return useTalos((s) => s.config?.agent.name ?? 'Talos')
}
