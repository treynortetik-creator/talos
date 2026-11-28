// Where Thread files is offered: the sidebar, the phone menu, and each thread's settings sheet, which opens that thread's
// folder (/files?t=<id>). A Mac that does not list folders (no files/1) is offered none of them.
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { ThreadFilesScreen } from '../../src/features/files/ThreadFiles.tsx'
import { PhoneChrome } from '../../src/features/phone/PhoneChrome.tsx'
import { usePhonePanel } from '../../src/features/phone/phoneStore.ts'
import { ThreadEditor } from '../../src/features/threads/manage/ThreadEditor.tsx'
import { Sidebar } from '../../src/features/threads/Nav.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import type { FakeClient } from '../../src/lib/fakeClient.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

afterEach(() => {
  cleanup()
  usePhonePanel.setState({ open: null })
})

function Where() {
  const l = useLocation()
  return <p data-testid="where">{l.pathname + l.search}</p>
}

/** The fake Mac with files/1 taken out of its hello. */
function withoutFiles(c: FakeClient): FakeClient {
  const p = c.store.getState().presence
  if (!p) throw new Error('no presence')
  c.store.setState({ presence: { ...p, features: (p.features ?? []).filter((f) => f !== 'files/1') } })
  return c
}

function sheet(c: FakeClient) {
  const thread = c.store.getState().threads.find((t) => t.id === 'general')
  if (!thread) throw new Error('no general thread')
  return render(
    <ClientProvider client={c}>
      <MemoryRouter initialEntries={['/t/general']}>
        <ThreadEditor open onOpenChange={() => {}} thread={thread} />
        <Where />
      </MemoryRouter>
    </ClientProvider>,
  )
}

describe('Thread files entry points', () => {
  it("the thread settings sheet opens that thread's folder", async () => {
    const view = sheet(setup())
    await userEvent.click(await view.findByRole('button', { name: 'Thread files' }))
    expect(screen.getByTestId('where').textContent).toBe('/files?t=general')
  })

  it('the sidebar links to /files', async () => {
    renderWith(<Sidebar />, setup(), '/', '/')
    expect((await screen.findByRole('link', { name: 'Thread files' })).getAttribute('href')).toBe('/files')
  })

  it('the phone menu links to /files', async () => {
    const was = window.matchMedia
    window.matchMedia = ((q: string) => ({
      matches: q.includes('max-width: 767px'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia
    onTestFinished(() => {
      window.matchMedia = was
    })
    usePhonePanel.setState({ open: 'menu', path: '/', thread: null })
    renderWith(<PhoneChrome />, setup(), '/', '/')
    const menu = await screen.findByTestId('phone-menu')
    expect(within(menu).getByRole('link', { name: 'Thread files' }).getAttribute('href')).toBe('/files')
  })

  it('a Mac without thread folders is offered none of them', async () => {
    const view = sheet(withoutFiles(setup()))
    await view.findByRole('button', { name: 'Search this thread' })
    expect(view.queryByRole('button', { name: 'Thread files' })).toBeNull()
    cleanup()
    renderWith(<Sidebar />, withoutFiles(setup()), '/', '/')
    await screen.findByRole('link', { name: 'Nyx' })
    expect(screen.queryByRole('link', { name: 'Thread files' })).toBeNull()
  })

  it('after a reload, before the Mac has said what it can do, the screen waits instead of saying it does not share folders', async () => {
    const c = setup()
    c.store.setState({ presence: { bridge_online: false }, readySeq: 0 } as never)
    renderWith(<ThreadFilesScreen />, c, '/files', '/files')
    expect((await screen.findByTestId('thread-files-loading')).textContent).toBe('Loading…')
    expect(screen.queryByTestId('thread-files-off')).toBeNull()
  })

  it("an opened folder's name is its heading, and it takes focus", async () => {
    renderWith(<ThreadFilesScreen />, setup(), '/files?t=general', '/files')
    const h = await screen.findByRole('heading', { name: 'General folder', level: 2 })
    expect(document.activeElement).toBe(h)
  })

  it("an archived thread's settings sheet offers no Thread files", async () => {
    const c = setup()
    const t = c.store.getState().threads.find((x) => x.id === 'general')
    if (!t) throw new Error('no general thread')
    c.store.setState({
      threads: c.store.getState().threads.map((x) => (x.id === 'general' ? { ...x, archived: true } : x)),
    })
    const view = render(
      <ClientProvider client={c}>
        <MemoryRouter initialEntries={['/t/general']}>
          <ThreadEditor open onOpenChange={() => {}} thread={{ ...t, archived: true }} />
        </MemoryRouter>
      </ClientProvider>,
    )
    await view.findByRole('button', { name: 'Search this thread' })
    expect(view.queryByRole('button', { name: 'Thread files' })).toBeNull()
  })
})
