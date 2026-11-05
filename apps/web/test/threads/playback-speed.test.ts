import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatSpeed, loadSpeed, nextSpeed, SPEEDS, saveSpeed } from '../../src/features/threads/speed.ts'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('playback speed helper', () => {
  it('offers 1, 1.25, 1.5, 1.75, 2 in order', () => {
    expect([...SPEEDS]).toEqual([1, 1.25, 1.5, 1.75, 2])
  })
  it('cycles and wraps', () => {
    expect(nextSpeed(1)).toBe(1.25)
    expect(nextSpeed(1.75)).toBe(2)
    expect(nextSpeed(2)).toBe(1)
  })
  it('formats labels', () => {
    expect(formatSpeed(1)).toBe('1x')
    expect(formatSpeed(1.25)).toBe('1.25x')
    expect(formatSpeed(2)).toBe('2x')
  })
  it('defaults to 1 and round-trips', () => {
    expect(loadSpeed()).toBe(1)
    saveSpeed(1.75)
    expect(loadSpeed()).toBe(1.75)
  })
  it('ignores junk values', () => {
    localStorage.setItem('talos.audio.speed', '3.3')
    expect(loadSpeed()).toBe(1)
    localStorage.setItem('talos.audio.speed', 'abc')
    expect(loadSpeed()).toBe(1)
  })
  it('survives throwing storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(loadSpeed()).toBe(1)
    expect(() => saveSpeed(2)).not.toThrow()
  })
})
