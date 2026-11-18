// Settings > Developer: the rows are drawn from DEV_ROWS, each switch is one owner-signed config patch, and Developer mode moves
// only the rows whose open setting differs from the default. Uses the fake client's own patchConfig (it changes the store).
// Neutral fixtures only.
import { DEV_ROWS } from '@talos-app/protocol'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeveloperSection } from '../../src/features/settings/DeveloperSection.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

afterEach(() => cleanup())

type Dev = Record<string, unknown> | 'missing'

function mount(opts: { dev?: Dev; macOnline?: boolean; link?: boolean; hold?: boolean } = {}) {
  const client = createFakeClient()
  const s = client.store.getState()
  const base = s.config as unknown as Record<string, unknown>
  const { dev: _drop, ...noDev } = base
  const dev = opts.dev ?? { thread_fence: true, note_lookup: true }
  client.store.setState({
    presence: { ...s.presence, bridge_online: opts.macOnline ?? true },
    ...(opts.link === false ? { connection: 'reconnecting' as const } : {}),
    config: dev === 'missing' ? noDev : { ...noDev, dev },
  } as never)
  // `hold` keeps the call open until released, so a second tap can land while the first is saving
  const real = client.patchConfig.bind(client)
  let release: () => void = () => {}
  const patch = vi.spyOn(client, 'patchConfig').mockImplementation(async (p) => {
    if (opts.hold) await new Promise<void>((r) => (release = r))
    return real(p)
  })
  render(
    <ClientProvider client={client}>
      <DeveloperSection readOnly={false} />
    </ClientProvider>,
  )
  return { patch, client, release: () => release() }
}

const rowSwitch = (key: string) => within(screen.getByTestId(`dev-row-${key}`)).getByRole('switch')
const master = () => within(screen.getByTestId('dev-mode')).getByRole('switch')
const checked = (el: HTMLElement) => el.getAttribute('aria-checked')

describe('Developer page', () => {
  it('lists exactly the DEV_ROWS titles, in order', () => {
    mount()
    const titles = screen.getAllByRole('switch').slice(1) // the first is Developer mode
    expect(titles.map((t) => document.querySelector(`label[for="${t.id}"]`)?.textContent)).toEqual(
      DEV_ROWS.map((r) => r.title),
    )
  })

  it('nothing is written on mount', () => {
    const { patch } = mount()
    expect(patch).not.toHaveBeenCalled()
  })

  it('reads a false value as off and a missing one as on', () => {
    mount({ dev: { thread_fence: false } })
    expect(checked(rowSwitch('thread_fence'))).toBe('false')
    expect(checked(rowSwitch('note_lookup'))).toBe('true')
    cleanup()
    mount({ dev: 'missing' })
    expect(checked(rowSwitch('thread_fence'))).toBe('true')
  })

  it.each([0, 'false', null, {}])('a garbled thread_fence (%j) reads as on', (v) => {
    mount({ dev: { thread_fence: v, note_lookup: true } })
    expect(checked(rowSwitch('thread_fence'))).toBe('true')
  })

  it('a tap sends only that row, and the switch follows the saved config', async () => {
    const { patch } = mount()
    await act(async () => userEvent.click(rowSwitch('thread_fence')))
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenLastCalledWith({ dev: { thread_fence: false } })
    // the save signs with WebCrypto, which act() does not wait for: on a loaded machine it lands after the click returns
    await waitFor(() => expect(checked(rowSwitch('thread_fence'))).toBe('false'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('Developer mode reads only the rows it moves: the notes choice never changes it', () => {
    mount()
    expect(checked(master())).toBe('false')
    cleanup()
    mount({ dev: { thread_fence: false, note_lookup: false } })
    expect(checked(master())).toBe('true')
    cleanup()
    mount({ dev: { thread_fence: false, note_lookup: true } })
    expect(checked(master())).toBe('true')
  })

  it('Developer mode on sends exactly the fence open, off exactly the fence back, and never note_lookup', async () => {
    const a = mount({ dev: { thread_fence: true, note_lookup: false } })
    await act(async () => userEvent.click(master()))
    expect(a.patch).toHaveBeenCalledTimes(1)
    expect(a.patch).toHaveBeenLastCalledWith({ dev: { thread_fence: false } })
    await waitFor(() => expect(checked(master())).toBe('true')) // the save has landed (WebCrypto signing, past act())
    expect(checked(rowSwitch('note_lookup'))).toBe('false')
    await act(async () => userEvent.click(master()))
    expect(a.patch).toHaveBeenCalledTimes(2)
    expect(a.patch).toHaveBeenLastCalledWith({ dev: { thread_fence: true } })
    await waitFor(() => expect(checked(master())).toBe('false'))
    expect(checked(rowSwitch('note_lookup'))).toBe('false')
  })

  it('Developer mode says what turning it off does, and when it takes effect', () => {
    mount()
    const help = document.getElementById(master().getAttribute('aria-describedby') ?? '')
    expect(help?.textContent).toContain('back to their defaults')
    expect(help?.textContent).toContain(`Takes effect ${DEV_ROWS[0]?.when}.`)
  })

  it('every switch is described by its own line', () => {
    mount()
    for (const sw of screen.getAllByRole('switch')) {
      const line = document.getElementById(sw.getAttribute('aria-describedby') ?? '')
      expect(line?.tagName).toBe('P')
      expect(line?.closest('[data-testid]')?.contains(sw)).toBe(true)
    }
  })

  it('the line under a row follows its value, and ends with when it takes effect', () => {
    const [fence] = DEV_ROWS
    mount({ dev: { thread_fence: true, note_lookup: true } })
    const row = screen.getByTestId('dev-row-thread_fence')
    expect(row.textContent).toContain(fence?.on)
    expect(row.textContent).toContain(`Takes effect ${fence?.when}.`)
    cleanup()
    mount({ dev: { thread_fence: false, note_lookup: true } })
    const off = screen.getByTestId('dev-row-thread_fence')
    expect(off.textContent).toContain(fence?.off)
    expect(off.textContent).not.toContain(fence?.on)
  })

  it('a second tap while a save runs sends no second patch, and the switch says it is busy', async () => {
    const { patch, release } = mount({ hold: true })
    const sw = rowSwitch('thread_fence')
    await act(async () => {
      await userEvent.click(sw)
    })
    expect(sw.getAttribute('aria-busy')).toBe('true')
    expect((sw as HTMLButtonElement).disabled).toBe(false)
    await act(async () => {
      await userEvent.click(sw)
    })
    expect(patch).toHaveBeenCalledTimes(1)
    await act(async () => release())
    await waitFor(() => expect(sw.getAttribute('aria-busy')).toBe('false'))
  })

  it('is greyed while the Mac is offline, and says so', () => {
    mount({ macOnline: false })
    for (const sw of screen.getAllByRole('switch')) expect((sw as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/has to be online to change this/)).toBeTruthy()
  })

  it('is greyed while this device reconnects, and leaves the line to the screen', () => {
    mount({ link: false })
    for (const sw of screen.getAllByRole('switch')) expect((sw as HTMLButtonElement).disabled).toBe(true)
    // SettingsScreen prints the not-connected line once for every synced section; this one must not print it again
    expect(screen.queryByText(/Settings can be changed once you/)).toBeNull()
  })

  it('a refused change leaves the switch where it was and shows the error', async () => {
    const { client } = mount()
    client.failNextPatchWith('config_conflict')
    await act(async () => userEvent.click(rowSwitch('thread_fence')))
    expect((await screen.findByRole('alert')).textContent).toMatch(/at the same time/)
    expect(checked(rowSwitch('thread_fence'))).toBe('true')
  })

  it('an older Mac that forbids the field gets the update line, and the switch stays put', async () => {
    const { client } = mount()
    client.failNextPatchWith('config_field_forbidden')
    await act(async () => userEvent.click(rowSwitch('thread_fence')))
    expect((await screen.findByRole('alert')).textContent).toBe('Update Talos on your Mac to change this.')
    expect(checked(rowSwitch('thread_fence'))).toBe('true')
  })
})
