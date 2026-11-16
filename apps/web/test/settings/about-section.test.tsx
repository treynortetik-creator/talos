// Settings -> About: which build runs here, on the server and on the computer, so "which version am I on" is one look.
import { render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildRows } from '../../src/features/help/HelpAbout.tsx'
import { useSections } from '../../src/features/settings/SettingsScreen.tsx'

describe('Settings -> About', () => {
  it('is a section of Settings', () => {
    const { result } = renderHook(() => useSections())
    expect(result.current.find((s) => s.id === 'about')?.title).toBe('About')
  })
  it('lists the web app, server and bridge builds', () => {
    const rows = buildRows({
      app: 'a446f3e',
      running: 'Browser',
      userAgent: undefined,
      relay: 'a446f3e',
      bridge: '0.4.1',
    })
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Web app build', 'a446f3e'],
      ['Running in', 'Browser'],
      ['Protocol', expect.stringMatching(/^v\d+$/)],
      ['Server build', 'a446f3e'],
      ['Bridge build', '0.4.1'],
    ])
  })

  it('the About block shows the bridge build from the health status', async () => {
    vi.doMock('../../src/features/health/useHealthStatus.ts', () => ({
      useHealthStatus: () => ({
        state: { status: { relay: { version: 'a446f3e' }, bridge: { version: '0.4.1' } } },
        refresh: () => {},
      }),
    }))
    vi.resetModules() // HelpAbout was loaded above with the real hook
    const { AboutBuild } = await import('../../src/features/help/HelpAbout.tsx')
    render(<AboutBuild />)
    expect(screen.getByTestId('help-build').textContent).toContain('Bridge build0.4.1')
    vi.doUnmock('../../src/features/health/useHealthStatus.ts')
  })
})
