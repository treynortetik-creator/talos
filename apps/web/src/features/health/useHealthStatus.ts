// Polls GET /api/status (session-guarded, a relay route: it answers with the Mac offline). Every 30 s while the page is
// visible, once on becoming visible again, and on demand.
import { HealthStatus, type HealthStatusT } from '@talos-app/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createHttp } from '../../lib/http.ts'
import { noteLimits } from './limits.ts'

const http = createHttp()
export const POLL_MS = 30_000

export type HealthState =
  | { phase: 'loading'; status: null }
  | { phase: 'ready'; status: HealthStatusT }
  | { phase: 'error'; status: HealthStatusT | null }

export async function fetchStatus(): Promise<HealthStatusT> {
  const status = HealthStatus.parse(await http.get('/api/status'))
  noteLimits(status.limits)
  return status
}

export function useHealthStatus(
  pollMs: number = POLL_MS,
  /** False for a reader with no session: nothing is asked, and nothing keeps asking. */
  enabled = true,
): { state: HealthState; refresh: () => void } {
  const [state, setState] = useState<HealthState>({ phase: 'loading', status: null })
  const last = useRef<HealthStatusT | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(() => {
    fetchStatus().then(
      (status) => {
        if (!alive.current) return
        last.current = status
        setState({ phase: 'ready', status })
      },
      () => {
        if (alive.current) setState({ phase: 'error', status: last.current })
      },
    )
  }, [])

  useEffect(() => {
    alive.current = true
    if (!enabled) return
    refresh()
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer === null) timer = setInterval(refresh, pollMs)
    }
    const stop = () => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        refresh()
        start()
      } else stop()
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive.current = false
      stop()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh, pollMs, enabled])

  return { state, refresh }
}
