// The terminal view in fake mode (VITE_FAKE=1): a made-up tmux pane that plays what the Mac's bridge would send, so the screen and its
// browser tests run with no relay. The offsets start well above zero, as they do on a Mac that has been running a while; the pane
// keeps everything it printed, so a resume from any offset it has is answered with the bytes, and one from beyond it with a picture.
// A test drives it through `client.fakeTerm`: `say` prints, `lag` is the relay dropping output, `end` closes the view.
import { b64urlEncode } from '@talos-app/protocol'
import { TalosClientError } from './client.ts'
import type { TermClient } from './termClient.ts'

const enc = new TextEncoder()
const START_AT = 5_000

/** What the demo pane shows when a view opens: a Claude Code session's last screen, colours and all. */
export const DEMO_SCREEN = [
  '\x1b[1;32m⏺\x1b[0m Reading apps/web/src/lib/socket-connection.ts',
  '  \x1b[2m⎿  Read 339 lines\x1b[0m',
  '',
  '\x1b[1;32m⏺\x1b[0m The handshake timer clears on ready. Running the socket tests.',
  '',
  '\x1b[1;32m⏺\x1b[0m Bash(pnpm exec vitest run --project web test/socket-*)',
  '  \x1b[2m⎿\x1b[0m  \x1b[32m✓\x1b[0m test/socket-handshake-timeout.test.ts (27)',
  '     \x1b[32m✓\x1b[0m test/socket-probe.test.ts (56)',
  '     Test Files  \x1b[1m2 passed\x1b[0m (2)',
  '',
  '\x1b[1;32m⏺\x1b[0m Both green. Committing on the branch.',
  '',
  '\x1b[33m✻ Thinking…\x1b[0m (14s · esc to interrupt)',
]

export type FakeTerm = TermClient & {
  /** Every frame this page sent about the view, in order (`term.open`, `term.resume`, `term.close`, `term.ack`). */
  readonly sent: Array<Record<string, unknown>>
  /** The pane prints `text`. With `dropped`, the relay dropped it on the way: the page will only get it by resuming. */
  say(text: string, dropped?: boolean): void
  /** The relay drops output for this page: it is told `term.closed{lag}`, and nothing more comes until it resumes. */
  lag(): void
  /** The view ends. */
  end(why: string): void
  /** The pane's size changes under the view (the Mac's own window): the page is told, then sent a new picture. */
  resizePane(cols: number, rows: number): void
  /** The offset the pane has reached. */
  readonly total: number
  /** Makes the next open answer with `term.closed{why}` instead of showing the pane. */
  refuseNext(why: string): void
}

export function createFakeTerm(d: {
  emit(type: string, fields: Record<string, unknown>): void
  macOnline(): boolean
}): FakeTerm {
  const sent: Array<Record<string, unknown>> = []
  let log = new Uint8Array(0)
  const base = START_AT // the offset of log[0]
  let open: string | null = null
  let lagging = false
  let size = { cols: 100, rows: 28 }
  let refuse: string | null = null

  const total = () => base + log.length
  const screen = () =>
    enc.encode(`\x1b[0m\x1b[H\x1b[2J\x1b[3J${DEMO_SCREEN.join('\r\n')}\x1b[0m\x1b[${DEMO_SCREEN.length};1H`)
  const key = () => d.emit('term.key', { term_id: open, at: total(), bytes_b64: b64urlEncode(screen()) })
  const opened = () =>
    d.emit('term.opened', { term_id: open, tier: 'view', cols: size.cols, rows: size.rows, idle_s: 600, max_s: 3600 })
  const out = (from: number) => {
    const bytes = log.subarray(from - base)
    for (let i = 0; i < bytes.length; i += 16 * 1024)
      d.emit('term.out', { term_id: open, at: from + i, bytes_b64: b64urlEncode(bytes.subarray(i, i + 16 * 1024)) })
  }

  return {
    sent,
    get total() {
      return total()
    },
    async open({ termId, target, cols, rows }) {
      if (!d.macOnline()) throw new TalosClientError('mac_offline', 'your Mac is offline')
      sent.push({ type: 'term.open', term_id: termId, tier: 'view', target, cols, rows })
      if (refuse) {
        const why = refuse
        refuse = null
        d.emit('term.closed', { term_id: termId, why })
        return
      }
      open = termId
      lagging = false
      await Promise.resolve()
      opened()
      key()
    },
    async resume(termId, from) {
      sent.push({ type: 'term.resume', term_id: termId, from })
      if (termId !== open) return
      lagging = false
      if (from >= base && from <= total()) out(from)
      else key()
    },
    async close(termId) {
      sent.push({ type: 'term.close', term_id: termId })
      if (termId === open) open = null
    },
    ack(termId, upto) {
      sent.push({ type: 'term.ack', term_id: termId, upto })
    },
    say(text, dropped = false) {
      const b = enc.encode(text)
      const at = total()
      const next = new Uint8Array(log.length + b.length)
      next.set(log)
      next.set(b, log.length)
      log = next
      if (open && !lagging && !dropped) out(at)
    },
    lag() {
      if (!open) return
      lagging = true
      d.emit('term.closed', { term_id: open, why: 'lag' })
    },
    end(why) {
      if (!open) return
      const id = open
      open = null
      d.emit('term.closed', { term_id: id, why })
    },
    resizePane(cols, rows) {
      size = { cols, rows }
      if (!open) return
      opened()
      key()
    },
    refuseNext(why) {
      refuse = why
    },
  }
}
