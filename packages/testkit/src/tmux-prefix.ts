/**
 * The start of the name of every tmux socket (`-L`) a test makes: TALOS_TEST_TMUX_PREFIX, which scripts/heavy-lock.sh sets per heavy
 * slot (talos-test-s<slot>), so the servers of two gates side by side never share a name or a pattern; `talos-test` otherwise.
 * Never `talos`: that is the owner's own server.
 */
export const tmuxTestPrefix = (): string => {
  const p = process.env.TALOS_TEST_TMUX_PREFIX
  return p && /^[A-Za-z0-9_-]{1,40}$/.test(p) && p !== 'talos' && p !== 'default' ? p : 'talos-test'
}
