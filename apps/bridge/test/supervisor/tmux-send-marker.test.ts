// A send through sendUnlessInMode counts only when its own marker comes back (the Mac's finding, d264283a): the in-mode marker
// is nothing sent, and any other answer is "may have landed", never "sent".
import { describe, expect, it } from 'bun:test'
import { IN_MODE_MARKER, SENT_MARKER, TmuxCommands } from '../../src/supervisor/tmux-commands.ts'
import { markedSend } from '../../src/supervisor/tmux-host.ts'

describe('a send that says so', () => {
  const r = (ok: boolean, out: string, timedOut = false) => ({ ok, out, timedOut })
  it('sent only on its own marker; the in-mode marker is nothing sent; anything else may have landed', () => {
    expect(markedSend(r(true, `${SENT_MARKER}\n`))).toBe('sent')
    expect(markedSend(r(true, `${IN_MODE_MARKER}\n`))).toBe('failed')
    expect(markedSend(r(true, ''))).toBe('unknown')
    expect(markedSend(r(true, 'some other output'))).toBe('unknown')
    expect(markedSend(r(false, '', true))).toBe('unknown')
    expect(markedSend(r(false, 'no such pane'))).toBe('failed')
  })
  it('the marker is printed by tmux right after the keys, in the same if-shell branch', () => {
    const argv = new TmuxCommands('tmux', '/dev/null', 't-trip', 'x').sendUnlessInMode('Enter')
    const branch = argv.at(-1) as string
    expect(branch).toContain('send-keys')
    expect(branch.endsWith(`; display-message -p ${SENT_MARKER}`)).toBe(true)
  })
})
