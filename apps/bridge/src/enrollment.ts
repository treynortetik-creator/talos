// Device pinning on the Mac (spec 3.5, 4.10). The relay never sees `code_bind`, so it cannot mint a binding for its own
// key. A binding that verifies still is not enough: the owner answers y/N at the Mac, with a four-word fingerprint, and
// only `y` pins the device.
import { type Frame, fingerprintWords, sanitizeExternal, verifyEnrollment } from '@talos-app/protocol'
import { type BridgeContext, postSystemNotice } from './context.ts'
import { CONFIRM_WAIT_MS, EnrollFiles, PENDING_KEEP_MS } from './enroll-files.ts'
import { devicePinnedFrame } from './frames-out.ts'

type Enrolled = Extract<Frame, { type: 'device.enrolled' }>
type Revoked = Extract<Frame, { type: 'device.revoked' }>

const DEVICE_NAME_MAX = 40

const UNSAFE_NAME_CHARS = new RegExp(
  `[${['\\u0000-\\u001f', '\\u007f-\\u009f', '\\u061c', '\\u200b-\\u200f', '\\u2028-\\u202e', '\\u2066-\\u2069', '\\ufeff', '\\u{e0000}-\\u{e007f}'].join('')}]+`,
  'gu',
)

/**
 * The device name is chosen by the phone (and rewritable by a compromised relay: the binding does not cover it). It is
 * never trusted: control, escape and bidi characters go, it becomes one line, the quote characters go, and it is capped.
 */
export function cleanDeviceName(name: string): string {
  const oneLine = name.replace(UNSAFE_NAME_CHARS, ' ').replace(/["`\\]/g, "'")
  const s = sanitizeExternal(oneLine, DEVICE_NAME_MAX).replace(/\s+/g, ' ').trim()
  return s === '' ? 'unnamed device' : s
}

export class Enrollment {
  readonly files: EnrollFiles

  constructor(private readonly ctx: BridgeContext) {
    this.files = new EnrollFiles(ctx.paths.enrollPending)
  }

  private async pinned(
    deviceId: string,
    ok: boolean,
    reason?: 'declined' | 'bad_binding' | 'code_unknown' | 'revoked',
  ) {
    try {
      await this.ctx.transport.sendDurable(devicePinnedFrame(this.ctx.clock.now(), deviceId, ok, reason))
    } catch (e) {
      this.ctx.log.warn('device.pinned not sent', { error: (e as Error).message })
    }
  }

  /** `device.enrolled` from the relay: check the binding against the pending code, then wait for the owner's y/N. */
  async onEnrolled(frame: Enrolled): Promise<void> {
    const { ctx } = this
    const dev = frame.device
    if (ctx.devices.isRevoked(dev.id)) {
      ctx.log.security('enrollment for a revoked device refused', { device_id: dev.id })
      return this.pinned(dev.id, false, 'revoked')
    }
    const pending = this.files.readPending(frame.code_id)
    if (!pending) return this.pinned(dev.id, false, 'code_unknown')
    const ok = await verifyEnrollment(pending.code, dev.id, dev.pubkey_jwk, frame.binding)
    if (!ok) {
      ctx.log.security('enrollment binding did not verify', { device_id: dev.id })
      return this.pinned(dev.id, false, 'bad_binding')
    }
    const existing = this.files.readConfirm(frame.code_id)
    if (existing) {
      if (existing.device_id === dev.id) return // the relay delivered the same enrollment twice
      // F2: a second device on a code that is already awaiting the owner. Neither is pinned: the prompt the owner
      // may be answering belongs to the first device, so it is withdrawn, and the code is spent.
      ctx.log.security('second enrollment on a pending code: both refused', {
        device_id: dev.id,
        first_device_id: existing.device_id,
      })
      this.files.removeAll(frame.code_id)
      await this.pinned(existing.device_id, false, 'code_unknown')
      return this.pinned(dev.id, false, 'code_unknown')
    }
    this.files.writeConfirm(frame.code_id, {
      device_id: dev.id,
      name: cleanDeviceName(dev.name),
      fingerprint: [...fingerprintWords(dev.id)],
      pubkey_jwk: dev.pubkey_jwk,
      created_at: new Date(ctx.clock.now()).toISOString(),
    })
    ctx.log.info('device awaiting the Mac confirmation', { device_id: dev.id })
  }

  /** `device.revoked` from the app: mark devices.json the same way the CLI does. */
  async onRevoked(frame: Revoked): Promise<void> {
    this.ctx.devices.revoke(frame.device_id, new Date(this.ctx.clock.now()).toISOString())
    await postSystemNotice(this.ctx, `Device revoked: ${frame.device_id}.`, { toAgent: true })
  }

  /** Acts on answers, times out unanswered prompts and removes stale pending codes. Called on file changes and every 10 s. */
  async poll(): Promise<void> {
    const { ctx } = this
    const now = ctx.clock.now()
    for (const codeId of this.files.codeIds()) {
      const pending = this.files.readPending(codeId)
      const confirm = this.files.readConfirm(codeId)
      if (!pending) continue
      if (!confirm) {
        if (now - Date.parse(pending.created_at) > PENDING_KEEP_MS) this.files.removeAll(codeId)
        continue
      }
      const answer = this.files.readAnswer(codeId)
      if (answer?.device_id !== undefined && answer.device_id !== confirm.device_id) {
        // an answer for some other device: it never pins this one
        ctx.log.security('answer does not match the pending device', { device_id: confirm.device_id })
        this.files.removeAll(codeId)
        await this.pinned(confirm.device_id, false, 'declined')
        continue
      }
      if (answer?.yes) {
        const at = new Date(now).toISOString()
        const r = ctx.devices.pin({ id: confirm.device_id, name: confirm.name, pubkey_jwk: confirm.pubkey_jwk }, at)
        this.files.removeAll(codeId)
        if (!r.ok) {
          if (r.reason === 'corrupt') ctx.log.security('devices.json is unreadable; device not pinned', {})
          await this.pinned(confirm.device_id, false, r.reason === 'corrupt' ? 'declined' : 'revoked')
          continue
        }
        await this.pinned(confirm.device_id, true)
        await postSystemNotice(
          ctx,
          `New device pinned (${fingerprintWords(confirm.device_id).join(' ')}), device-supplied name (untrusted text): "${cleanDeviceName(confirm.name)}", ${at.slice(0, 16).replace('T', ' ')} UTC.`,
          {
            toAgent: true,
          },
        )
        ctx.log.info('device pinned', { device_id: confirm.device_id })
      } else if (answer || now - Date.parse(confirm.created_at) > CONFIRM_WAIT_MS) {
        this.files.removeAll(codeId)
        await this.pinned(confirm.device_id, false, 'declined')
        ctx.log.info('device not pinned', { device_id: confirm.device_id, answered: Boolean(answer) })
      }
    }
  }
}
