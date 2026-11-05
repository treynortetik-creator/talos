// The start sequence behind the session gate, kept out of the component so it can be tested without a browser: read the
// device key, finish any wipe that was left owed, then start the socket client. `isGone` is asked after every await, so a
// run whose effect was already torn down never starts a client or reports a result for a screen that no longer exists.
import type { Storage } from '../../lib/storage.ts'
import { pendingWipe, retryPendingWipe } from './session.ts'

export type StartResult = 'started' | 'no-key' | 'storage' | 'wipe' | 'gone'

export interface StartableClient {
  deviceKey(): Promise<unknown>
  start(opts: { pinned: boolean }): Promise<unknown>
}

export async function startOwnerClient(args: {
  client: StartableClient
  storage: Storage
  pinned: boolean
  isGone: () => boolean
}): Promise<StartResult> {
  const { client, storage, pinned, isGone } = args
  let key: unknown
  try {
    key = await client.deviceKey()
  } catch {
    return isGone() ? 'gone' : 'storage'
  }
  if (isGone()) return 'gone'
  if (!key) return 'no-key'
  // A sign-out whose wipe did not finish is finished first: a queue the owner removed must never be loaded and sent.
  if (pendingWipe() && !(await retryPendingWipe(storage))) return isGone() ? 'gone' : 'wipe'
  if (isGone()) return 'gone'
  try {
    await client.start({ pinned })
  } catch {
    return isGone() ? 'gone' : 'storage'
  }
  return isGone() ? 'gone' : 'started'
}
