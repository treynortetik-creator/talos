// The page counts as leaving only while a navigation that leaves is under way. A download leaves the page where it is, so
// a stale chunk must still reload.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeNavigation extends EventTarget {}

describe('the leaving flag and the Navigation API', () => {
  let nav: FakeNavigation
  let leaving: { now: boolean }
  beforeEach(async () => {
    vi.resetModules()
    nav = new FakeNavigation()
    ;(window as unknown as { navigation: EventTarget }).navigation = nav
    leaving = (await import('../../src/ui/ErrorBoundary.tsx')).leaving
    leaving.now = false
  })
  afterEach(() => {
    delete (window as unknown as { navigation?: EventTarget }).navigation
  })
  const navigate = (props: Record<string, unknown>) => {
    const e = new Event('navigate')
    Object.assign(e, props)
    nav.dispatchEvent(e)
  }

  it('a navigation to another document is leaving', () => {
    navigate({ destination: { sameDocument: false }, downloadRequest: null })
    expect(leaving.now).toBe(true)
  })

  it('a download request does not leave the page', () => {
    navigate({ destination: { sameDocument: false }, downloadRequest: 'photo.png' })
    expect(leaving.now).toBe(false)
  })
})
