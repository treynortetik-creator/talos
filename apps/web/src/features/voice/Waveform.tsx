import { useEffect, useRef } from 'react'
import type { CallController } from './callController.ts'

const BAR_IDS = Array.from({ length: 28 }, (_, i) => `bar-${i}`)

/** Live level bars: the owner's input in `--text`, the agent's output in `--accent`. Reads levels outside React state. */
export function Waveform({ controller, active }: { controller: CallController; active: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = root.current
    if (!el) return
    const bars = Array.from(el.children) as HTMLElement[]
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!active || reduced) {
      // At rest the bars hold a quiet, fixed wave shape (not a flat dotted line) at reduced strength.
      bars.forEach((b, i) => {
        b.style.transform = `scaleY(${(0.22 + 0.32 * Math.abs(Math.sin(i * 0.55)) * (0.6 + 0.4 * Math.cos(i * 0.21))).toFixed(3)})`
        b.style.background = 'var(--text-2)'
      })
      return
    }
    let raf = 0
    let smooth = 0
    const tick = (t: number) => {
      const { input, output } = controller.levels
      const level = Math.max(input, output)
      smooth += (level - smooth) * 0.35
      const color = output > input ? 'var(--accent)' : 'var(--text)'
      bars.forEach((b, i) => {
        const wobble = 0.55 + 0.45 * Math.sin(t / 140 + i * 0.7)
        b.style.transform = `scaleY(${Math.max(0.12, Math.min(1, 0.12 + smooth * wobble * 1.4))})`
        b.style.background = color
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [controller, active])
  return (
    <div
      ref={root}
      aria-hidden="true"
      className="flex h-10 min-w-0 flex-1 items-center justify-center gap-[2px] overflow-hidden"
    >
      {BAR_IDS.map((id) => (
        <span
          key={id}
          className="h-full w-[3px] min-w-px shrink origin-center rounded-pill bg-text"
          style={{ transform: 'scaleY(0.15)' }}
        />
      ))}
    </div>
  )
}
