import type { RouteRes } from '@talos-app/protocol'
import { useCallback, useEffect, useState } from 'react'
import { useTalosClient } from '../../lib/client.ts'

export type Spec = RouteRes<'catalog'>[number]
export type Conn = RouteRes<'connectionGet'>

type Async<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void }

function useAsync<T>(load: () => Promise<T>, deps: unknown[]): Async<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  })
  const [tick, setTick] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is the caller's dependency list
  useEffect(() => {
    let live = true
    setState((s) => ({ ...s, loading: true }))
    load().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (e) => live && setState({ data: null, error: e instanceof Error ? e.message : 'failed', loading: false }),
    )
    return () => {
      live = false
    }
  }, [...deps, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, reload }
}

export function useCatalog(): Async<Spec[]> {
  const client = useTalosClient()
  return useAsync(() => client.api.catalog(), [client])
}

export function useConnections(): Async<Conn[]> {
  const client = useTalosClient()
  return useAsync(() => client.api.connections.list(), [client])
}

export function useConnection(id: string): Async<Conn> {
  const client = useTalosClient()
  return useAsync(() => client.api.connections.get(id), [client, id])
}

export function useDeliveries(id: string): Async<RouteRes<'connectionDeliveries'>> {
  const client = useTalosClient()
  return useAsync(() => client.api.connections.deliveries(id), [client, id])
}

export const statusWord = (s: Conn['status']): string =>
  s === 'active' ? 'connected' : s === 'paused' ? 'paused' : 'needs attention'
