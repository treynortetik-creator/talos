// Settings patches from an app.
// Handlers of the Hub class (hub.ts), which forwards to them. Dispatch and the first trust checks (session, pairing,
// schema) are in hub-app-conn.ts and hub-app-frames.ts; some handlers here run their own device, seen-id, step-up
// or card-state checks, so read both when auditing trust.
import { checkConfigPatch, type FrameOf, RECOVER_NEEDS_MAC_TEXT, trustOn } from '@talos-app/protocol'
import { consumeStepupToken } from '../auth/contract.ts'
import type { AppConn, Hub, HubDeps } from './hub.ts'
import type { StoredFrame } from './store.ts'
import { mkFrame } from './util.ts'

/** What the config handlers use of Hub, and nothing else. Hub builds it in its constructor. */
export type ConfigCtx = {
  d: HubDeps
  ownerDeviceOk(a: AppConn, deviceId: string, frameId: string): boolean
  acceptOwner(
    a: AppConn,
    frame: { id: string; type: string },
    raw: Record<string, unknown>,
    threadId: string | null,
    extraKeys?: string[],
    alsoWrite?: () => void,
  ): StoredFrame | null
  appError(a: AppConn, code: string, message: string, ref?: unknown): void
  sendApp(a: AppConn, frame: Record<string, unknown>): void
  agentConfig(): ReturnType<Hub['agentConfig']>
  bridgeOnline(): boolean
  toBridge(
    frame: Record<string, unknown>,
    opts: { durable: boolean; ttl_s?: number; alsoWrite?: () => void },
  ): Promise<{ queued: boolean }>
}

export const configFrames = {
  /** The `config.patch` frame: device check, duplicate check, field check, then the step-up the field needs. The `case` of that name in Hub.onAppFrameBuiltin. */
  async onConfigPatch(
    this: ConfigCtx,
    a: AppConn,
    frame: FrameOf<'config.patch'>,
    raw: Record<string, unknown>,
  ): Promise<void> {
    const store = this.d.store
    if (!this.ownerDeviceOk(a, frame.device_id, frame.id)) return
    const dup = store.seen(`of:${frame.id}`)
    if (dup !== undefined) return this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id, seq: dup }))
    const check = checkConfigPatch(frame.patch)
    if (!check.ok) return this.appError(a, 'config_field_forbidden', `field not allowed: ${check.path}`, frame.id)
    // Trust mode (the Mac's config, as last synced): the passkey step is skipped for these two. An app that sent a
    // token anyway has it ignored, unused. An older relay never sees the field and keeps asking.
    const trust = trustOn(this.agentConfig())
    if (check.touchesWorkEnabled && !trust) {
      if (typeof frame.stepup_token !== 'string')
        return this.appError(a, 'stepup_required', 'step-up required to change work integrations', frame.id)
      const ok = await consumeStepupToken({ token: frame.stepup_token, purpose: 'config:work', session: a.session })
      if (!ok) return this.appError(a, 'stepup_invalid', 'step-up token is invalid', frame.id)
    }
    // permission_relay decides who can approve tool calls (docs/CLAUDE-CODE.md C3.6). Turning trust mode ON asks the same
    // passkey step, and trust mode never skips it: the relay's copy of the Mac's config can be stale (a patch queued for a
    // Mac that has since turned trust off must not switch it on untapped). Turning it off needs none.
    if (check.stepupPurpose === 'config:session' && (check.turnsOnTrust || !trust)) {
      if (typeof frame.stepup_token !== 'string')
        return this.appError(
          a,
          'stepup_required',
          check.turnsOnTrust
            ? 'step-up required to turn on trust mode'
            : 'step-up required to change permission settings',
          frame.id,
        )
      const ok = await consumeStepupToken({
        token: frame.stepup_token,
        purpose: 'config:session',
        session: a.session,
      })
      if (!ok) return this.appError(a, 'stepup_invalid', 'step-up token is invalid', frame.id)
    }
    this.acceptOwner(a, frame, raw, null)
    return
  },

  /**
   * The `agent.recover` frame (restart the agent). Queued once for the Mac, like a session control. Any other action,
   * including `restore_last_good` from an old app, is refused in words and never queued: restoring is done at the Mac.
   * A token an old app sends is never spent and never forwarded.
   */
  async onAgentRecover(
    this: ConfigCtx,
    a: AppConn,
    frame: FrameOf<'agent.recover'>,
    raw: Record<string, unknown>,
  ): Promise<void> {
    if (!this.ownerDeviceOk(a, frame.device_id, frame.id)) return
    const store = this.d.store
    const seenKey = `ar:${frame.id}`
    if (store.seen(seenKey) !== undefined) return this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id }))
    if (frame.action !== 'restart') return this.appError(a, 'bad_frame', RECOVER_NEEDS_MAC_TEXT, frame.id)
    if (!this.bridgeOnline()) return this.appError(a, 'mac_offline', 'your Mac is offline', frame.id)
    const { stepup_token: _drop, ...clean } = raw
    // The id is marked seen and the frame queued in ONE transaction: a failed write leaves the id unseen, and two copies
    // at once cannot both pass (nothing awaits between the check and the commit).
    class Refused extends Error {}
    try {
      await this.toBridge(clean, {
        durable: true,
        ttl_s: 300,
        alsoWrite: () => {
          if (store.seen(seenKey) !== undefined) throw new Refused('duplicate')
          store.rememberSeen(seenKey)
        },
      })
    } catch (e) {
      if (e instanceof Refused) {
        return this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id }))
      }
      return this.appError(a, 'internal', 'The relay could not save that. Nothing was sent; try again.', frame.id)
    }
    this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id }))
  },
}
