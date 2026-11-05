import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { ThreadList } from '../../src/features/threads/ThreadList.tsx'
import { ThreadScreen } from '../../src/features/threads/ThreadScreen.tsx'
import { renderWith, setup } from '../cards/helpers.tsx'

beforeEach(() => localStorage.clear())

describe('threads list', () => {
  it('explains threads in one dismissible line', async () => {
    renderWith(<ThreadList />, setup(), '/threads')
    expect(screen.getByTestId('threads-explainer').textContent).toMatch(/Threads keep topics apart/)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss explanation' }))
    expect(screen.queryByTestId('threads-explainer')).toBeNull()
  })

  it('shows the notify level on every row', () => {
    renderWith(<ThreadList />, setup(), '/threads')
    expect(screen.getByTestId('notify-general').textContent).toMatch(/All|Needs you|Off/)
  })

  it('a thread named Constructor from the list gets constructor_thread and the list renders', async () => {
    const client = setup()
    renderWith(<ThreadList />, client, '/threads')
    await userEvent.click(screen.getByTestId('new-thread'))
    await userEvent.type(await screen.findByLabelText('Name'), 'Constructor')
    await userEvent.click(screen.getByRole('button', { name: 'Create thread' }))
    await waitFor(() => expect(client.store.getState().threads.some((t) => t.id === 'constructor_thread')).toBe(true))
    expect(await screen.findByTestId('thread-row-constructor_thread')).toBeTruthy()
  })

  it('creates a thread from the list', async () => {
    const client = setup()
    renderWith(<ThreadList />, client, '/threads')
    await userEvent.click(screen.getByTestId('new-thread'))
    await userEvent.type(await screen.findByLabelText('Name'), 'Trip planning')
    await userEvent.click(screen.getByRole('button', { name: 'Orange color' }))
    await userEvent.click(screen.getByRole('button', { name: 'Plane icon' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create thread' }))
    await waitFor(() => expect(client.store.getState().threads.some((t) => t.name === 'Trip planning')).toBe(true))
    const t = client.store.getState().threads.find((x) => x.name === 'Trip planning')
    expect(t).toMatchObject({ id: 'trip_planning', color: 'orange', icon: 'plane' })
  })
})

describe('thread screen', () => {
  const open = () => {
    const client = setup()
    renderWith(<ThreadScreen />, client, '/t/general', '/t/:thread')
    return client
  }

  it('explains an empty thread', async () => {
    const client = setup()
    client.store.setState((s) => ({ ...s, messages: { ...s.messages, general: [] } }))
    renderWith(<ThreadScreen />, client, '/t/general', '/t/:thread')
    expect((await screen.findByTestId('thread-empty-explainer')).textContent).toMatch(/A thread is one topic/)
  })

  it('the empty Inbox asks about the inbox instead of explaining how to rename a thread', async () => {
    renderWith(<ThreadScreen />, setup(), '/t/inbox', '/t/:thread')
    const text = (await screen.findByTestId('thread-empty-explainer')).textContent
    expect(text).toMatch(/Ask Talos/)
    expect(text).not.toMatch(/rename/)
  })

  it('sets the notify level from the settings', async () => {
    const client = open()
    await userEvent.click(await screen.findByTestId('thread-settings-trigger'))
    await userEvent.click(await screen.findByRole('button', { name: 'Off' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(client.store.getState().threads.find((t) => t.id === 'general')?.notify).toBe('off'))
  })

  it('renames and archives', async () => {
    const client = open()
    await userEvent.click(await screen.findByTestId('thread-settings-trigger'))
    const input = await screen.findByLabelText('Name')
    fireEvent.change(input, { target: { value: 'Main' } })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(client.store.getState().threads.find((t) => t.id === 'general')?.name).toBe('Main'))
  })

  it('saves "what goes here" as the thread topic (the agent reads it) and shows it under the header', async () => {
    const client = open()
    await userEvent.click(await screen.findByTestId('thread-settings-trigger'))
    const box = await screen.findByLabelText('What goes here')
    await userEvent.type(box, 'Weekly planning')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByTestId('thread-purpose')).textContent).toBe('Weekly planning')
    expect(client.store.getState().threads.find((t) => t.id === 'general')?.topic).toBe('Weekly planning')
  })

  it('a device-only note from before topics is offered as the topic and moved into config on save', async () => {
    localStorage.setItem('talos.thread-descriptions', JSON.stringify({ general: 'Old note' }))
    const client = open()
    expect((await screen.findByTestId('thread-purpose')).textContent).toBe('Old note')
    await userEvent.click(await screen.findByTestId('thread-settings-trigger'))
    expect((await screen.findByLabelText('What goes here')).textContent).toBe('Old note')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(client.store.getState().threads.find((t) => t.id === 'general')?.topic).toBe('Old note'))
    expect(localStorage.getItem('talos.thread-descriptions')).toBe('{}')
  })

  it('with a Mac that predates threads/2, hides icon, color and topic and says why', async () => {
    const client = setup()
    client.store.setState((s) => ({ ...s, presence: { ...s.presence, features: ['schedules/1'] } }))
    renderWith(<ThreadScreen />, client, '/t/general', '/t/:thread')
    await userEvent.click(await screen.findByTestId('thread-settings-trigger'))
    expect(await screen.findByTestId('threads-update-mac')).toBeTruthy()
    expect(screen.queryByTestId('icon-grid')).toBeNull()
    expect(screen.queryByTestId('color-swatches')).toBeNull()
  })

  it('the default thread cannot be archived until another is the default', async () => {
    open()
    await userEvent.click(await screen.findByTestId('thread-settings-trigger'))
    expect((await screen.findByRole('button', { name: 'Archive thread' })).hasAttribute('disabled')).toBe(true)
  })
})

describe('an empty thread tells a phone owner where thread settings are', () => {
  it('names both the ⋯ button on a computer and Open menu then the pencil on a phone', async () => {
    const client = setup()
    client.store.setState((s) => ({ ...s, messages: { ...s.messages, general: [] } }))
    renderWith(<ThreadScreen />, client, '/t/general', '/t/:thread')
    const text = (await screen.findByTestId('thread-empty-explainer')).textContent ?? ''
    expect(text).toMatch(/⋯ button at the top on a computer/)
    expect(text).toMatch(/Open menu and then the pencil beside its name on a phone/)
    expect(text).not.toMatch(/Use the ⋯ menu above/)
  })
})
