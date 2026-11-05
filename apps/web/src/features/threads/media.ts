import type { AttachmentRefT } from '@talos-app/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type TalosClient, useTalosClient } from '../../lib/client.ts'
import type { SocketClient } from '../../lib/socketClient.ts'

export const mediaUrl = (id: string) => `/media/${id}`
export const mediaPageUrl = (id: string) => `/media/${id}/page`
/** An MCP app view's pinned HTML, served with its own CSP header (M3.5). Previews use `/page`; never mix them. */
export const mediaAppUrl = (id: string) => `/media/${id}/app`

/**
 * Chromium keeps a bare 410 forever, and browsers already holding one for `/media/:id` or `/media/:id/page` (from before the
 * relay said `no-store`) would answer every probe from that cache without asking the relay. A query string is a different
 * cache entry, so every URL the app loads or probes carries this; the relay ignores it.
 */
const CACHE_GEN = 'c=2'
const bust = (url: string, r?: number) => `${url}?${CACHE_GEN}${r ? `&r=${r}` : ''}`

/**
 * How long we wait for the Mac to send an old file back, before the file's size is known: the base. A Mac that has
 * the file but cannot send it, or does not have it, now says so at once (an `error{ref}` for the ask); silence for this long
 * (a Mac that went away mid-ask) is still shown as a failure the owner can retry.
 */
export const MEDIA_FETCH_TIMEOUT_MS = 20_000
/** The Mac may spend 15 s + 2 s per MB putting a file on the relay (bridge/relay-http.ts), so a big file waits longer. */
export const fetchTimeoutFor = (size: number | undefined): number =>
  MEDIA_FETCH_TIMEOUT_MS + 2_000 * Math.ceil((size ?? 0) / 1_048_576)
/** Files up to this size come back by themselves when the owner scrolls to them; bigger ones wait for a tap. */
export const AUTO_REHYDRATE_MAX_BYTES = 5 * 1024 * 1024

/**
 * The Mac (or the relay: it is offline) refused a `media.fetch` for this file. The socket client re-emits the `error` frame
 * with the `media_id` of the ask, so the chip fails now instead of after its timeout. Does nothing on a client without it.
 */
function onMediaFetchFailed(client: TalosClient, mediaId: string, cb: () => void): () => void {
  return client.onFrame('error', (f) => {
    if ((f as { media_id?: unknown }).media_id === mediaId) cb()
  })
}

/** Asks the Mac for a file past the relay buffer. Does nothing on a client that cannot (the fake one). */
function askMac(client: unknown, mediaId: string): void {
  if (client && typeof client === 'object' && 'fetchMedia' in client) (client as SocketClient).fetchMedia(mediaId)
}

/**
 * Media older than the relay buffer is rehydrated from the Mac: on a load error we send `media.fetch` and retry when
 * `media.ready` arrives (spec 3.4). `state` is `fetching` while we wait and `failed` if the Mac does not answer in time or
 * the file still does not load after it was sent. `retry` goes back to the relay first (it may still hold the bytes after a
 * network blip) and only then asks the Mac again.
 */
export function useMediaSrc(
  att: AttachmentRefT,
  timeoutMs: number = fetchTimeoutFor(att.size),
): { src: string; onError: () => void; failed: boolean; state: 'ok' | 'fetching' | 'failed'; retry: () => void } {
  const client = useTalosClient()
  const [gen, setGen] = useState(0)
  const [state, setState] = useState<'ok' | 'fetching' | 'failed'>('ok')
  const asked = useRef(false)
  const sentBack = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const clear = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
  }, [])
  const ask = useCallback(() => {
    clear()
    asked.current = true
    setState('fetching')
    askMac(client, att.media_id)
    timer.current = setTimeout(() => setState('failed'), timeoutMs)
  }, [client, att.media_id, timeoutMs, clear])
  useEffect(() => {
    const off = client.onFrame('media.ready', (f) => {
      if (f.media_id !== att.media_id) return
      clear()
      sentBack.current = true
      setState('ok')
      setGen((b) => b + 1)
    })
    const offFail = onMediaFetchFailed(client, att.media_id, () => {
      if (!asked.current) return
      clear()
      setState('failed')
    })
    return () => {
      off()
      offFail()
      clear()
    }
  }, [client, att.media_id, clear])
  const onError = useCallback(() => {
    // A load error after the Mac already sent the file again is a real failure, not another round of asking.
    if (sentBack.current) {
      clear()
      setState('failed')
      return
    }
    if (!asked.current) ask()
  }, [ask, clear])
  const retry = useCallback(() => {
    asked.current = false
    sentBack.current = false
    clear()
    setState('ok') // load from the relay again; only a real load error asks the Mac
    setGen((b) => b + 1)
  }, [clear])
  return { src: bust(mediaUrl(att.media_id), gen), onError, failed: state !== 'ok', state, retry }
}

export type GateState = 'checking' | 'ready' | 'gone' | 'fetching' | 'failed'

/**
 * For attachments the browser loads without telling us how it went (a download link, a sandboxed page): probe the URL with
 * HEAD. A 410 (the relay dropped its copy) or a 404 (it dropped the row, which history kept forever outlives) means the
 * file may still be on the Mac: ask for it and probe again on `media.ready`. Small files are asked for at once; a big one
 * waits in `gone` until `load()`, so opening a thread never makes the Mac read hundreds of MB nobody asked for. Silence for
 * `timeoutMs`, a second miss or any other refusal is `failed`; `retry` starts over. Never `ready` until the file is there.
 * `url` is the URL to load once `ready`: it carries the cache-buster, so use it for the link or frame too.
 */
export function useMediaGate(
  att: AttachmentRefT,
  path: string,
  timeoutMs: number = fetchTimeoutFor(att.size),
  autoAsk: boolean = att.size <= AUTO_REHYDRATE_MAX_BYTES,
): { state: GateState; retry: () => void; load: () => void; url: string } {
  const client = useTalosClient()
  const [state, setState] = useState<GateState>('checking')
  const [attempt, setAttempt] = useState(0)
  const asked = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const url = bust(path)
  const clear = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
  }, [])
  const startAsk = useCallback(() => {
    asked.current = true
    setState('fetching')
    askMac(client, att.media_id)
    clear()
    timer.current = setTimeout(() => setState('failed'), timeoutMs)
  }, [client, att.media_id, timeoutMs, clear])
  useEffect(() => {
    const off = client.onFrame('media.ready', (f) => {
      if (f.media_id !== att.media_id || !asked.current) return
      clear()
      setState('checking')
      setAttempt((a) => a + 1)
    })
    const offFail = onMediaFetchFailed(client, att.media_id, () => {
      if (!asked.current) return
      clear()
      setState('failed')
    })
    return () => {
      off()
      offFail()
      clear()
    }
  }, [client, att.media_id, clear])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the probe
  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    void (async () => {
      try {
        const res = await fetch(url, {
          method: 'HEAD',
          credentials: 'same-origin',
          cache: 'no-store',
          signal: ac.signal,
        })
        if (!alive) return
        if (res.ok) {
          asked.current = false
          setState('ready')
        } else if ((res.status === 410 || res.status === 404) && !asked.current) {
          if (autoAsk) startAsk()
          else setState('gone')
        } else {
          clear()
          setState('failed')
        }
      } catch {
        if (alive) {
          clear()
          setState('failed')
        }
      }
    })()
    return () => {
      alive = false
      ac.abort()
    }
  }, [attempt, url, autoAsk, startAsk, clear])
  const retry = useCallback(() => {
    asked.current = false
    clear()
    setState('checking')
    setAttempt((a) => a + 1)
  }, [clear])
  return { state, retry, load: startAsk, url }
}
