// A connected socket client against FakeRelay, for the tests of the frame handlers (src/lib/socket-frames-*.ts).
import { FakeRelay, waitFor } from '@talos-app/testkit'
import { createSocketClient, type SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

export type Rig = { relay: FakeRelay; client: SocketClient; stop: () => Promise<void> }

export async function connectedRig(): Promise<Rig> {
  const relay = await new FakeRelay().start()
  const client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  return {
    relay,
    client,
    stop: async () => {
      client.close()
      await relay.stop()
    },
  }
}

export const STAMP = (seq: number) => ({
  relay: { seq, received_at: new Date(Date.UTC(2026, 9, 31, 12, 0)).toISOString() },
})
export const AT = new Date(Date.UTC(2026, 9, 31, 12, 0)).toISOString()
