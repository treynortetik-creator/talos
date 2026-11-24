// Opening a file from the Files sheet. A row is a plain link (a page opens its own sandboxed /page, anything else the file),
// so the browser opens it on the tap itself, as the timeline's file links do; audio plays in the message player. Every URL carries
// the media cache-buster (media.ts), as the timeline's do. The relay keeps a file's bytes for a while only: rows older than
// that are checked once (HEAD, a few at a time). One the relay no longer has is asked back from the Mac (media.fetch, then
// media.ready), at once when it is small, as the timeline does, so it opens on one tap like any other; a big one waits for
// a tap ("get it from your Mac"). A file the Mac removed (Settings, Storage) is never asked for.
import { type SentFileT, sentFileType } from '@talos-app/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTalosClient } from '../../lib/client.ts'
import type { SocketClient } from '../../lib/socketClient.ts'
import { open as openInPlayer } from '../threads/audioPlayer.ts'
import { AUTO_REHYDRATE_MAX_BYTES, fetchTimeoutFor, mediaHref, mediaPageUrl, mediaUrl } from '../threads/media.ts'
import { rowKey } from './sentLogic.ts'

/** The relay keeps a file this long by default (BUFFER_DAYS): younger rows are taken to be there and are not checked. */
export const RELAY_KEEPS_MS = 6 * 86_400_000
/** How many old rows are checked at once. */
const PROBES_AT_ONCE = 4

/** Per row: not on the relay (ask the Mac), being asked back, or failed. No state: a link. */
export type OpenState = 'gone' | 'fetching' | 'failed'

export const urlFor = (f: SentFileT): string =>
  mediaHref(sentFileType(f.file) === 'pages' ? mediaPageUrl(f.file.media_id) : mediaUrl(f.file.media_id))
export const isAudio = (f: SentFileT): boolean => sentFileType(f.file) === 'audio'

async function there(url: string, signal?: AbortSignal): Promise<boolean | null> {
  try {
    const r = await fetch(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', signal })
    if (r.ok) return true
    return r.status === 410 || r.status === 404 ? false : null // anything else: not known, left as a link
  } catch {
    return null
  }
}

export function useOpenSent(files: SentFileT[]) {
  const client = useTalosClient()
  const [states, setStates] = useState<Record<string, OpenState>>({})
  const probed = useRef(new Set<string>())
  const live = useRef(true)
  useEffect(() => {
    live.current = true // set here too: StrictMode runs the cleanup once and mounts again
    return () => {
      live.current = false
    }
  }, [])
  const setState = useCallback((key: string, s: OpenState | null) => {
    if (!live.current) return
    setStates((o) => {
      const { [key]: _old, ...rest } = o
      return s ? { ...rest, [key]: s } : rest
    })
  }, [])

  /** Ask the Mac to put the file back on the relay; true once it says it is there. */
  const fromMac = useCallback(
    (f: SentFileT) =>
      new Promise<boolean>((resolve) => {
        const c = client as Partial<SocketClient>
        if (typeof c.fetchMedia !== 'function') return resolve(false)
        let done = false
        const end = (ok: boolean) => {
          if (done) return
          done = true
          clearTimeout(t)
          off()
          offErr()
          resolve(ok)
        }
        const off = client.onFrame('media.ready', (m) => m.media_id === f.file.media_id && end(true))
        const offErr = client.onFrame(
          'error',
          (e) => (e as { media_id?: unknown }).media_id === f.file.media_id && end(false),
        )
        const t = setTimeout(() => end(false), fetchTimeoutFor(f.file.size))
        c.fetchMedia(f.file.media_id)
      }),
    [client],
  )

  /** A row the relay no longer has: ask the Mac; a link again once it is back. */
  const getBack = useCallback(
    async (f: SentFileT): Promise<boolean> => {
      const key = rowKey(f)
      setState(key, 'fetching')
      const ok = (await fromMac(f)) && (await there(urlFor(f))) === true
      setState(key, ok ? null : 'failed')
      return ok
    },
    [fromMac, setState],
  )

  // old rows: is the relay still holding them? Checked once each, a few at a time; a small one it lost is asked back now.
  // A longer list (Show more) checks only its new rows; checks under way finish. Leaving the sheet stops them all.
  const [ac] = useState(() => new AbortController())
  useEffect(() => () => ac.abort(), [ac])
  useEffect(() => {
    const old = files.filter(
      (f) => !f.removed && !probed.current.has(rowKey(f)) && Date.now() - Date.parse(f.created_at) > RELAY_KEEPS_MS,
    )
    let i = 0
    const next = async (): Promise<void> => {
      const f = old[i++]
      if (!f || ac.signal.aborted || !live.current) return
      if (probed.current.has(rowKey(f))) return next() // taken by a worker of an earlier list
      probed.current.add(rowKey(f))
      const found = await there(urlFor(f), ac.signal)
      if (ac.signal.aborted) return
      if (found === false) {
        if (f.file.size <= AUTO_REHYDRATE_MAX_BYTES) await getBack(f)
        else setState(rowKey(f), 'gone')
      }
      return next()
    }
    for (let k = 0; k < PROBES_AT_ONCE; k++) void next()
  }, [files, setState, getBack, ac])

  /** Audio plays in the message player (a file the relay lost is asked back first). */
  const play = useCallback(
    async (f: SentFileT) => {
      if (f.removed) return
      const st = states[rowKey(f)]
      if ((st === 'gone' || st === 'failed') && !(await getBack(f))) return
      openInPlayer(
        {
          key: `${f.message_id}:${f.file.media_id}`,
          mediaId: f.file.media_id,
          title: f.file.name,
          mime: f.file.mime,
          size: f.file.size,
          ...(f.file.duration_ms ? { durationMs: f.file.duration_ms } : {}),
        },
        urlFor(f),
      )
    },
    [states, getBack],
  )

  return { states, getBack, play }
}
