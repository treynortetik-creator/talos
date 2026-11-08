import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_DOCK_KEY,
  setSessionDockOpen,
  toggleSessionDock,
  useSessionDockOpen,
} from '../../src/features/session/dockPref.ts'

afterEach(() => {
  setSessionDockOpen(false)
  vi.restoreAllMocks()
})

describe('session panel open or closed', () => {
  it('is closed until the owner opens it, then written to this device', () => {
    expect(localStorage.getItem(SESSION_DOCK_KEY)).toBeNull()
    setSessionDockOpen(true)
    expect(localStorage.getItem(SESSION_DOCK_KEY)).toBe('1')
    toggleSessionDock()
    expect(localStorage.getItem(SESSION_DOCK_KEY)).toBeNull()
  })
  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => setSessionDockOpen(true)).not.toThrow()
  })
  it('still opens and closes in memory when storage throws (the choice just is not kept)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const { result } = renderHook(() => useSessionDockOpen())
    expect(result.current).toBe(false)
    act(() => toggleSessionDock())
    expect(result.current).toBe(true)
    act(() => toggleSessionDock())
    expect(result.current).toBe(false)
  })
})
