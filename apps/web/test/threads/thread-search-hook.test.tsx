import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useThreadSearch } from '../../src/features/threads/ThreadSearch.tsx'

describe('useThreadSearch', () => {
  it('opens, keeps what was typed while open, and clears it on stop', () => {
    const { result } = renderHook(() => useThreadSearch())
    expect(result.current.searching).toBe(false)
    act(() => result.current.start())
    act(() => result.current.setQuery('peer links'))
    expect(result.current).toMatchObject({ searching: true, query: 'peer links' })
    act(() => result.current.stop())
    expect(result.current).toMatchObject({ searching: false, query: '' })
  })

  it('hands out the same start and stop on every render, so an effect that lists them does not rerun each time', () => {
    const { result, rerender } = renderHook(() => useThreadSearch())
    const first = { start: result.current.start, stop: result.current.stop, setQuery: result.current.setQuery }
    act(() => result.current.start())
    rerender()
    expect(result.current.start).toBe(first.start)
    expect(result.current.stop).toBe(first.stop)
    expect(result.current.setQuery).toBe(first.setQuery)
  })
})
