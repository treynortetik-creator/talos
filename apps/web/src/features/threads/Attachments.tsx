// Attachments in the timeline: images (with a viewer), inline video, audio and voice notes (speed + transcript), sandboxed
// HTML pages and file chips. `/media/*` responses carry their own sandbox CSP (5.4); HTML pages only ever load in an opaque-origin
// iframe: sandbox="allow-scripts" and never allow-same-origin.
import type { AttachmentRefT, MessageT } from '@talos-app/protocol'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes, formatDuration } from '../../lib/format.ts'
import { cn } from '../../ui/cn.ts'
import { IconExpand, IconFile, IconLink, IconPause, IconPlay } from '../../ui/icons.tsx'
import { FrameOverlay, SandboxedFrame } from '../../ui/SandboxedFrame.tsx'
import { AudioLine, useAudioLine } from './AudioLines.tsx'
import { type AudioItem, audioPlayer, savedPosition, useAudio } from './audioPlayer.ts'
import { rememberOpener } from './ImageViewer.tsx'
import { MarkdownFileCard } from './MarkdownFileCard.tsx'
import { MediaStatus } from './MediaStatus.tsx'
import { isMarkdownAtt } from './markdownDoc.ts'
import { mediaPageUrl, mediaUrl, removedAfterDays, useMediaGate, useMediaSrc } from './media.ts'
import { DeliveryNoteView, ShareButton } from './ShareButton.tsx'
import { safeFileName } from './shareAttachment.ts'
import { formatSpeed, nextSpeed } from './speed.ts'
import { useDelivery } from './useDelivery.ts'

// ---- voice-note playback order (consecutive notes auto-play) ---------------------------------------------------
type Player = { play(): void }
/**
 * `ids` are the voice-note messages in order; `items` is what the player needs to play each one while its row is scrolled out
 * (its media id and title). The player captures the notes after the one he taps when playback starts.
 */
export type VoiceOrder = { ids: string[]; players: Map<string, Player>; items?: Map<string, AudioItem> }
export const VoiceOrderContext = createContext<VoiceOrder>({ ids: [], players: new Map(), items: new Map() })

const SNIPPET = 60
/** The lock-screen title: a voice note reads as its first words once transcribed, a file as its name. */
function titleFor(att: AttachmentRefT, variant: 'voice_note' | 'audio', transcript?: MessageT['transcript']): string {
  if (variant === 'audio') return att.name
  const text = transcript?.status === 'failed' ? '' : (transcript?.text ?? '').trim().replace(/\s+/g, ' ')
  if (!text) return 'Voice note'
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET).trimEnd()}…` : text
}

export function useVoiceOrder(messages: MessageT[]): VoiceOrder {
  const voice = useMemo(
    () => messages.filter((m) => m.kind === 'voice_note' || (m.attachments ?? []).some((a) => a.kind === 'voice_note')),
    [messages],
  )
  const ids = useMemo(() => voice.map((m) => m.id), [voice])
  const items = useMemo(() => {
    const out = new Map<string, AudioItem>()
    for (const m of voice) {
      const att = (m.attachments ?? []).find((a) => a.kind === 'voice_note')
      if (!att) continue
      out.set(m.id, {
        key: m.id,
        mediaId: att.media_id,
        title: titleFor(att, 'voice_note', m.transcript),
        mime: att.mime,
        size: att.size,
        ...(att.duration_ms ? { durationMs: att.duration_ms } : {}),
      })
    }
    return out
  }, [voice])
  const players = useRef(new Map<string, Player>()).current
  return useMemo(() => ({ ids, players, items }), [ids, players, items])
}

// ---- image ---------------------------------------------------------------------------------------------------------
export function ImageAttachment({ att, onOpen }: { att: AttachmentRefT; onOpen: (att: AttachmentRefT) => void }) {
  const { src, onError, state, retry } = useMediaSrc(att)
  if (state !== 'ok')
    return (
      <div className="block max-w-full rounded-card border border-line bg-surface-2 p-4 text-sm text-text-2">
        <MediaStatus removedDays={removedAfterDays(att.media_id)} state={state} what={att.name} onRetry={retry} />
      </div>
    )
  return (
    <button
      type="button"
      onClick={(e) => {
        rememberOpener(e.currentTarget)
        onOpen(att)
      }}
      aria-label={`Open image ${att.name}`}
      className="block max-w-full overflow-hidden rounded-card border border-line bg-surface-2"
    >
      <img
        src={src}
        alt={att.name}
        onError={onError}
        width={att.width}
        height={att.height}
        className="max-h-72 max-w-full object-contain"
        loading="lazy"
      />
    </button>
  )
}

export { ImageViewer } from './ImageViewer.tsx'

// ---- audio -----------------------------------------------------------------------------------------------------------
const MAX_BARS = 40
const SEEK_STEP_S = 5

function peaks(b64?: string): number[] {
  if (!b64) return Array.from({ length: 48 }, (_, i) => 30 + ((i * 37) % 50))
  try {
    return Array.from(atob(b64), (c) => c.charCodeAt(0))
  } catch {
    return Array.from({ length: 48 }, () => 40)
  }
}

/** Downsamples (max of each bucket) so the bars fit a phone-width bubble. */
function fitBars(all: number[]): number[] {
  if (all.length <= MAX_BARS) return all
  const out: number[] = []
  for (let i = 0; i < MAX_BARS; i++) {
    const a = Math.floor((i * all.length) / MAX_BARS)
    const b = Math.max(a + 1, Math.floor(((i + 1) * all.length) / MAX_BARS))
    out.push(Math.max(...all.slice(a, b)))
  }
  return out
}

/**
 * A row's view of the app-level player (`audioPlayer.ts`): playing, position and duration for this clip, and the actions.
 * While some other clip is loaded the row shows its own saved spot. Chrome's MediaRecorder WebM has no duration, so the
 * attachment's `duration_ms` stands in until the player knows the real one.
 */
export function useAudioPlayer(att: AttachmentRefT, key: string, probeS = 0) {
  const mine = useAudio((s) => s.item?.key === key)
  const playing = useAudio((s) => s.item?.key === key && s.playing)
  const cur = useAudio((s) => (s.item?.key === key ? s.cur : savedPosition(att.media_id)))
  const real = useAudio((s) => (s.item?.key === key ? s.duration : 0))
  const refused = useAudio((s) => s.item?.key === key && s.refused)
  const fallback = att.duration_ms ? att.duration_ms / 1000 : probeS
  const duration = real > 0 ? real : fallback
  return { mine, playing, cur, duration, refused }
}

function Waveform({
  bars,
  progress,
  duration,
  cur,
  onSeek,
}: {
  bars: number[]
  progress: number
  duration: number
  cur: number
  onSeek: (t: number) => void
}) {
  const dragging = useRef(false)
  const at = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1))) * duration
  }
  return (
    <>
      {/* Seek control: sits over the bars (same grid cell), transparent, 44 px tall. */}
      <div
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(cur)}
        aria-valuetext={`${formatDuration(cur * 1000)} of ${formatDuration(duration * 1000)}`}
        className="relative col-start-2 row-start-1 h-11 min-w-0 cursor-pointer touch-none"
        onPointerDown={(e) => {
          if (!duration) return
          dragging.current = true
          e.currentTarget.setPointerCapture?.(e.pointerId)
          onSeek(at(e))
        }}
        onPointerMove={(e) => dragging.current && onSeek(at(e))}
        onPointerUp={() => {
          dragging.current = false
        }}
        onPointerCancel={() => {
          dragging.current = false
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onSeek(cur - SEEK_STEP_S)
          else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') onSeek(cur + SEEK_STEP_S)
          else if (e.key === 'Home') onSeek(0)
          else if (e.key === 'End') onSeek(duration)
          else return
          e.preventDefault()
        }}
      />
      <div
        className="col-start-2 row-start-1 flex h-8 min-w-0 flex-1 items-center gap-px self-center overflow-hidden"
        aria-hidden="true"
      >
        {bars.map((v, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: static bars
            key={i}
            className={cn(
              'min-w-[2px] max-w-1 flex-1 rounded-sm',
              i / bars.length < progress ? 'bg-accent-text' : 'bg-wave',
            )}
            style={{ height: `${Math.max(12, (v / 255) * 100)}%` }}
          />
        ))}
      </div>
    </>
  )
}

/** Drops the file a probe element holds, so the element costs nothing while React removes it. */
function releaseProbe(a: HTMLAudioElement): void {
  try {
    a.removeAttribute('src')
    a.load()
  } catch {
    /* jsdom */
  }
}

export function AudioPlayer({
  att,
  messageId,
  variant,
  transcript,
}: {
  att: AttachmentRefT
  messageId: string
  variant: 'voice_note' | 'audio'
  transcript?: MessageT['transcript']
}) {
  const { src, onError, state: mediaState, retry: retryMedia } = useMediaSrc(att)
  const order = useContext(VoiceOrderContext)
  // Agent audio has no `duration_ms` (the bridge never sends one): the probe element's own metadata supplies the length.
  const [probeS, setProbeS] = useState(0)
  const [probed, setProbed] = useState('')
  const { mine, playing, cur, duration } = useAudioPlayer(att, messageId, probeS)
  const speed = useAudio((s) => s.speed)
  const line = useAudioLine(messageId)
  const [open, setOpen] = useState(false)
  const bars = useMemo(() => fitBars(peaks(att.waveform)), [att.waveform])
  const progress = duration ? Math.min(1, cur / duration) : 0
  const title = titleFor(att, variant, transcript)
  const item = useMemo<AudioItem>(
    () => ({
      key: messageId,
      mediaId: att.media_id,
      title,
      mime: att.mime,
      size: att.size,
      ...(att.duration_ms ? { durationMs: att.duration_ms } : probeS > 0 ? { durationMs: probeS * 1000 } : {}),
    }),
    [messageId, att.media_id, att.duration_ms, att.mime, att.size, probeS, title],
  )
  /** The voice notes after this one, captured now: the player keeps going with them when this row has scrolled out of view. */
  const following = useCallback((): AudioItem[] => {
    const i = order.ids.indexOf(messageId)
    if (i < 0) return []
    return order.ids.slice(i + 1).flatMap((id) => order.items?.get(id) ?? [])
  }, [order, messageId])

  // The player reaches back to this row for a load error (the rehydrate) and takes the new URL when the Mac sends the file.
  const live = useRef({ src, onError })
  live.current = { src, onError }
  useEffect(() => {
    audioPlayer.ensure()
    return audioPlayer.registerRow(messageId, () => live.current)
  }, [messageId])
  // Only a URL that changed while this row was mounted (the Mac sent the file, or Retry) reloads the player. A row mounting
  // with its own fresh state (gen 0) onto a clip playing from a rehydrated URL must not.
  const seenSrc = useRef<{ id: string; src: string } | null>(null)
  useEffect(() => {
    const seen = seenSrc.current
    seenSrc.current = { id: messageId, src }
    if (seen && seen.id === messageId && seen.src !== src) audioPlayer.rowSrcChanged(messageId, src)
  }, [messageId, src])

  const play = useCallback(
    () => audioPlayer.open(item, live.current.src, following(), { play: true }),
    [item, following],
  )
  useEffect(() => {
    order.players.set(messageId, { play })
    return () => void order.players.delete(messageId)
  }, [order, messageId, play])
  const seek = useCallback(
    (t: number) => {
      if (mine) audioPlayer.seek(t)
      else if (duration) audioPlayer.seekSaved(att.media_id, Math.max(0, Math.min(duration, t)))
    },
    [mine, duration, att.media_id],
  )
  const cycle = () => audioPlayer.setSpeed(nextSpeed(speed))
  const dur = att.duration_ms ?? (duration ? duration * 1000 : 0)
  const text = transcript?.text ?? ''
  return (
    <div className="flex max-w-full flex-col gap-1" data-testid={variant === 'voice_note' ? 'voice-note' : 'audio'}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 rounded-bubble border border-line bg-surface px-2.5 py-2">
        {/* Not the player: it only probes the file. A clip past the relay buffer errors here as the thread opens, which starts the
            rehydrate from the Mac (D4) before anyone taps play. Playback is the player's single element. */}
        {/* The probe lives only until it has answered (metadata or an error) and then lets go of the file: a thread of voice
            notes would otherwise hold one media element each, and iOS runs out of them. A new URL (the Mac sent the file)
            probes again. */}
        {probed !== src && (
          // biome-ignore lint/a11y/useMediaCaption: a hidden probe that is never played
          <audio
            data-probe=""
            src={src}
            preload="metadata"
            onError={(e) => {
              releaseProbe(e.currentTarget)
              setProbed(src)
              onError()
            }}
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration
              if (Number.isFinite(d) && d > 0) setProbeS(d)
              releaseProbe(e.currentTarget)
              setProbed(src)
            }}
            hidden
          />
        )}
        <button
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => (playing ? audioPlayer.pause() : play())}
          className="col-start-1 row-start-1 grid size-11 shrink-0 place-items-center rounded-pill bg-accent text-on-accent shadow-[inset_0_0_0_1.5px_var(--talos-black)]"
        >
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <Waveform bars={bars} progress={progress} duration={duration} cur={cur} onSeek={seek} />
        <span className="col-start-3 row-start-1 font-mono text-xs text-text-2">{dur ? formatDuration(dur) : ''}</span>
        <button
          type="button"
          onClick={cycle}
          aria-label={`Playback speed ${formatSpeed(speed)}`}
          className="col-start-4 row-start-1 min-h-11 min-w-11 rounded-pill border border-line px-2 font-mono text-xs"
        >
          {String(speed)}×
        </button>
      </div>
      <AudioLine line={line} className="px-1 text-sm text-text-2" />
      {mediaState !== 'ok' && (
        <div className="px-1 text-sm text-text-2">
          <MediaStatus
            removedDays={removedAfterDays(att.media_id)}
            state={mediaState}
            what={att.name}
            onRetry={retryMedia}
          />
        </div>
      )}
      {variant === 'voice_note' && (
        <div className="px-1 text-sm text-text-2">
          {transcript?.status === 'failed' ? (
            'Transcript unavailable.'
          ) : !transcript || transcript.status === 'pending' ? (
            'Transcribing…'
          ) : (
            <>
              <p className={cn('whitespace-pre-wrap', !open && 'line-clamp-3')}>{text}</p>
              {text.split('\n').length > 3 || text.length > 160 ? (
                <button
                  type="button"
                  className="min-h-11 text-accent-text underline"
                  onClick={() => setOpen((o) => !o)}
                >
                  {open ? 'Show less' : 'Show more'}
                </button>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ---- HTML page card ------------------------------------------------------------------------------------------------
export function HtmlPageCard({ att }: { att: AttachmentRefT }) {
  const { state, retry, load, url } = useMediaGate(att, mediaPageUrl(att.media_id))
  const [open, setOpen] = useState(false)
  // The page runs at once on every engine (owner, 2026-11-18): the sandbox is the boundary, and on Chromium, where a page
  // can pull keyboard focus without a tap, SandboxedFrame's focus guard hands it back and hides a page that keeps at it.
  const expandRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => {
    setOpen(false)
    // Focus goes back to the button that opened the overlay.
    requestAnimationFrame(() => expandRef.current?.focus())
  }, [])
  return (
    <figure className="m-0 overflow-hidden rounded-card border border-line">
      <figcaption className="flex items-center justify-between gap-2 border-b border-line bg-surface-2 py-1 pl-3 pr-1 font-mono text-xs text-text-2">
        <span className="min-w-0 truncate">{att.name}</span>
        <div className="flex shrink-0 items-center">
          {state === 'ready' && (
            // Top-level safe, as in the overlay: the relay serves the page with `sandbox allow-scripts`, an opaque origin.
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${att.name} in a new tab`}
              className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-pill px-2 text-text-2 hover:text-text"
            >
              <IconLink width={16} height={16} />
              <span className="hidden sm:inline">Open in new tab</span>
            </a>
          )}
          <button
            ref={expandRef}
            type="button"
            aria-label={`Expand ${att.name} to full screen`}
            onClick={() => setOpen(true)}
            disabled={state !== 'ready'}
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-pill px-2 text-text-2 hover:text-text disabled:opacity-50"
          >
            <IconExpand width={16} height={16} />
            <span>Expand</span>
          </button>
        </div>
      </figcaption>
      {/* Opaque origin: no cookies, no same-origin access (5.4). The attributes are fixed in SandboxedFrame. */}
      {state === 'ready' ? (
        <SandboxedFrame title={att.name} src={url} loading="lazy" className="block h-80 w-full bg-surface" />
      ) : (
        <div className="grid h-40 place-items-center bg-surface p-4 text-sm text-text-2">
          {state === 'failed' || state === 'fetching' || state === 'gone' || state === 'removed' ? (
            <MediaStatus
              removedDays={removedAfterDays(att.media_id)}
              state={state}
              what={att.name}
              onRetry={retry}
              onLoad={load}
            />
          ) : (
            <span role="status">Loading…</span>
          )}
        </div>
      )}
      {open && state === 'ready' && <HtmlFullscreen att={att} url={url} onClose={close} />}
    </figure>
  )
}

/**
 * The same page, full viewport. The overlay (focus, scroll lock, real fullscreen with a mouse and never on a touch screen,
 * Escape, Close as an X at the top right) is
 * `ui/SandboxedFrame.tsx`, shared with MCP app views.
 */
function HtmlFullscreen({ att, url, onClose }: { att: AttachmentRefT; url: string; onClose: () => void }) {
  return (
    <FrameOverlay title={att.name} onClose={onClose} link={url}>
      <SandboxedFrame
        title={`${att.name} (full screen)`}
        src={url}
        className="block min-h-0 w-full flex-1 bg-surface"
      />
    </FrameOverlay>
  )
}

// ---- video ---------------------------------------------------------------------------------------------------------
// The video that is playing now. A second one, or the audio player, takes the sound: two sounds at once is never wanted.
let playingVideo: HTMLVideoElement | null = null

/**
 * Inline video (audit L15). Loads like a file chip (the same probe, so a file that left the relay comes back from the Mac or
 * says so with Retry), plays inside the page (`playsInline`) and fetches only its header until he taps play. There is no
 * poster; `#t=0.001` makes iOS draw the first frame. Playing it pauses the audio player: two sounds at once is never wanted.
 */
export function VideoAttachment({ att }: { att: AttachmentRefT }) {
  const { state, retry, load, url } = useMediaGate(att, mediaUrl(att.media_id))
  // 'net': the fetch failed (the Mac may be offline), Retry can help. 'codec': the file is there but this client cannot decode it.
  const [broken, setBroken] = useState<null | 'net' | 'codec'>(null)
  const video = useRef<HTMLVideoElement>(null)
  const playerPlaying = useAudio((d) => d.playing)
  // The player started (a row's Play, the lock screen's Play): the video gives way. Only a video whose own 'play' event has been
  // heard (`playingVideo`) is older than the player's start. `paused` flips the moment play() is called, but the events arrive
  // in the order the calls were made, so a video told to play just after the player still has its event to come: it is the
  // newer one, and its onPlay pauses the player. Pausing it here would leave both silent. The effect also runs a beat after the
  // render that saw the player playing, so it asks the player element itself: if the video has already paused the player, stand down.
  useEffect(() => {
    const v = video.current
    if (playerPlaying && v && playingVideo === v && !v.paused && !audioPlayer.element().paused) v.pause()
  }, [playerPlaying])
  useEffect(
    () => () => {
      if (playingVideo === video.current) playingVideo = null
    },
    [],
  )
  if (state === 'ready' && !broken)
    return (
      // biome-ignore lint/a11y/useMediaCaption: agent output carries no caption track
      <video
        ref={video}
        src={`${url}#t=0.001`}
        controls
        playsInline
        preload="metadata"
        aria-label={att.name}
        data-testid="inline-video"
        onPlay={(e) => {
          const me = e.currentTarget
          if (playingVideo && playingVideo !== me && !playingVideo.paused) playingVideo.pause()
          playingVideo = me
          if (audioPlayer.active()) audioPlayer.pause()
        }}
        onPause={(e) => {
          if (playingVideo === e.currentTarget) playingVideo = null
        }}
        onError={(e) => {
          // MEDIA_ERR_DECODE (3) and MEDIA_ERR_SRC_NOT_SUPPORTED (4): the bytes are fine, this client cannot play them.
          const code = e.currentTarget.error?.code
          setBroken(code === 3 || code === 4 ? 'codec' : 'net')
        }}
        className="block max-h-[70vh] w-full max-w-md rounded-card border border-line bg-black"
      />
    )
  if (broken === 'codec')
    return (
      <div
        className="block max-w-full rounded-card border border-line bg-surface-2 p-4 text-sm text-text-2"
        data-testid="video-undecodable"
      >
        <p>{`This device can't play ${att.name}. The file itself is fine.`}</p>
        <a
          href={url}
          download={safeFileName(att.name, att.mime)}
          className="mt-2 inline-flex min-h-11 items-center gap-2 text-text underline"
        >
          <IconFile width={18} height={18} />
          <span>Download {att.name}</span>
          <span className="text-text-2">{formatBytes(att.size)}</span>
        </a>
      </div>
    )
  const shown = broken ? 'failed' : state
  if (shown === 'fetching' || shown === 'failed' || shown === 'gone' || shown === 'removed')
    return (
      <div
        className="block max-w-full rounded-card border border-line bg-surface-2 p-4 text-sm text-text-2"
        data-testid="video-unavailable"
      >
        <MediaStatus
          removedDays={removedAfterDays(att.media_id)}
          state={shown}
          what={att.name}
          onRetry={() => {
            setBroken(null)
            retry()
          }}
          onLoad={load}
        />
      </div>
    )
  return (
    <div
      className="grid h-40 max-w-md place-items-center rounded-card border border-line bg-surface-2 text-sm text-text-2"
      data-testid="video-checking"
      aria-busy="true"
    >
      <span role="status">Loading {att.name}…</span>
    </div>
  )
}

// ---- file chip ----------------------------------------------------------------------------------------------------
export function FileChip({ att }: { att: AttachmentRefT }) {
  const { state, retry, load, url } = useMediaGate(att, mediaUrl(att.media_id))
  const d = useDelivery(att, state)
  const look =
    'inline-flex min-h-11 max-w-full items-center gap-2 rounded-pill border border-line bg-surface px-3 text-sm'
  if (state === 'fetching' || state === 'failed' || state === 'gone' || state === 'removed')
    return (
      <span className={cn(look, 'flex-wrap py-1 text-text-2')} data-testid="file-chip-unavailable">
        <IconFile width={18} height={18} />
        <span className="truncate">{att.name}</span>
        <MediaStatus
          removedDays={removedAfterDays(att.media_id)}
          state={state}
          what={att.name}
          onRetry={retry}
          onLoad={load}
        />
      </span>
    )
  // No download link until the probe says the file is there: a tap in that window would land on the relay's 410.
  if (state === 'checking')
    return (
      <span className={cn(look, 'text-text-2')} data-testid="file-chip-checking" aria-busy="true">
        <IconFile width={18} height={18} />
        <span className="truncate">{att.name}</span>
        <span>{formatBytes(att.size)}</span>
      </span>
    )
  // The chip is the attachment's one Share / Download control.
  return (
    <>
      <a
        href={url}
        download={d.download}
        onClick={d.onClick}
        onPointerDown={d.onPointerDown}
        aria-label={`${d.verb} ${att.name}`}
        aria-busy={d.preparing}
        data-testid="attachment-share"
        data-prepared={d.fileReady ? 'true' : 'false'}
        className={look}
      >
        <IconFile width={18} height={18} />
        <span className="truncate">{att.name}</span>
        <span className="text-text-2">{formatBytes(att.size)}</span>
        <span className="text-text-2">· {d.busyLabel ? 'Preparing…' : d.verb}</span>
      </a>
      <DeliveryNoteView note={d.note} att={att} />
    </>
  )
}

function AttachmentBody({
  att,
  message,
  onOpenImage,
}: {
  att: AttachmentRefT
  message: MessageT
  onOpenImage: (a: AttachmentRefT) => void
}) {
  switch (att.kind) {
    case 'image':
      return <ImageAttachment att={att} onOpen={onOpenImage} />
    case 'voice_note':
      return <AudioPlayer att={att} messageId={message.id} variant="voice_note" transcript={message.transcript} />
    case 'audio':
      return <AudioPlayer att={att} messageId={`${message.id}:${att.media_id}`} variant="audio" />
    case 'html':
      return <HtmlPageCard att={att} />
    case 'video':
      return <VideoAttachment att={att} />
    default:
      return isMarkdownAtt(att) ? <MarkdownFileCard att={att} siblings={message.attachments} /> : <FileChip att={att} />
  }
}

/** A file chip is itself the Share / Download control, so it gets no second one. */
const hasOwnControl = (att: AttachmentRefT) =>
  !['image', 'voice_note', 'audio', 'html', 'video'].includes(att.kind) && !isMarkdownAtt(att)

/** Every attachment, with a Share / Download action under it (the viewer has its own). */
export function AttachmentView(props: {
  att: AttachmentRefT
  message: MessageT
  onOpenImage: (a: AttachmentRefT) => void
}) {
  return (
    <>
      <AttachmentBody {...props} />
      {hasOwnControl(props.att) ? null : <ShareButton att={props.att} />}
    </>
  )
}
