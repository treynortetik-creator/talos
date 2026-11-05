// @vitest-environment jsdom
// WP6 review fix (M5): one malformed row never blanks the thread, and a top-level crash says what to do.
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppErrorBoundary, CHUNK_RELOAD_FLAG, leaving, pageReload, RowErrorBoundary } from '../src/ui/ErrorBoundary.tsx'

function Boom(): never {
  throw new Error('bad frame')
}

describe('error boundaries', () => {
  it('a throwing row renders "Couldn\'t show this message" and its siblings survive', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <>
        <RowErrorBoundary>
          <Boom />
        </RowErrorBoundary>
        <p>sibling</p>
      </>,
    )
    expect(screen.getByText("Couldn't show this message.")).toBeTruthy()
    expect(screen.getByText('sibling')).toBeTruthy()
  })

  it('the app boundary offers a reload', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    )
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })
})

function Lazy(): never {
  throw new TypeError('Importing a module script failed.')
}

describe('a failed lazy chunk', () => {
  let reload: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    sessionStorage.clear()
    leaving.now = false
    reload = vi.fn()
    pageReload.reload = reload as unknown as () => void
  })
  afterEach(() => {
    leaving.now = false
    pageReload.reload = () => location.reload()
  })

  it('reloads once and spends the flag when nothing is navigating (a deploy replaced the chunk)', () => {
    render(
      <AppErrorBoundary>
        <Lazy />
      </AppErrorBoundary>,
    )
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).not.toBeNull()
  })

  it('does not reload or spend the flag when the page is leaving (beforeunload fired)', () => {
    dispatchEvent(new Event('beforeunload'))
    expect(leaving.now).toBe(true)
    render(
      <AppErrorBoundary>
        <Lazy />
      </AppErrorBoundary>,
    )
    expect(reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull()
  })

  it('the row boundary behaves the same while leaving', () => {
    leaving.now = true
    render(
      <RowErrorBoundary>
        <Lazy />
      </RowErrorBoundary>,
    )
    expect(reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull()
  })

  it('a page restored from the back-forward cache is no longer leaving', () => {
    dispatchEvent(new Event('pagehide'))
    expect(leaving.now).toBe(true)
    dispatchEvent(new Event('pageshow'))
    expect(leaving.now).toBe(false)
  })
})
