// Needs-you prompts: the proof an answer file carries, and the check the Mac makes before it presses a key
// (dialog-files.ts, `DialogAnswer`, lists the steps; docs/OPTION-C.md "Needs-you prompts" has them in full). This file is the
// reference version of that check, in TypeScript: the bridge builds the proof with `buildDialogProof` and runs the check on its
// own answer before it writes the file, and the tests run it against the fixtures the Swift side is built against.
import { jcs } from './canonical.ts'
import {
  DIALOG_PROOF_MAX_AGE_MS,
  DIALOG_PROOF_MAX_FUTURE_MS,
  DialogAnswer,
  type DialogAnswerT,
  type DialogKindT,
  type DialogProofT,
} from './dialog-files.ts'
import { sha256Hex } from './hash.ts'
import type { JwkP256T } from './models.ts'
import { deviceIdFromJwk, ownerSignedString, verifyOwnerSignedString } from './owner-sig.ts'

/**
 * The proof for an answer: the owner's own `card.resolve` frame, as received (`raw`, never a parsed copy), and the card's
 * binding. Null when `raw` carries no signature or device.
 */
export function buildDialogProof(raw: Record<string, unknown>, binding: unknown): DialogProofT | null {
  if (typeof raw.osig !== 'string' || typeof raw.device_id !== 'string') return null
  return { signed: ownerSignedString(raw), osig: raw.osig, device_id: raw.device_id, binding: jcs(binding) }
}

/** What the Mac knows about the dialog on its pane, from its own reading (the record it wrote to workers.json). */
export type PaneDialog = {
  dialog_id: string
  dialog_kind: DialogKindT
  subject: string | null
  options: readonly string[]
  /** Main's development-channels dialog: which pieces of the start command changed (absent for every other dialog). The signed card must say the same. */
  launch_changed?: readonly string[] | undefined
}

export type DialogVerifyEnv = {
  /** The one place a device's key comes from: a device paired and not revoked in devices.json. */
  pinnedKey(deviceId: string): JwkP256T | undefined
  nowMs: number
  /** The thread this worker is. */
  thread: string
  /** The dialog on the pane now, as the Mac itself recorded it. */
  pane: PaneDialog
  /** The label the screen shows now for an option, or undefined if it shows none there. Omit to skip step 5's screen check. */
  screenLabel?(choice: number): string | undefined
  /** The Mac already pressed something for this dialog id. */
  alreadyPressed?: boolean
}

export type DialogVerdict =
  | { ok: true; choice: number | null; label: string | null; device_id: string }
  | { ok: false; reason: 'unverified' | 'screen_changed' | 'already_answered'; step: number; why: string }

const no = (
  step: number,
  why: string,
  reason: 'unverified' | 'screen_changed' | 'already_answered' = 'unverified',
): DialogVerdict => ({
  ok: false,
  reason,
  step,
  why,
})

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function sameFacts(binding: Record<string, unknown>, pane: PaneDialog): boolean {
  const p = binding.payload
  if (!isObject(p)) return false
  const o = p.options
  const lc = p.launch_changed
  const sameLaunch =
    pane.launch_changed === undefined
      ? lc === undefined
      : Array.isArray(lc) &&
        lc.length === pane.launch_changed.length &&
        lc.every((x, i) => x === pane.launch_changed?.[i])
  return (
    sameLaunch &&
    p.dialog_id === pane.dialog_id &&
    p.dialog_kind === pane.dialog_kind &&
    p.subject === pane.subject &&
    Array.isArray(o) &&
    o.length === pane.options.length &&
    o.every((x, i) => x === pane.options[i])
  )
}

/** The Mac's check of an answer file's content (already parsed from JSON). Never throws. */
export async function verifyDialogAnswer(input: unknown, env: DialogVerifyEnv): Promise<DialogVerdict> {
  try {
    const parsed = DialogAnswer.safeParse(input)
    if (!parsed.success) return no(0, 'not a v2 answer with a proof')
    const a: DialogAnswerT = parsed.data
    const { proof } = a
    if (a.dialog_id !== env.pane.dialog_id) return no(0, 'not the dialog on the pane')
    // 1: a pinned device whose key is that device's
    const key = env.pinnedKey(proof.device_id)
    if (!key) return no(1, 'device is not pinned on this Mac')
    if ((await deviceIdFromJwk(key)) !== proof.device_id) return no(1, 'the pinned key is not that device')
    // 2: the owner's signature over the exact text
    if (!(await verifyOwnerSignedString(proof.signed, proof.osig, proof.device_id, key)))
      return no(2, 'signature does not verify')
    // 3: what was signed
    let signed: unknown
    try {
      signed = JSON.parse(proof.signed)
    } catch {
      return no(3, 'signed text is not JSON')
    }
    if (!isObject(signed)) return no(3, 'signed text is not an object')
    if (signed.type !== 'card.resolve' || signed.action !== 'primary') return no(3, 'not a primary card.resolve')
    if ('edited' in signed) return no(3, 'an edited resolve')
    if (signed.device_id !== proof.device_id) return no(3, 'signed by another device than the proof names')
    const choice = signed.choice
    if (choice !== undefined && !(Number.isInteger(choice) && (choice as number) >= 0 && (choice as number) <= 5))
      return no(3, 'choice is not 0 to 5')
    const ts = typeof signed.ts === 'string' ? Date.parse(signed.ts) : Number.NaN
    if (!Number.isFinite(ts) || env.nowMs - ts > DIALOG_PROOF_MAX_AGE_MS || ts - env.nowMs > DIALOG_PROOF_MAX_FUTURE_MS)
      return no(3, 'the tap is too old or from the future')
    // 4: the card that was shown is the dialog on the pane
    if (`sha256:${sha256Hex(proof.binding)}` !== signed.payload_hash)
      return no(4, 'binding is not the card that was signed')
    let binding: unknown
    try {
      binding = JSON.parse(proof.binding)
    } catch {
      return no(4, 'binding is not JSON')
    }
    if (!isObject(binding)) return no(4, 'binding is not an object')
    if (binding.kind !== 'dialog' || binding.id !== signed.card_id) return no(4, 'binding is not this dialog card')
    if (binding.thread_id !== env.thread) return no(4, 'card is for another thread')
    if (!isObject(binding.payload) || binding.payload.thread !== env.thread) return no(4, 'card is for another thread')
    if (!sameFacts(binding, env.pane)) return no(4, 'the card is not the dialog this Mac saw')
    // 5: the option, on the screen now, once
    const options = env.pane.options
    if (env.pane.dialog_kind === 'login') {
      if (choice !== undefined || a.action !== 'open') return no(5, 'a login dialog is opened, not chosen')
    } else if (choice === undefined || (choice as number) >= options.length) return no(5, 'no such option')
    if (env.alreadyPressed) return no(5, 'already pressed for this dialog', 'already_answered')
    const label = choice === undefined ? null : (options[choice as number] ?? null)
    if (label !== null && env.screenLabel && env.screenLabel(choice as number) !== label)
      return no(5, 'the screen no longer shows that option', 'screen_changed')
    return { ok: true, choice: choice === undefined ? null : (choice as number), label, device_id: proof.device_id }
  } catch (e) {
    return no(0, `error: ${(e as Error).message}`)
  }
}
