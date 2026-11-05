// @vitest-environment node
// WP-I6: the Mac app's web view has no passkeys. Its step-up says where to approve instead of a false "cancelled".
import { describe, expect, it, vi } from 'vitest'

const { startAuthentication } = vi.hoisted(() => ({ startAuthentication: vi.fn() }))
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication, startRegistration: vi.fn() }))

import { DESKTOP_UA_MARK } from '../src/lib/native/detect.ts'
import { installShell } from '../src/lib/native/shell.ts'
import { PasskeyUnavailableError, passkeyBlock, passkeyErrorCopy } from '../src/lib/passkeyGate.ts'
import { createSocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

describe('Mac app step-up', () => {
  it("says 'Approve on your phone or in a browser.' and never reaches WebAuthn or the network", async () => {
    const scope: Record<string, unknown> = {
      webkit: { messageHandlers: { talos: { postMessage() {} } } },
      navigator: { userAgent: `Mozilla/5.0${DESKTOP_UA_MARK}1` },
    }
    scope.top = scope
    expect(installShell(scope)).not.toBeNull()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await passkeyBlock()).toBe('mac_app')
    const client = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: 'ws://127.0.0.1:1/ws',
      isOnline: () => true,
    })
    const err = await client.stepup('card:c_x').catch((e) => e)
    expect(err).toBeInstanceOf(PasskeyUnavailableError)
    expect(passkeyErrorCopy(err)).toBe('Approve on your phone or in a browser.')
    expect(startAuthentication).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    client.close()
    vi.unstubAllGlobals()
  })
})
