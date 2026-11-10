// The phone's pull-down: a deliberate pull from the very top of a list opens the palette. A normal scroll never does: the gesture counts
// only if nothing in the touched chain was scrolled at the start or at any moment, the finger never went up, it ends well down, and it
// is mostly vertical. Anything else is left to the browser.
export const PULL_PX = 96

export function attachPullToSearch(el: HTMLElement, onPull: () => void): () => void {
  let start: { x: number; y: number; chain: HTMLElement[] } | null = null
  let dead = false

  const point = (e: Event) => {
    const t = e as Event & {
      touches?: ArrayLike<{ clientX: number; clientY: number }>
      changedTouches?: ArrayLike<{ clientX: number; clientY: number }>
    }
    return t.touches?.[0] ?? t.changedTouches?.[0]
  }
  const atTop = (chain: HTMLElement[]) => chain.every((n) => n.scrollTop <= 0)

  const onStart = (e: Event) => {
    const p = point(e)
    const touches = (e as Event & { touches?: ArrayLike<unknown> }).touches
    if (!p || (touches && touches.length > 1)) {
      start = null
      return
    }
    const chain: HTMLElement[] = []
    for (let n = e.target instanceof HTMLElement ? e.target : el; n; n = n.parentElement as HTMLElement) {
      chain.push(n)
      if (n === el) break
    }
    if (!chain.includes(el)) chain.push(el)
    dead = !atTop(chain)
    start = { x: p.clientX, y: p.clientY, chain }
  }
  const onMove = (e: Event) => {
    const p = point(e)
    if (!start || !p || dead) return
    if (!atTop(start.chain) || p.clientY - start.y < -10) dead = true
  }
  const onEnd = (e: Event) => {
    const p = point(e)
    const s = start
    start = null
    if (!s || !p || dead || !atTop(s.chain)) return
    const dy = p.clientY - s.y
    const dx = Math.abs(p.clientX - s.x)
    if (dy >= PULL_PX && dx <= dy / 2) onPull()
  }
  const onCancel = () => {
    start = null
  }

  el.addEventListener('touchstart', onStart, { passive: true })
  el.addEventListener('touchmove', onMove, { passive: true })
  el.addEventListener('touchend', onEnd, { passive: true })
  el.addEventListener('touchcancel', onCancel, { passive: true })
  return () => {
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchmove', onMove)
    el.removeEventListener('touchend', onEnd)
    el.removeEventListener('touchcancel', onCancel)
  }
}
