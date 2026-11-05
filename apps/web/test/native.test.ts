import { describe, expect, it } from 'vitest'
import { capacitorPlatform, isNativeShell } from '../src/lib/native'

describe('capacitorPlatform', () => {
  it('is web in a normal browser (no Capacitor global)', () => {
    expect(capacitorPlatform()).toBe('web')
    expect(isNativeShell()).toBe(false)
    expect(capacitorPlatform({})).toBe('web')
    expect(capacitorPlatform(undefined)).toBe('web')
    expect(capacitorPlatform(null)).toBe('web')
  })

  it('is ios inside the shell', () => {
    const scope = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' } }
    expect(capacitorPlatform(scope)).toBe('ios')
    expect(isNativeShell(scope)).toBe(true)
  })

  it('is web when Capacitor is present but not native (web fallback build)', () => {
    expect(capacitorPlatform({ Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } })).toBe('web')
  })

  it('ignores malformed or hostile globals and never throws', () => {
    expect(capacitorPlatform({ Capacitor: 'ios' })).toBe('web')
    expect(capacitorPlatform({ Capacitor: { isNativePlatform: true } })).toBe('web')
    expect(capacitorPlatform({ Capacitor: { isNativePlatform: () => true } })).toBe('web')
    expect(capacitorPlatform({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'plan9' } })).toBe('web')
    const throwing = {
      Capacitor: {
        isNativePlatform: () => {
          throw new Error('boom')
        },
      },
    }
    expect(capacitorPlatform(throwing)).toBe('web')
  })
})

describe('isNativeShell is the iPhone shell only', () => {
  it('is false for a Capacitor Android web view and for a child frame', () => {
    expect(isNativeShell({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } })).toBe(false)
    const ios = { isNativePlatform: () => true, getPlatform: () => 'ios' }
    expect(isNativeShell({ Capacitor: ios })).toBe(true)
    expect(isNativeShell({ Capacitor: ios, top: {} })).toBe(false)
    const win: Record<string, unknown> = { Capacitor: ios }
    win.top = win
    expect(isNativeShell(win)).toBe(true)
  })
})
