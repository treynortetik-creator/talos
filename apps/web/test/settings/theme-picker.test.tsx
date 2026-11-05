// @vitest-environment jsdom
// Settings > Appearance > Theme: the owner picks one of the three stock themes. The pick is written to the owner's config
// (so every device follows) and applied at once; Default goes back to talos. Light/dark/system stays a per-device choice.
import { STOCK_THEMES } from '@talos-app/protocol'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppearanceSection } from '../../src/features/settings/sections.tsx'
import { ThemeSync } from '../../src/features/settings/ThemeSync.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { applyTheme, setStockTheme, setTheme } from '../../src/lib/theme.ts'

const root = () => document.documentElement
const accent = () => root().style.getPropertyValue('--accent')
const paper = STOCK_THEMES.find((t) => t.name === 'paper') as (typeof STOCK_THEMES)[number]
const hearth = STOCK_THEMES.find((t) => t.name === 'hearth') as (typeof STOCK_THEMES)[number]

beforeEach(() => {
  localStorage.clear()
  root().removeAttribute('style')
  root().removeAttribute('data-theme')
  setStockTheme('talos')
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount(initial?: string) {
  const client = createFakeClient()
  if (initial) client.store.setState((s) => ({ config: s.config && { ...s.config, theme: initial as never } }))
  render(
    <ClientProvider client={client}>
      <ThemeSync />
      <AppearanceSection readOnly={false} />
    </ClientProvider>,
  )
  return client
}

describe('theme picker', () => {
  it('lists the three stock themes by name and a swatch, with talos checked when the config has no theme', () => {
    mount()
    const group = screen.getByRole('radiogroup', { name: 'Colour theme' })
    expect(group).toBeTruthy()
    for (const name of ['Talos', 'Paper', 'Hearth']) expect(screen.getByRole('radio', { name })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Talos' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getAllByTestId('theme-swatch')).toHaveLength(3)
  })

  it('choosing Paper changes the computed --accent at once and writes it to the config', async () => {
    const client = mount()
    expect(accent()).toBe('')
    await userEvent.click(screen.getByRole('radio', { name: 'Paper' }))
    expect(accent()).toBe(paper.light['--accent'])
    await waitFor(() => expect(client.store.getState().config?.theme).toBe('paper'))
    expect(screen.getByRole('radio', { name: 'Paper' }).getAttribute('aria-checked')).toBe('true')
    await userEvent.click(screen.getByRole('radio', { name: 'Hearth' }))
    expect(accent()).toBe(hearth.light['--accent'])
    await waitFor(() => expect(client.store.getState().config?.theme).toBe('hearth'))
  })

  it('follows light and dark on this device: the same theme, the other mode', async () => {
    mount()
    await userEvent.click(screen.getByRole('radio', { name: 'Paper' }))
    setTheme('dark')
    expect(root().style.getPropertyValue('--bg')).toBe(paper.dark['--bg'])
    setTheme('light')
    expect(root().style.getPropertyValue('--bg')).toBe(paper.light['--bg'])
  })

  it('the Default theme button goes back to talos: inline tokens removed, config key removed', async () => {
    const client = mount()
    await userEvent.click(screen.getByRole('radio', { name: 'Hearth' }))
    await waitFor(() => expect(client.store.getState().config?.theme).toBe('hearth'))
    await userEvent.click(screen.getByRole('button', { name: 'Default theme' }))
    expect(accent()).toBe('')
    expect(root().style.getPropertyValue('--figure-text')).toBe('')
    await waitFor(() => expect(client.store.getState().config?.theme).toBeUndefined())
    expect(screen.getByRole('radio', { name: 'Talos' }).getAttribute('aria-checked')).toBe('true')
  })

  it('a theme that arrives in the config (another device chose it) is applied here', async () => {
    const client = mount()
    act(() => client.store.setState((s) => ({ config: s.config && { ...s.config, theme: 'hearth' as never } })))
    await waitFor(() => expect(accent()).toBe(hearth.light['--accent']))
    act(() => client.store.setState((s) => ({ config: s.config && { ...s.config, theme: undefined } })))
    await waitFor(() => expect(accent()).toBe(''))
  })

  it('is applied on launch from the saved local copy, before any config has arrived', () => {
    // main.tsx calls applyTheme() before the app mounts: config is absent, only this device's copy says paper
    localStorage.setItem('talos-stock-theme', 'paper')
    const client = createFakeClient()
    client.store.setState({ config: null })
    applyTheme()
    expect(accent()).toBe(paper.light['--accent'])
    render(
      <ClientProvider client={client}>
        <ThemeSync />
      </ClientProvider>,
    )
    // still no config: the saved copy stays in force
    expect(accent()).toBe(paper.light['--accent'])
  })

  it('under Paper, follows the system light/dark switch live, and an explicit choice beats it', () => {
    let dark = true
    const listeners = new Set<() => void>()
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return dark
      },
      addEventListener: (_: string, f: () => void) => listeners.add(f),
      removeEventListener: (_: string, f: () => void) => listeners.delete(f),
    }))
    localStorage.setItem('talos-stock-theme', 'paper')
    const client = createFakeClient()
    client.store.setState({ config: null })
    render(
      <ClientProvider client={client}>
        <ThemeSync />
      </ClientProvider>,
    )
    applyTheme()
    expect(root().style.getPropertyValue('--bg')).toBe(paper.dark['--bg'])
    dark = false
    for (const f of listeners) f()
    expect(root().style.getPropertyValue('--bg')).toBe(paper.light['--bg'])
    dark = true
    for (const f of listeners) f()
    expect(root().style.getPropertyValue('--bg')).toBe(paper.dark['--bg'])
    setTheme('light')
    expect(root().style.getPropertyValue('--bg')).toBe(paper.light['--bg'])
  })

  it('a real refusal (config_field_forbidden) puts the previous theme back and says so', async () => {
    const client = mount()
    client.failNextPatchWith('config_field_forbidden')
    await userEvent.click(screen.getByRole('radio', { name: 'Paper' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(accent()).toBe('')
    expect(screen.getByRole('radio', { name: 'Talos' }).getAttribute('aria-checked')).toBe('true')
  })

  it('a step-up refusal puts the previous theme back too', async () => {
    const client = mount()
    client.failNextPatchWith('stepup_required')
    await userEvent.click(screen.getByRole('radio', { name: 'Hearth' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(accent()).toBe('')
    expect(screen.getByRole('radio', { name: 'Talos' }).getAttribute('aria-checked')).toBe('true')
  })

  it('Mac offline: the relay keeps the patch, so the pick stays and a quiet note says it applies later', async () => {
    const client = mount()
    client.failNextPatchWith('mac_offline')
    await userEvent.click(screen.getByRole('radio', { name: 'Paper' }))
    const note = await screen.findByRole('status')
    expect(note.textContent).toBe('Saved. It applies on your other devices when your Mac is back.')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(accent()).toBe(paper.light['--accent'])
    expect(screen.getByRole('radio', { name: 'Paper' }).getAttribute('aria-checked')).toBe('true')
  })

  it('the Default theme button is an ordinary pick of talos: the same patch as tapping Talos', async () => {
    const client = mount('hearth')
    const spy = vi.spyOn(client, 'patchConfig')
    await userEvent.click(screen.getByRole('button', { name: 'Default theme' }))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    const viaButton = spy.mock.calls[0]
    expect(viaButton?.[0]).toEqual({ theme: null })
    await userEvent.click(screen.getByRole('radio', { name: 'Hearth' }))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    await userEvent.click(screen.getByRole('radio', { name: 'Talos' }))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3))
    expect(spy.mock.calls[2]).toEqual(viaButton)
  })

  it('is read only for a device that cannot write settings', () => {
    const client = createFakeClient()
    render(
      <ClientProvider client={client}>
        <AppearanceSection readOnly />
      </ClientProvider>,
    )
    expect((screen.getByRole('radio', { name: 'Paper' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
