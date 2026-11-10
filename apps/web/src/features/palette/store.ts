// Whether the palette (or the Cmd+J Needs-you list, or the New thread sheet it hosts) is open, and where focus goes back to.
import { create } from 'zustand'

export type PaletteMode = 'palette' | 'needs' | 'new'

type State = {
  mode: PaletteMode | null
  /** What had focus when it opened (or the button that opened it): Esc puts focus back there. */
  returnTo: HTMLElement | null
  open: (mode: PaletteMode, from?: HTMLElement | null) => void
  /** Cmd+K again closes it. */
  toggle: (mode: PaletteMode) => void
  close: () => void
}

export const usePalette = create<State>((set, get) => ({
  mode: null,
  returnTo: null,
  open: (mode, from) => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    const back = from ?? (active instanceof HTMLElement && active !== document.body ? active : null)
    set({ mode, returnTo: get().mode ? get().returnTo : back })
  },
  toggle: (mode) => (get().mode === mode ? get().close() : get().open(mode)),
  close: () => set({ mode: null }),
}))
