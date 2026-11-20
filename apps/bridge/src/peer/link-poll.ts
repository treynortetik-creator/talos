// The bridge's peer poll: pick up a finished one-paste link first, then tell the owner what changed (peer/changes.ts).
import type { BridgeContext } from '../context.ts'
import { notePeerChanges } from './changes.ts'
import { collectPeerLinks } from './link-collect.ts'

export async function notePeers(ctx: BridgeContext): Promise<number> {
  await collectPeerLinks(ctx)
  return notePeerChanges(ctx)
}
