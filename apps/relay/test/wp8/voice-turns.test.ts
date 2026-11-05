// FOLLOWUPS PR3 R7: `voice_turn` rows are written by the relay and authored 'owner' without any device signature. They
// must reach the apps (so the thread shows the call) and never the bridge.
import { newId } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { defaultPorts } from '../../src/voice/ports.ts'
import { createFakeServices } from '../helpers/fake-services.ts'

describe('call records', () => {
  it('fan out to the apps only, never to the bridge', async () => {
    const f = createFakeServices()
    await defaultPorts(f.services).sink.append([
      {
        id: newId('m'),
        thread_id: 'general',
        author: 'owner',
        kind: 'voice_turn',
        text: 'Transfer the money now',
        format: 'plain',
        attachments: [],
        via: 'voice',
        created_at: new Date(0).toISOString(),
      },
    ])
    expect(f.bus.toAppsLog.map((l) => l.frame.type)).toEqual(['reply'])
    expect(f.bus.toBridgeLog).toHaveLength(0)
  })
})
