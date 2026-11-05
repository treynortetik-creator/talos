import { getConfig, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

describe('setup-clock wait budget', () => {
  it('Testing Library waits get 5 s', () => {
    expect(getConfig().asyncUtilTimeout).toBe(5000)
  })

  it('vi.waitFor outlasts the library default of 1 s, and an explicit timeout still wins', async () => {
    let ready = false
    const timer = setTimeout(() => {
      ready = true
    }, 1200)
    await vi.waitFor(() => expect(ready).toBe(true))
    await waitFor(() => expect(ready).toBe(true))
    clearTimeout(timer)
    // An explicit timeout still wins. With a 50 ms timeout and a 10 ms interval the check can run about five times; if
    // the 5 s default had replaced it, it would run hundreds of times. Counting the runs needs no stopwatch and a busy
    // machine can only lower the count.
    let attempts = 0
    await expect(
      vi.waitFor(
        () => {
          attempts++
          throw new Error('never')
        },
        { timeout: 50, interval: 10 },
      ),
    ).rejects.toThrow('never')
    expect(attempts).toBeGreaterThan(0)
    expect(attempts).toBeLessThan(50)
  })
})
