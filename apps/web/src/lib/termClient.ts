// The terminal view's calls to the Mac (piece 1: a read-only look at the agent's tmux pane). The answers are frames, read with
// `client.onFrame('term.opened' | 'term.key' | 'term.out' | 'term.closed', ...)`: they are an unsequenced stream of their own,
// never stored, never replayed after a reconnect (a closed socket ends the view; watching again is a new tap).
// There is no call here that sends a key: this tier has no typing path.

export interface TermClient {
  /**
   * Signs and sends `term.open` for a view this device chose to open (one tap, one view). Resolves once the Mac answered it
   * (`term.opened`, or `term.closed` when it cannot show that pane); rejects with `TalosClientError` when offline, not pinned,
   * refused (`mac_offline`, `rate_limited`, `sig_invalid`, `stale`) or after 20 s of silence. Never queued, never retried.
   */
  open(args: { termId: string; target: string; cols: number; rows: number }): Promise<void>
  /** Signs and sends `term.resume{from}`: the page draws again from byte offset `from` (after a lag). Fire and forget. */
  resume(termId: string, from: number): Promise<void>
  /** Signs and sends `term.close`. Fire and forget. */
  close(termId: string): Promise<void>
  /** The credit (`term.ack{upto}`): bytes up to `upto` are drawn. Unsigned, best effort, never throws. */
  ack(termId: string, upto: number): void
}
