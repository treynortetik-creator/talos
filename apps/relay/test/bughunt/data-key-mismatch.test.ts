// BUGHUNT (packaging / env at boot): a redeploy with a DIFFERENT but well-formed DATA_KEY (a typo, a regenerated key,
// the wrong password-manager entry) is not detected at boot. .env.example and docs/SETUP.md promise "the relay refuses to
// start if a required value is missing or malformed and says which one" / "It names the variable".
// Observed: with a stored config the relay crash-loops on an opaque "Unsupported state or unable to authenticate data"
// (no variable named); with only events stored it boots, /healthz says ok (so the deploy goes green), and every read of
// stored data throws later. Suggested fix: store an encrypted canary in core_state at first boot and check it in
// createRelayServices, throwing "DATA_KEY does not match the key this volume was created with".
import { randomBytes } from 'node:crypto'
import { newUlid } from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { startTestRelay, type TestRelay } from '../core/harness.ts'

const otherKey = () => randomBytes(32).toString('base64')
let open: TestRelay | null = null
afterEach(async () => {
  await open?.stop()
  open = null
})

async function bootError(dir: string): Promise<string | null> {
  try {
    open = await startTestRelay({ dir, env: { DATA_KEY: otherKey() } })
    return null
  } catch (e) {
    return (e as Error).message
  }
}

describe('restart with a different DATA_KEY', () => {
  it('refuses to boot and names DATA_KEY when a config is stored', async () => {
    const a = await startTestRelay()
    a.runtime.store.setConfig({ ...DEFAULT_AGENT_CONFIG, rev: 3 })
    await a.stopKeepData()
    const err = await bootError(a.dir)
    expect(err).not.toBeNull()
    expect(err).toMatch(/DATA_KEY/) // today: "Unsupported state or unable to authenticate data"
  })

  it('refuses to boot when only buffered events are stored (today it boots and /healthz says ok)', async () => {
    const a = await startTestRelay()
    a.runtime.store.appendEvent({
      frame: { v: 1, type: 'presence', id: newUlid(), ts: new Date().toISOString() },
      audience: 'app',
      threadId: 'general',
    })
    await a.stopKeepData()
    const err = await bootError(a.dir)
    expect(err, 'relay booted with a DATA_KEY that cannot read its own volume').toMatch(/DATA_KEY/)
  })
})
