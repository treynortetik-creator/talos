import type { AttachmentRefT } from '@talos-app/protocol'
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isNativeShell } from '../../lib/native.ts'
import { AUTO_REHYDRATE_MAX_BYTES, type GateState } from './media.ts'
import {
  DeliveryError,
  type DeliveryMode,
  deliveryMode,
  fetchAttachmentFile,
  nativeShareMedia,
  prepareTimeoutFor,
  SHARE_MEDIA_DONE_EVENT,
  ShareRefused,
  safeFileName,
  shareFileNow,
} from './shareAttachment.ts'

export const MANUAL_SHARE_HELP = "Open the file, then use Safari's share button."
const EXPIRED = 'This file expired from the relay; ask the agent to resend.'

// One native share runs at a time (the shell ignores a second request too), so the busy flag is shared by every attachment.
let nativePending = false
const nativeListeners = new Set<() => void>()
const settleNative = () => {
  nativePending = false
  for (const l of [...nativeListeners]) l()
}

export type DeliveryNote = { kind: 'info' | 'error'; text: string; manual?: boolean } | null

/**
 * Everything one attachment's Share / Download control needs. One control per attachment: the thread view puts it under the
 * attachment, a file chip becomes it. `onClick` is meant for an `<a href download>`: the plain download is the anchor's own
 * default, taken only in 'link' mode; the other modes cancel it and do their own thing.
 *
 * Phone browsers allow navigator.share() only while the tap's user activation is fresh, so the File is prepared before the
 * tap (when the file is ready and in view, up to 5 MB; or on pointer-down) and the click calls share with nothing awaited
 * first. A bigger file that is not ready at the tap is prepared then, and the owner taps again.
 */
export function useDelivery(att: AttachmentRefT, gateState: GateState, inView = true) {
  const mode: DeliveryMode = useMemo(() => deliveryMode(), [])
  const [file, setFile] = useState<File | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [note, setNote] = useState<DeliveryNote>(null)
  const [nativeBusy, setNativeBusy] = useState(false)
  const nativeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ac = useRef<AbortController | null>(null)
  const ready = gateState === 'ready'
  const fileRef = useRef<File | null>(null)
  fileRef.current = file

  const prepare = useCallback(async () => {
    if (ac.current || fileRef.current) return
    const mine = new AbortController()
    ac.current = mine
    setPreparing(true)
    try {
      const f = await fetchAttachmentFile(att, { signal: mine.signal })
      if (mine.signal.aborted) return
      setFile(f)
    } catch (e) {
      if (mine.signal.aborted) return
      const code = e instanceof DeliveryError ? e.code : 'failed'
      setNote({
        kind: 'error',
        text:
          code === 'expired'
            ? EXPIRED
            : code === 'timeout'
              ? `${att.name} took too long to load. Try again.`
              : `Couldn't get ${att.name}. Try again.`,
      })
    } finally {
      if (ac.current === mine) ac.current = null
      setPreparing(false)
    }
  }, [att])

  // The file goes away with the gate (a retry, a re-probe) and with the component.
  useEffect(() => {
    if (!ready) setFile(null)
  }, [ready])
  // The shell answers with a window event; if it never does (an older shell), the busy state ends after the download budget.
  useEffect(() => {
    const clear = () => {
      if (nativeTimer.current) clearTimeout(nativeTimer.current)
      nativeTimer.current = null
      setNativeBusy(false)
    }
    nativeListeners.add(clear)
    return () => {
      nativeListeners.delete(clear)
      if (nativeTimer.current) clearTimeout(nativeTimer.current)
    }
  }, [])
  useEffect(
    () => () => {
      ac.current?.abort()
      ac.current = null
    },
    [],
  )
  useEffect(() => {
    if (mode === 'share' && ready && inView && !file && (att.size ?? 0) <= AUTO_REHYDRATE_MAX_BYTES) void prepare()
  }, [mode, ready, inView, file, att.size, prepare])

  // A "tap again" note turns into "ready" the moment the file is there.
  useEffect(() => {
    if (file) setNote((n) => (n?.kind === 'info' ? { kind: 'info', text: 'Ready. Tap Share.' } : n))
  }, [file])

  const onPointerDown = useCallback(() => {
    if (mode === 'share' && ready) void prepare()
  }, [mode, ready, prepare])

  const onClick = useCallback(
    (e: MouseEvent) => {
      if (!ready) {
        e.preventDefault()
        return
      }
      if (mode === 'link') return
      e.preventDefault()
      setNote(null)
      if (mode === 'native') {
        if (nativePending) return
        if (!nativeShareMedia(att)) {
          setNote({ kind: 'error', text: "Couldn't open the share sheet. Update the app." })
          return
        }
        nativePending = true
        setNativeBusy(true)
        nativeTimer.current = setTimeout(settleNative, prepareTimeoutFor(att.size) + 10_000)
        return
      }
      const f = fileRef.current
      if (!f) {
        void prepare()
        setNote({ kind: 'info', text: 'Getting the file ready. Tap Share again in a moment.' })
        return
      }
      // Synchronous on purpose: nothing may be awaited between the tap and this call.
      shareFileNow(f).then(
        () => {},
        (err: unknown) => {
          if (err instanceof ShareRefused)
            setNote({ kind: 'error', text: `Couldn't open the share sheet. ${MANUAL_SHARE_HELP}`, manual: true })
          else setNote({ kind: 'error', text: `Couldn't share ${att.name}.` })
        },
      )
    },
    [ready, mode, att, prepare],
  )

  useEffect(() => {
    window.addEventListener(SHARE_MEDIA_DONE_EVENT, settleNative)
    return () => window.removeEventListener(SHARE_MEDIA_DONE_EVENT, settleNative)
  }, [])

  const verb = mode === 'link' ? (isNativeShell() ? 'Open' : 'Download') : 'Share'
  return {
    mode,
    verb,
    download: safeFileName(att.name, att.mime),
    preparing: preparing || nativeBusy,
    busyLabel: nativeBusy,
    fileReady: file !== null,
    note,
    onClick,
    onPointerDown,
  }
}
