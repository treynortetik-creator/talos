// @vitest-environment jsdom
import type { ProblemT } from '@talos-app/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { installProblems, uninstallProblems } from '../../src/features/problems/controller.ts'
import type { PostResult } from '../../src/features/problems/queue.ts'
import { previewLines, ReportProblem } from '../../src/features/problems/ReportProblem.tsx'
import { ClientProvider, type TalosClient } from '../../src/lib/client.ts'
import { HttpError } from '../../src/lib/http.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { AppErrorBoundary } from '../../src/ui/ErrorBoundary.tsx'

function Boom(): never {
  throw new Error('render failed')
}

function Stale(): never {
  throw new Error('Failed to fetch dynamically imported module: /assets/x.js')
}

afterEach(() => {
  cleanup()
  uninstallProblems()
})

function world(post: (p: ProblemT) => Promise<PostResult>, now?: () => number) {
  const storage = createMemoryStorage()
  const client = {
    store: createStore(() => ({ connection: 'offline' })),
    uploadMedia: async () => ({
      media_id: `md_${'0'.repeat(26)}`,
      kind: 'image',
      role: 'attachment',
      mime: 'image/png',
      name: 's.png',
      size: 3,
      sha256: 'a'.repeat(64),
    }),
  } as unknown as TalosClient
  const ctl = installProblems({ storage, client, post, target: new EventTarget() as never, ...(now ? { now } : {}) })
  const ui = (node: React.ReactNode) => (
    <StorageProvider storage={storage}>
      <ClientProvider client={client}>{node}</ClientProvider>
    </StorageProvider>
  )
  return { storage, client, ctl, ui }
}

const lines = () => Array.from(screen.getByTestId('report-preview').querySelectorAll('li')).map((l) => l.textContent)

describe('Report a problem', () => {
  it('opens with the cursor in the note, and the preview lists versions, device, screens and the note', async () => {
    const { ui } = world(async () => ({ ok: true }))
    render(ui(<ReportProblem />))
    await userEvent.click(screen.getByTestId('report-problem-open'))
    const note = screen.getByLabelText(/What were you doing/)
    expect(document.activeElement).toBe(note)
    await userEvent.type(note, 'tapped Send')
    expect(lines().join('\n')).toMatch(/App version: /)
    expect(lines().join('\n')).toMatch(/Device: browser/)
    expect(lines().join('\n')).toMatch(/Your note: tapped Send/)
    expect(lines().join('\n')).toMatch(/Screenshot: none/)
    expect(screen.getByText(/Your messages and cards are never included/)).toBeTruthy()
  })

  it('what is previewed is exactly what is posted', async () => {
    const posted: ProblemT[] = []
    const { ui } = world(async (p) => {
      posted.push(p)
      return { ok: true }
    })
    render(ui(<ReportProblem startOpen />))
    await userEvent.type(screen.getByLabelText(/What were you doing/), 'it froze')
    const shown = lines()
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(previewLines(posted[0] as ProblemT, null)).toEqual(shown)
    expect(posted[0]).toMatchObject({ kind: 'owner', source: 'web', steps: 'it froze' })
    await waitFor(() => expect(screen.getByTestId('report-sent')).toBeTruthy())
    expect(document.activeElement).toBe(screen.getByTestId('report-sent')) // focus lands on the result
  })

  it('offline: saved on the device, says so, and sends by itself later', async () => {
    let up = false
    const posted: ProblemT[] = []
    const { ui, ctl } = world(async (p) => {
      if (!up) return { ok: false, network: true }
      posted.push(p)
      return { ok: true }
    })
    render(ui(<ReportProblem startOpen />))
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() =>
      expect(screen.getByTestId('report-saved').textContent).toMatch(/Saved on this device.*back online/),
    )
    expect(await ctl.queue.size()).toBe(1)
    up = true
    await ctl.flush()
    expect(posted).toHaveLength(1)
    expect(await ctl.queue.size()).toBe(0)
  })

  it('a 429 says the report is saved and goes out when Talos next connects, and names no period', async () => {
    const { ui } = world(async () => ({ ok: false, status: 429 }))
    render(ui(<ReportProblem startOpen />))
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(screen.getByTestId('report-saved').textContent).toMatch(/next connects/))
    expect(screen.getByTestId('report-saved').textContent).not.toMatch(/\d|hour|minute/)
  })

  it.each([
    [new HttpError(401), /Sign in again/],
    [new HttpError(503), /couldn't take it/],
    [new TypeError('Failed to fetch'), /back online/],
  ])('a screenshot that cannot be uploaded (%s) says why the report is waiting', async (error, line) => {
    const { ui, client } = world(async () => ({ ok: true }))
    client.uploadMedia = async () => {
      throw error
    }
    render(ui(<ReportProblem startOpen />))
    fireEvent.change(screen.getByLabelText(/Screenshot/), {
      target: { files: [new File([new Uint8Array(2048)], 'shot.png', { type: 'image/png' })] },
    })
    await waitFor(() => expect(lines().join('\n')).toMatch(/Screenshot: shot\.png/))
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(screen.getByTestId('report-saved').textContent).toMatch(line))
  })

  it('a screenshot the server will never take is dropped: the report still goes, without it', async () => {
    const posted: ProblemT[] = []
    const { ui, client } = world(async (p) => {
      posted.push(p)
      return { ok: true }
    })
    client.uploadMedia = async () => {
      throw new HttpError(413)
    }
    render(ui(<ReportProblem startOpen />))
    await userEvent.type(screen.getByLabelText(/What were you doing/), 'the words')
    fireEvent.change(screen.getByLabelText(/Screenshot/), {
      target: { files: [new File([new Uint8Array(2048)], 'shot.png', { type: 'image/png' })] },
    })
    await waitFor(() => expect(lines().join('\n')).toMatch(/Screenshot: shot\.png/))
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(screen.getByTestId('report-sent')).toBeTruthy())
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ steps: 'the words', truncated: true })
    expect(posted[0]?.screenshot).toBeUndefined()
  })

  it('an older report that was refused does not make this one, which went, read as refused', async () => {
    const { ui, ctl } = world(async () => ({ ok: true }))
    vi.spyOn(ctl, 'submit').mockResolvedValue({ sent: 1, kept: 0, rejected: 1, rejectedIds: ['an-older-report'] })
    render(ui(<ReportProblem startOpen />))
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(screen.getByTestId('report-sent')).toBeTruthy())
    expect(screen.queryByTestId('report-failed')).toBeNull()
  })

  it('this report refused reads as refused, even when an older one went in the same run', async () => {
    const { ui, ctl } = world(async () => ({ ok: true }))
    vi.spyOn(ctl, 'submit').mockImplementation(async (p) => ({ sent: 1, kept: 0, rejected: 1, rejectedIds: [p.id] }))
    render(ui(<ReportProblem startOpen />))
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(screen.getByTestId('report-failed').textContent).toMatch(/refused/))
    expect(screen.queryByTestId('report-sent')).toBeNull()
  })

  it('refuses a screenshot that is not a picture or is over 5 MB, and the send button waits', async () => {
    const { ui } = world(async () => ({ ok: true }))
    render(ui(<ReportProblem startOpen />))
    const input = screen.getByLabelText(/Screenshot/) as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByTestId('report-shot-error').textContent).toMatch(/not a picture/))
    expect((screen.getByRole('button', { name: 'Send report' }) as HTMLButtonElement).disabled).toBe(true)
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [big] } })
    await waitFor(() => expect(screen.getByTestId('report-shot-error').textContent).toMatch(/over 5 MB/))
  })

  it('a screenshot is previewed by name and size, with a reminder that it can show messages, and is sent', async () => {
    const posted: ProblemT[] = []
    const { ui } = world(async (p) => {
      posted.push(p)
      return { ok: true }
    })
    render(ui(<ReportProblem startOpen />))
    const input = screen.getByLabelText(/Screenshot/) as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array(2048)], 'shot.png', { type: 'image/png' })] },
    })
    await waitFor(() => expect(lines().join('\n')).toMatch(/Screenshot: shot\.png \(2 KB\)/))
    expect(screen.getByText(/can show your messages/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]?.screenshot?.kind).toBe('image')
  })

  it('shows how many reports wait and how many repeats were held back', async () => {
    const { ui, ctl } = world(async () => ({ ok: false, network: true }))
    render(ui(<ReportProblem />))
    const err = new Error('boom')
    err.stack = `Error: boom\n    at x (${location.origin}/assets/a.js:1:1)`
    for (let i = 0; i < 3; i++) ctl.report(err)
    await waitFor(() => expect(screen.getByTestId('problem-status').textContent).toMatch(/1 report is waiting/))
    expect(screen.getByTestId('problem-status').textContent).toMatch(/2 repeat reports were held back/)
  })
})

describe('Report a problem: ids and dropped reports', () => {
  it('a second blank report is a new report, not the first one again', async () => {
    const posted: ProblemT[] = []
    const { ui } = world(async (p) => {
      posted.push(p)
      return { ok: true }
    })
    render(ui(<ReportProblem startOpen />))
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(posted).toHaveLength(1))
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(posted).toHaveLength(2))
    expect(posted[1]?.id).not.toBe(posted[0]?.id)
  })

  it('says how many reports were dropped to keep the waiting list short', async () => {
    const { ui, ctl } = world(async () => ({ ok: false, network: true }))
    render(ui(<ReportProblem startOpen />))
    ctl.queue.dropped = 2
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() =>
      expect(screen.getByTestId('problem-status').textContent).toMatch(/2 older reports were dropped/),
    )
  })
})

/** A relay stand-in that keeps the replay rule of apps/relay/src/core/problems.ts: an id already held is answered 202 and the new body is thrown away. */
function replayingRelay() {
  const held = new Map<string, ProblemT>()
  const state = { up: false, drops: 0 }
  const post = async (p: ProblemT): Promise<PostResult> => {
    if (!state.up) return { ok: false, network: true }
    if (held.has(p.id)) state.drops++
    else held.set(p.id, p)
    return { ok: true }
  }
  return { held, state, post }
}

describe("Report a problem: a saved report is the queue's, not the form's", () => {
  it('after "saved" the form is empty and the next report is a new one: both arrive, none dropped as a replay', async () => {
    const relay = replayingRelay()
    const { ui, ctl } = world(relay.post)
    render(ui(<ReportProblem startOpen />))
    const note = screen.getByLabelText(/What were you doing/) as HTMLTextAreaElement
    await userEvent.type(note, 'first')
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(screen.getByTestId('report-saved')).toBeTruthy())
    expect(note.value).toBe('')
    await userEvent.type(note, 'second')
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(screen.getByTestId('report-saved')).toBeTruthy())
    expect(await ctl.queue.size()).toBe(2) // the second did not overwrite the first
    relay.state.up = true
    await ctl.flush()
    expect(relay.state.drops).toBe(0)
    expect([...relay.held.values()].map((p) => p.steps).sort()).toEqual(['first', 'second'])
  })

  it('a send that failed and was NOT saved keeps its id, note and time, so the retry cannot file twice', async () => {
    const relay = replayingRelay()
    relay.state.up = true
    let t = Date.parse('2026-11-02T09:00:00Z')
    const { ui, ctl } = world(relay.post, () => t)
    render(ui(<ReportProblem startOpen />))
    const note = screen.getByLabelText(/What were you doing/) as HTMLTextAreaElement
    await userEvent.type(note, 'kept')
    const real = ctl.submit.bind(ctl)
    const sent: ProblemT[] = []
    vi.spyOn(ctl, 'submit').mockImplementationOnce(async (p) => {
      sent.push(p)
      return null // the queue write failed: nothing was saved
    })
    vi.spyOn(ctl, 'submit').mockImplementationOnce(async (p, s) => {
      sent.push(p)
      return real(p, s)
    })
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(screen.getByTestId('report-failed')).toBeTruthy())
    expect(note.value).toBe('kept')
    t = Date.parse('2026-11-02T17:00:00Z')
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]?.id).toBe(sent[0]?.id)
    expect(sent[1]?.at).toBe(sent[0]?.at)
  })

  it('the report is stamped when it is sent, not when the form was opened', async () => {
    const relay = replayingRelay()
    relay.state.up = true
    let t = Date.parse('2026-11-02T09:00:00Z')
    const { ui } = world(relay.post, () => t)
    render(ui(<ReportProblem startOpen />))
    await userEvent.type(screen.getByLabelText(/What were you doing/), 'late')
    t = Date.parse('2026-11-02T17:00:00Z')
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(relay.held.size).toBe(1))
    expect([...relay.held.values()][0]?.at).toBe('2026-11-02T17:00:00.000Z')
  })
})

describe('the crash screen', () => {
  it('offers Reload and Report a problem; the crash is attached (its type shows in the preview), not a message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ui } = world(async () => ({ ok: true }))
    render(
      ui(
        <AppErrorBoundary>
          <Boom />
        </AppErrorBoundary>,
      ),
    )
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
    await userEvent.click(screen.getByTestId('report-problem-open'))
    expect(lines().join('\n')).toMatch(/Error: Error: render failed/)
  })

  it('without the app providers the crash screen still shows Reload (the report block fails alone)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    )
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })

  it('a stale-chunk screen offers no report button (Reload is the fix)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ui } = world(async () => ({ ok: true }))
    render(
      ui(
        <AppErrorBoundary>
          <Stale />
        </AppErrorBoundary>,
      ),
    )
    expect(screen.queryByTestId('report-problem-open')).toBeNull()
  })
})
