// @vitest-environment jsdom
// The way back from a theme the owner cannot read: `?theme=default`, and a "Reset theme" link on the sign-in screen. It
// repaints THIS device only. It never writes the config, and it leaves nothing behind that could write it later.
import { STOCK_THEMES } from '@talos-app/protocol'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from '../../src/features/auth/LoginPage.tsx'
import { AppearanceSection } from '../../src/features/settings/sections.tsx'
import { ThemeSync } from '../../src/features/settings/ThemeSync.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { getStockTheme, pickStockTheme, resetThemeFromUrl, setStockTheme } from '../../src/lib/theme.ts'

const root = () => document.documentElement
const accent = () => root().style.getPropertyValue('--accent')
const byName = (n: string) => STOCK_THEMES.find((t) => t.name === n) as (typeof STOCK_THEMES)[number]
const paper = byName('paper')
const hearth = byName('hearth')
const resetKeys = () => Object.keys(localStorage).filter((k) => /reset/i.test(k))
const settle = () => new Promise((r) => setTimeout(r, 30))

beforeEach(() => {
  localStorage.clear()
  root().removeAttribute('style')
  pickStockTheme('talos')
  history.replaceState(null, '', '/')
})
afterEach(cleanup)

function mount(theme?: string) {
  const client = createFakeClient()
  if (theme) client.store.setState((s) => ({ config: s.config && { ...s.config, theme: theme as never } }))
  const patch = vi.spyOn(client, 'patchConfig')
  render(
    <ClientProvider client={client}>
      <ThemeSync />
      <AppearanceSection readOnly={false} />
    </ClientProvider>,
  )
  return { client, patch }
}
const setConfigTheme = (client: ReturnType<typeof createFakeClient>, theme: string | undefined) =>
  act(() => client.store.setState((s) => ({ config: s.config && { ...s.config, theme: theme as never } })))

describe('?theme=default', () => {
  it('shows talos at once and takes the parameter out of the address', () => {
    setStockTheme('hearth')
    expect(accent()).toBe(hearth.light['--accent'])
    history.replaceState(null, '', '/settings?theme=default&x=1#a')
    resetThemeFromUrl()
    expect(getStockTheme()).toBe('talos')
    expect(accent()).toBe('')
    expect(location.pathname + location.search + location.hash).toBe('/settings?x=1#a')
  })
  it('any other value changes nothing', () => {
    setStockTheme('hearth')
    history.replaceState(null, '', '/?theme=paper')
    resetThemeFromUrl()
    expect(getStockTheme()).toBe('hearth')
    expect(location.search).toBe('?theme=paper')
  })
  it('sends zero config patches, even once the config has loaded and changed', async () => {
    history.replaceState(null, '', '/?theme=default')
    resetThemeFromUrl()
    const { client, patch } = mount('paper')
    await settle()
    setConfigTheme(client, 'hearth')
    await settle()
    expect(patch).not.toHaveBeenCalled()
    expect(client.store.getState().config?.theme).toBe('hearth')
  })
  it('with config.theme=paper the page renders talos once the parameter was given', async () => {
    history.replaceState(null, '', '/?theme=default')
    resetThemeFromUrl()
    mount('paper')
    await settle()
    expect(accent()).toBe('')
    expect(getStockTheme()).toBe('talos')
  })
  it('the owner picking a theme afterwards is an ordinary pick: applied and written', async () => {
    history.replaceState(null, '', '/?theme=default')
    resetThemeFromUrl()
    const { client, patch } = mount('paper')
    await userEvent.click(screen.getByRole('radio', { name: 'Hearth' }))
    expect(accent()).toBe(hearth.light['--accent'])
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ theme: 'hearth' }))
    await waitFor(() => expect(client.store.getState().config?.theme).toBe('hearth'))
  })
  it('keeps no reset marker in storage', () => {
    history.replaceState(null, '', '/?theme=default')
    resetThemeFromUrl()
    expect(resetKeys()).toEqual([])
  })
})

describe('a failed patch leaves nothing behind', () => {
  it('mac_offline on Default theme, then another device sets hearth: hearth shows and no second patch is sent', async () => {
    const { client, patch } = mount('paper')
    await waitFor(() => expect(accent()).toBe(paper.light['--accent']))
    client.failNextPatchWith('mac_offline')
    await userEvent.click(screen.getByRole('button', { name: 'Default theme' }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    setConfigTheme(client, 'hearth')
    await waitFor(() => expect(accent()).toBe(hearth.light['--accent']))
    await settle()
    expect(patch).toHaveBeenCalledTimes(1)
    expect(client.store.getState().config?.theme).toBe('hearth')
    expect(resetKeys()).toEqual([])
  })
})

describe('sign-in screen', () => {
  it('has a visible Reset theme link that puts talos back on this device without writing anything', async () => {
    setStockTheme('hearth')
    const client = createFakeClient()
    const patch = vi.spyOn(client, 'patchConfig')
    render(
      <StorageProvider storage={createMemoryStorage()}>
        <ClientProvider client={client}>
          <MemoryRouter>
            <LoginPage />
          </MemoryRouter>
        </ClientProvider>
      </StorageProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Reset theme' }))
    expect(getStockTheme()).toBe('talos')
    expect(accent()).toBe('')
    expect(patch).not.toHaveBeenCalled()
    expect(resetKeys()).toEqual([])
  })
})
