// The visual viewport (what is actually on screen: pinch zoom and the on-screen keyboard change it, the layout viewport does not).
// The approval sheet is sized from it so a keyboard cannot pan it away, and a zoom above 1 turns Allow off.
import { useEffect, useState } from 'react'

export type ViewportBox = { top: number; left: number; width: number; height: number; scale: number }

const read = (): ViewportBox => {
  const v = window.visualViewport
  return v
    ? { top: v.offsetTop, left: v.offsetLeft, width: v.width, height: v.height, scale: v.scale }
    : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight, scale: 1 }
}

export function useVisualViewport(): ViewportBox {
  const [box, setBox] = useState(read)
  useEffect(() => {
    const v = window.visualViewport
    const on = () => setBox(read())
    v?.addEventListener('resize', on)
    v?.addEventListener('scroll', on)
    window.addEventListener('resize', on)
    on()
    return () => {
      v?.removeEventListener('resize', on)
      v?.removeEventListener('scroll', on)
      window.removeEventListener('resize', on)
    }
  }, [])
  return box
}
