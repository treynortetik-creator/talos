// Settings > Storage (bug hunt core #19): keep forever is the default; a shorter time asks first, with what it would remove
// as the Mac counted it, and a longer one does not.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaRetentionSection, removalWarning } from '../../src/features/settings/MediaRetentionSection.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

beforeEach(() => {
  // /api/status: the Mac's own count of what each choice would remove
  vi.stubGlobal('fetch', async () =>
    Response.json({
      at: new Date().toISOString(),
      beat: { media_by_age: [{ days: 30, files: 12, bytes: 2_400_000_000 }] },
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('removalWarning', () => {
  it("names the Mac's count, that it cannot be undone, and the hour", () => {
    const w = removalWarning(30, [{ days: 30, files: 12, bytes: 2_400_000_000 }])
    expect(w).toContain('about 12 files (2.4 GB) older than 30 days')
    expect(w).toContain("They can't be downloaded again")
    expect(w).toContain('nothing is removed for an hour')
  })
  it('without a count from the Mac it still says what and that it is final', () => {
    expect(removalWarning(90, undefined)).toContain('attachments older than 90 days')
  })
})

describe('the Storage section', () => {
  it('shows keep forever by default, and asks before a shorter time is applied', async () => {
    const client = createFakeClient()
    const patch = vi.spyOn(client, 'patchConfig')
    render(
      <ClientProvider client={client}>
        <MediaRetentionSection readOnly={false} />
      </ClientProvider>,
    )
    const select = (await screen.findByLabelText('Keep message attachments on this Mac')) as HTMLSelectElement
    await waitFor(() => expect(select.disabled).toBe(false))
    expect(select.value).toBe('forever')
    await userEvent.selectOptions(select, '30')
    expect(await screen.findByText(/Keep attachments for 30 days\?/)).toBeTruthy()
    expect(patch).not.toHaveBeenCalled() // nothing applied until the owner says so
    await userEvent.click(screen.getByRole('button', { name: 'Remove older files' }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ media_keep_days: 30 }))
  })
})
