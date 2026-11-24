import { createServer } from 'node:net'

/**
 * A loopback port held open until `release()`. While the probe socket listens, the kernel gives that port to no other bind on
 * the machine (another test worker's port 0, an outgoing connection's local port), so whoever reserves it can spend a second
 * on setup and still find it free. `freePort()` closes its probe at once, and the port could be handed to anyone in between:
 * on a loaded machine that was `listen EADDRINUSE` in the relay's own start (12c, fb7426b). Release it right before the
 * in-process listen that takes it over; a child process can't take over a port its parent still holds.
 */
export async function reservePort(): Promise<{ port: number; release: () => Promise<void> }> {
  const s = createServer((c) => c.destroy()) // a stray connection must not keep close() waiting
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (s.address() as { port: number }).port
  let held = true
  const release = () =>
    new Promise<void>((resolve) => {
      if (!held) return resolve()
      held = false
      s.close(() => resolve())
    })
  return { port, release }
}
