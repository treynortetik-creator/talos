// Settings patches from an app.
// Handlers of the Hub class (hub.ts), which forwards to them. Dispatch and the first trust checks (session, pairing,
// schema) are in hub-app-conn.ts and hub-app-frames.ts; some handlers here run their own device, seen-id, step-up
// or card-state checks, so read both when auditing trust.
import { BUG_WEBHOOK_URL_RULE, checkConfigPatch, type FrameOf, RECOVER_NEEDS_MAC_TEXT } from '@talos-app/protocol'
import { checkWebhookUrl } from './bug-reports.ts'
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
    audience?: 'both' | 'bridge',
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
  /** The `config.patch` frame: device check, duplicate check, field check. The `case` of that name in Hub.onAppFrameBuiltin. */
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
    // where bug reports are sent: an address the webhook would refuse is refused here, in the same words, before it is saved
    const hook = (frame.patch as { bug_webhook_url?: unknown }).bug_webhook_url
    if (typeof hook === 'string' && !checkWebhookUrl(hook, this.d.env.NODE_ENV === 'test'))
      return this.appError(a, 'config_field_forbidden', BUG_WEBHOOK_URL_RULE, frame.id)
    // No passkey step-up for any setting (owner ruling 2026-11-14): the owner's signature on the frame is the approval. An old
    // app's `stepup_token` is never read or forwarded.
    // A patch that carries the bug webhook address is kept for the Mac only: catch-up would otherwise hand the address (and
    // the token in its path) back to every device for BUFFER_DAYS. Devices learn the change from the Mac's config.sync,
    // which shows only the host.
    this.acceptOwner(a, frame, raw, null, [], undefined, check.setsBugWebhook ? 'bridge' : 'both')
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

  /**
   * The `undo.request` frame ("Undo to here"): queued once for the Mac, which checks the owner's signature and answers
   * with an undo card or why not (`undo.request.result`, session/index.ts). Nothing is restored before the owner
   * approves that card. Like agent.recover: only the owner's own device, never a repeat, never queued for a Mac that is away.
   */
  async onUndoRequest(
    this: ConfigCtx,
    a: AppConn,
    frame: FrameOf<'undo.request'>,
    raw: Record<string, unknown>,
  ): Promise<void> {
    if (!this.ownerDeviceOk(a, frame.device_id, frame.id)) return
    const store = this.d.store
    const seenKey = `ur:${frame.id}`
    if (store.seen(seenKey) !== undefined) return this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id }))
    if (!this.bridgeOnline()) return this.appError(a, 'mac_offline', 'your Mac is offline', frame.id)
    class Refused extends Error {}
    try {
      await this.toBridge(raw, {
        durable: true,
        ttl_s: 300,
        alsoWrite: () => {
          if (store.seen(seenKey) !== undefined) throw new Refused('duplicate')
          store.rememberSeen(seenKey)
        },
      })
    } catch (e) {
      if (e instanceof Refused) return this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id }))
      return this.appError(a, 'internal', 'The relay could not save that. Nothing was sent; try again.', frame.id)
    }
    this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id }))
  },
  /**
   * The `plugin.add.request` frame ("Add plugin to agent"): queued once for the Mac, which checks the owner's signature and answers
   * with a card or why not (`plugin.add.result`, session/index.ts). Nothing is installed before the owner approves that card. Like
   * undo.request: only the owner's own device, never a repeat, never queued for a Mac that is away.
   */
  async onPluginAddRequest(
    this: ConfigCtx,
    a: AppConn,
    frame: FrameOf<'plugin.add.request'>,
    raw: Record<string, unknown>,
  ): Promise<void> {
    if (!this.ownerDeviceOk(a, frame.device_id, frame.id)) return
    const store = this.d.store
    const seenKey = `pa:${frame.id}`
    if (store.seen(seenKey) !== undefined) return this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id }))
    if (!this.bridgeOnline()) return this.appError(a, 'mac_offline', 'your Mac is offline', frame.id)
    class Refused extends Error {}
    try {
      await this.toBridge(raw, {
        durable: true,
        ttl_s: 300,
        alsoWrite: () => {
          if (store.seen(seenKey) !== undefined) throw new Refused('duplicate')
          store.rememberSeen(seenKey)
        },
      })
    } catch (e) {
      if (e instanceof Refused) return this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id }))
      return this.appError(a, 'internal', 'The relay could not save that. Nothing was sent; try again.', frame.id)
    }
    this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id }))
  },
}
