// K9c: the theme card in the app. The preview shows the draft on a sample inside the card only; Apply and Keep current are
// the ordinary card buttons; a crafted draft cannot put anything but typed token values into style; the applied theme
// arrives through the config, survives a reload, and Default theme and ?theme=default take it away.
import { bindingFrom, Card, configCardCandidate, payloadHash, STOCK_THEMES } from '@talos-app/protocol'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CardView } from '../../src/features/cards/CardView.tsx'
import { AppearanceSection } from '../../src/features/settings/sections.tsx'
import { ThemeSync } from '../../src/features/settings/ThemeSync.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { getStockTheme, pickStockTheme, resetThemeFromUrl, setStockTheme } from '../../src/lib/theme.ts'
import { renderWith, setup } from './helpers.tsx'

const paper = STOCK_THEMES.find((t) => t.name === 'paper') as (typeof STOCK_THEMES)[number]
const dusk = { ...structuredClone(paper), name: 'dusk' } as typeof paper
dusk.light['--accent'] = '#7a1fa2'
dusk.light['--on-accent'] = '#ffffff'
const root = () => document.documentElement
const accent = () => root().style.getPropertyValue('--accent')

function themeCard(value: unknown) {
  const card = Card.parse(
    configCardCandidate({
      cardId: 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6',
      threadId: 'general',
      now: '2026-11-01T10:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      origin: 'chat',
      baseRev: 0,
      reason: 'you asked for dusk',
      changes: [{ path: 'theme', old: 'talos', new: value }],
    }),
  )
  card.payload_hash = payloadHash(bindingFrom(card))
  return card
}

beforeEach(() => {
  localStorage.clear()
  root().removeAttribute('style')
  pickStockTheme('talos')
  history.replaceState(null, '', '/')
})
afterEach(cleanup)

describe('the theme preview card', () => {
  it('shows the draft on a sample inside the card, labels Apply and Keep current, and leaves the page alone', async () => {
    const card = themeCard(dusk)
    renderWith(<CardView card={card} threadName="General" />, setup({ cards: [card] }))
    const sample = await screen.findByTestId('theme-preview-sample')
    expect(sample.style.getPropertyValue('--accent')).toBe('#7a1fa2')
    expect(sample.style.getPropertyValue('--radius-card')).toBe(`${dusk.radius['--radius-card']}px`)
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Keep current' })).toBeTruthy()
    expect(accent()).toBe('')
    await userEvent.click(screen.getByRole('button', { name: 'Dark' }))
    expect(sample.style.getPropertyValue('--bg')).toBe(dusk.dark['--bg'])
  })

  it('Apply and Keep current are the ordinary card resolutions; Keep current changes no setting', async () => {
    const card = themeCard(dusk)
    const s = setup({ cards: [card] })
    const resolve = vi.spyOn(s, 'resolveCard')
    const patch = vi.spyOn(s, 'patchConfig')
    renderWith(<CardView card={card} threadName="General" />, s)
    await userEvent.click(await screen.findByRole('button', { name: 'Keep current' }))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(card.id, expect.objectContaining({ action: 'kill' })))
    expect(patch).not.toHaveBeenCalled()
    expect(accent()).toBe('')
  })

  it('a crafted draft cannot inject CSS: only typed token values reach style', async () => {
    const evil = structuredClone(dusk) as any
    evil.light['--accent'] = 'red; background: url(https://evil.example/x.png)'
    evil.light['--bg'] = 'url(https://evil.example/y.png)'
    evil.fonts['--font-ui'] = 'x}body{display:none'
    evil['--injected'] = '1'
    const card = themeCard(evil) // the card itself is only a display: the bridge would have refused this one
    renderWith(<CardView card={card} threadName="General" />, setup({ cards: [card] }))
    expect(await screen.findByText('This theme cannot be previewed.')).toBeTruthy()
    expect(screen.queryByTestId('theme-preview-sample')).toBeNull()
    expect(document.body.innerHTML).not.toContain('evil.example')
  })
})

describe('the applied custom theme', () => {
  function mount(theme?: unknown) {
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

  it('arrives through the config, paints, and survives a reload', async () => {
    const { client } = mount()
    act(() => client.store.setState((s) => ({ config: s.config && { ...s.config, theme: dusk as never } })))
    await waitFor(() => expect(accent()).toBe('#7a1fa2'))
    expect(screen.getByText(/custom theme your agent drafted/i)).toBeTruthy()
    // a reload: fresh module state, same storage
    root().removeAttribute('style')
    vi.resetModules()
    const fresh = await import('../../src/lib/theme.ts')
    fresh.applyTheme()
    expect(accent()).toBe('#7a1fa2')
  })

  it('a stored custom theme that no longer validates paints talos', async () => {
    localStorage.setItem(
      'talos-stock-theme',
      JSON.stringify({ ...dusk, light: { ...dusk.light, '--accent': 'url(x)' } }),
    )
    vi.resetModules()
    const fresh = await import('../../src/lib/theme.ts')
    fresh.applyTheme()
    expect(accent()).toBe('')
  })

  it('Default theme button writes theme null and restores talos', async () => {
    const { client, patch } = mount(dusk)
    await waitFor(() => expect(accent()).toBe('#7a1fa2'))
    await userEvent.click(screen.getByRole('button', { name: 'Default theme' }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ theme: null }))
    expect(accent()).toBe('')
    await waitFor(() => expect(client.store.getState().config?.theme).toBeUndefined())
  })

  it('?theme=default shows talos and writes no config', async () => {
    const { patch } = mount(dusk)
    await waitFor(() => expect(accent()).toBe('#7a1fa2'))
    history.replaceState(null, '', '/?theme=default')
    act(() => resetThemeFromUrl())
    expect(getStockTheme()).toBe('talos')
    expect(accent()).toBe('')
    await new Promise((r) => setTimeout(r, 30))
    expect(patch).not.toHaveBeenCalled()
    setStockTheme('talos')
  })
})
