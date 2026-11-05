// Full-viewport image viewer: fits the image to 92% of the screen (small images scale up), wheel / trackpad-pinch /
// touch-pinch zoom about the pointer up to 8x, drag to pan, double-click or double-tap toggles fit and 2x, keys + - 0.
// Radix Dialog supplies the focus trap, Escape, scroll lock and aria-modal; the transform is written straight to the
// element (no React renders per wheel tick). Save / Share (audit L15) is a plain link to the file: a browser downloads it,
// and the iPhone shell opens relay /media/ URLs in its system preview, which has Share.

import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { AttachmentRefT } from '@talos-app/protocol'
import { useEffect, useRef } from 'react'
import { IconClose } from '../../ui/icons.tsx'
import { useMediaSrc } from './media.ts'
import { ShareButton } from './ShareButton.tsx'

export const FIT_FRACTION = 0.92
export const MAX_ZOOM = 8
export const DOUBLE_ZOOM = 2

export type Transform = { s: number; x: number; y: number }
export const FIT: Transform = { s: 1, x: 0, y: 0 }

/** Scale that fits a natural-size image inside `fraction` of the stage, scaling small images up. */
export function fitScale(nw: number, nh: number, vw: number, vh: number, fraction = FIT_FRACTION): number {
  if (!nw || !nh || !vw || !vh) return 1
  return Math.min((vw * fraction) / nw, (vh * fraction) / nh)
}

/** Keeps the zoomed image covering the stage on each axis it is larger than; centres it on axes where it is smaller. */
export function clampTransform(t: Transform, w: number, h: number, vw: number, vh: number): Transform {
  const s = Math.min(MAX_ZOOM, Math.max(1, t.s))
  const mx = Math.max(0, (w * s - vw) / 2)
  const my = Math.max(0, (h * s - vh) / 2)
  return { s, x: Math.min(mx, Math.max(-mx, t.x)), y: Math.min(my, Math.max(-my, t.y)) }
}

/**
 * New transform with scale `s2` that keeps the image point under (px, py) fixed. Coordinates are relative to the stage
 * centre, which is the image's transform origin.
 */
export function zoomAbout(t: Transform, s2: number, px: number, py: number): Transform {
  const k = s2 / t.s
  return { s: s2, x: px - (px - t.x) * k, y: py - (py - t.y) * k }
}

// The button that opened the viewer; focus returns there on close (Safari does not focus buttons on click, so the
// active element is not a reliable record).
let opener: HTMLElement | null = null
export function rememberOpener(el: HTMLElement | null) {
  opener = el
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function ImageViewer({ att, onClose }: { att: AttachmentRefT | null; onClose: () => void }) {
  return (
    <DialogPrimitive.Root open={att !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-testid="image-viewer"
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            if (opener?.isConnected) opener.focus()
          }}
          className="fixed inset-0 z-50 overflow-hidden bg-black/90 text-white outline-none"
        >
          <DialogPrimitive.Title className="sr-only">{att?.name ?? 'Image'}</DialogPrimitive.Title>
          {att && <ZoomStage key={att.media_id} att={att} onClose={onClose} />}
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute right-[max(0.5rem,env(safe-area-inset-right))] top-[max(0.5rem,env(safe-area-inset-top))] z-10 grid size-11 place-items-center rounded-pill bg-black/60 text-white focus-visible:outline-2 focus-visible:outline-focus"
          >
            <IconClose width={20} height={20} />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function ZoomStage({ att, onClose }: { att: AttachmentRefT; onClose: () => void }) {
  const { src, onError, state, retry } = useMediaSrc(att)
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const tf = useRef<Transform>(FIT)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const base = useRef({ w: 0, h: 0 }) // displayed size at fit (before the transform scale)

  useEffect(() => {
    const stage = stageRef.current
    const img = imgRef.current
    if (!stage || !img) return
    const el = img
    const view = () => ({ w: stage.clientWidth, h: stage.clientHeight })
    const apply = (next: Transform, smooth = false) => {
      const { w, h } = view()
      tf.current = clampTransform(next, base.current.w, base.current.h, w, h)
      const t = tf.current
      el.style.transition = smooth && !reducedMotion() ? 'transform 140ms ease-out' : 'none'
      el.style.transform = `translate(-50%, -50%) translate(${t.x}px, ${t.y}px) scale(${t.s})`
      el.dataset.zoom = String(Math.round(t.s * 1000) / 1000)
      stage.style.cursor = t.s > 1 ? 'grab' : ''
    }
    const layout = () => {
      const nw = el.naturalWidth || att.width || 0
      const nh = el.naturalHeight || att.height || 0
      const { w, h } = view()
      if (!nw || !nh) return
      const f = fitScale(nw, nh, w, h)
      base.current = { w: nw * f, h: nh * f }
      el.style.width = `${base.current.w}px`
      el.style.height = `${base.current.h}px`
      el.style.visibility = 'visible'
      apply(tf.current)
    }
    const centre = () => {
      const { w, h } = view()
      const r = stage.getBoundingClientRect()
      return { cx: r.left + w / 2, cy: r.top + h / 2 }
    }
    // Pointer capture retargets click events to the stage, so "on the image" is a rectangle test, not e.target.
    const onImage = (e: MouseEvent | PointerEvent) => {
      if (e.target === el) return true
      const r = el.getBoundingClientRect()
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    }
    const zoomTo = (s2: number, clientX: number, clientY: number, smooth: boolean) => {
      const { cx, cy } = centre()
      apply(zoomAbout(tf.current, Math.min(MAX_ZOOM, Math.max(1, s2)), clientX - cx, clientY - cy), smooth)
    }
    const zoomCentre = (s2: number) => {
      const { cx, cy } = centre()
      zoomTo(s2, cx, cy, true)
    }

    // Wheel and trackpad pinch (ctrlKey). Non-passive: only this listener, only while the viewer is open.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
      const k = e.ctrlKey ? 0.012 : 0.0015
      zoomTo(tf.current.s * Math.exp(-dy * k), e.clientX, e.clientY, !e.ctrlKey && Math.abs(dy) >= 50)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })

    // Pointer gestures: one pointer pans (when zoomed), two pinch. A short, still tap on the backdrop closes.
    const pts = new Map<number, { x: number; y: number }>()
    let start: { t: Transform; mid: { x: number; y: number }; dist: number } | null = null
    let moved = false
    let lastTap = 0
    const snapshot = () => {
      const p = [...pts.values()]
      const a = p[0]
      const b = p[1]
      if (!a) return null
      return b
        ? {
            t: tf.current,
            mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
            dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          }
        : { t: tf.current, mid: { x: a.x, y: a.y }, dist: 0 }
    }
    const onDown = (e: PointerEvent) => {
      try {
        stage.setPointerCapture(e.pointerId)
      } catch {}
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pts.size === 1) moved = false
      start = snapshot()
    }
    const onMove = (e: PointerEvent) => {
      if (!pts.has(e.pointerId) || !start) return
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const cur = snapshot()
      if (!cur) return
      const { cx, cy } = centre()
      if (Math.hypot(cur.mid.x - start.mid.x, cur.mid.y - start.mid.y) > 6 || pts.size > 1) moved = true
      if (pts.size >= 2 && start.dist) {
        const s2 = Math.min(MAX_ZOOM, Math.max(1, start.t.s * (cur.dist / start.dist)))
        const z = zoomAbout(start.t, s2, start.mid.x - cx, start.mid.y - cy)
        apply({ ...z, x: z.x + (cur.mid.x - start.mid.x), y: z.y + (cur.mid.y - start.mid.y) })
      } else if (tf.current.s > 1 && pts.size === 1) {
        apply({ ...start.t, x: start.t.x + (cur.mid.x - start.mid.x), y: start.t.y + (cur.mid.y - start.mid.y) })
        stage.style.cursor = 'grabbing'
      }
    }
    const onUp = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return
      stage.style.cursor = tf.current.s > 1 ? 'grab' : ''
      start = snapshot()
      // Double-tap on touch toggles fit / 2x (mouse uses dblclick).
      if (e.pointerType === 'touch' && !moved && pts.size === 0 && onImage(e)) {
        const now = e.timeStamp
        if (now - lastTap < 300) {
          lastTap = 0
          zoomTo(tf.current.s > 1.01 ? 1 : DOUBLE_ZOOM, e.clientX, e.clientY, true)
        } else lastTap = now
      }
    }
    const onDblClick = (e: MouseEvent) => {
      if (!onImage(e)) return
      zoomTo(tf.current.s > 1.01 ? 1 : DOUBLE_ZOOM, e.clientX, e.clientY, true)
    }
    // Backdrop click closes (via the Radix close button); a drag that ends on the backdrop must not.
    const onClick = (e: MouseEvent) => {
      if (!moved && !onImage(e)) closeRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === '+' || e.key === '=') zoomCentre(tf.current.s * 1.25)
      else if (e.key === '-' || e.key === '_') zoomCentre(tf.current.s / 1.25)
      else if (e.key === '0') apply(FIT, true)
      else return
      e.preventDefault()
    }
    stage.addEventListener('pointerdown', onDown)
    stage.addEventListener('pointermove', onMove)
    stage.addEventListener('pointerup', onUp)
    stage.addEventListener('pointercancel', onUp)
    stage.addEventListener('dblclick', onDblClick)
    stage.addEventListener('click', onClick)
    const root = stage.closest('[role="dialog"]') ?? stage
    root.addEventListener('keydown', onKey as EventListener)
    const ro = new ResizeObserver(layout)
    ro.observe(stage)
    el.addEventListener('load', layout)
    layout()
    return () => {
      stage.removeEventListener('wheel', onWheel)
      stage.removeEventListener('pointerdown', onDown)
      stage.removeEventListener('pointermove', onMove)
      stage.removeEventListener('pointerup', onUp)
      stage.removeEventListener('pointercancel', onUp)
      stage.removeEventListener('dblclick', onDblClick)
      stage.removeEventListener('click', onClick)
      root.removeEventListener('keydown', onKey as EventListener)
      el.removeEventListener('load', layout)
      ro.disconnect()
    }
  }, [att.width, att.height])

  // The notices sit beside the stage, not inside it: the stage captures the pointer, which would swallow a tap on Retry.
  return (
    <>
      <div ref={stageRef} data-testid="image-stage" className="absolute inset-0 touch-none select-none overscroll-none">
        <img
          ref={imgRef}
          src={src}
          alt={att.name}
          onError={onError}
          draggable={false}
          style={{ visibility: 'hidden' }}
          className="absolute left-1/2 top-1/2 max-w-none will-change-transform"
        />
      </div>
      {state === 'ok' && <ShareButton att={att} floating />}
      {state === 'fetching' && (
        <p
          role="status"
          data-testid="viewer-fetching"
          className="pointer-events-none absolute inset-0 grid place-items-center text-sm"
        >
          Getting this image from your Mac…
        </p>
      )}
      {state === 'failed' && (
        <div
          role="alert"
          data-testid="viewer-failed"
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-sm"
        >
          <p>Couldn't load this image. Your Mac may be asleep, or the file is no longer there.</p>
          <button
            type="button"
            onClick={retry}
            className="pointer-events-auto min-h-11 rounded-pill bg-white/15 px-5 font-semibold text-white focus-visible:outline-2 focus-visible:outline-focus"
          >
            Retry
          </button>
        </div>
      )}
    </>
  )
}
