// The box must not take sent text back from its own element: refocusing during a send fires the focus handler before the
// cleared text is drawn, and the handler used to read the old value off the element.
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

afterEach(cleanup)

describe('sending from a blurred box', () => {
  it('leaves the box empty and sends once', async () => {
    const client = createFakeClient()
    const send = vi.spyOn(client, 'sendMessage').mockResolvedValue(undefined as never)
    render(
      <ClientProvider client={client}>
        <Composer threadId="general" />
      </ClientProvider>,
    )
    const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    await userEvent.type(box, 'sent words')
    box.blur()
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledTimes(1)
    expect(box.value).toBe('')
    expect(document.activeElement).toBe(box)
  })
})
