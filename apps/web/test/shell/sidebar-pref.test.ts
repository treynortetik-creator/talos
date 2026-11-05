import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIDEBAR_PREF_KEY, setSidebarCollapsed, toggleSidebar } from '../../src/features/threads/sidebarPref.ts'

afterEach(() => {
  setSidebarCollapsed(false)
  vi.restoreAllMocks()
})

describe('sidebar preference', () => {
  it('is written to this device and removed when open again', () => {
    setSidebarCollapsed(true)
    expect(localStorage.getItem(SIDEBAR_PREF_KEY)).toBe('1')
    toggleSidebar()
    expect(localStorage.getItem(SIDEBAR_PREF_KEY)).toBeNull()
  })
  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => setSidebarCollapsed(true)).not.toThrow()
  })
})
