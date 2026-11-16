import { type FSWatcher, watch } from 'node:fs'

/**
 * A non-persistent `fs.watch` whose 'error' events are swallowed. An FSWatcher error with no listener is thrown as an
 * uncaught exception and stops the bridge; on Linux, Bun emits one when a unix socket appears in a watched
 * folder. Every caller has a poll behind its watch, so a watcher that errors costs latency, never correctness.
 */
export function quietWatch(path: string, onChange: () => void): FSWatcher {
  const w = watch(path, { persistent: false }, onChange)
  w.on('error', () => {})
  return w
}
