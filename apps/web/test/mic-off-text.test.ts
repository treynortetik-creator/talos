import { afterEach, describe, expect, it, vi } from 'vitest'
import { micOffText } from '../src/lib/micOff.ts'

describe('the microphone-off hint', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('points at macOS System Settings in the Mac app', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Safari TalosDesktop/1.0' })
    vi.stubGlobal('webkit', { messageHandlers: { talos: { postMessage: () => {} } } })
    expect(micOffText()).toMatch(/System Settings → Privacy & Security → Microphone/)
  })
  it('points at the iPhone Settings app elsewhere', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone) Safari' })
    expect(micOffText()).toMatch(/Settings → Talos → Microphone/)
  })
})
