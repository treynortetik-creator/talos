// Bridge-verified step-up (docs/CLAUDE-CODE.md C3.6). The phone runs a WebAuthn
// assertion whose challenge is bound to the exact card and frame; the raw assertion rides inside the signed
// `card.resolve` (or `session.control`) as `stepup`, is never stripped by the relay, and the BRIDGE verifies it against
// the passkey public key pinned at enrollment (`device.enrolled.credential_public_key`). WP-C6 implements the verify
// with @simplewebauthn/server; this file fixes the wire shape and the challenge.
import { z } from 'zod'
import { b64urlEncode, utf8 } from './encoding.ts'
import { sha256 } from './hash.ts'

const B64url = (max: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`))

/** The raw assertion fields, base64url as SimpleWebAuthn's AuthenticationResponseJSON carries them. */
export const StepupAssertion = z.strictObject({
  credential_id: B64url(1366),
  authenticator_data: B64url(2048),
  client_data_json: B64url(4096),
  signature: B64url(1024),
  user_handle: B64url(128).optional(),
})
export type StepupAssertionT = z.infer<typeof StepupAssertion>

/** The challenge the phone asks the authenticator to sign: base64url(sha256(payload_hash + "\n" + frame id)). */
export function stepupChallenge(payloadHash: string, frameId: string): string {
  return b64urlEncode(sha256(utf8(`${payloadHash}\n${frameId}`)))
}

/** What the bridge must check, in order (C3.6). Spelled out so WP-C6 and its tests share one list. */
export const STEPUP_BRIDGE_CHECKS = [
  'clientDataJSON.type == "webauthn.get"',
  'clientDataJSON.origin == the app origin',
  'clientDataJSON.challenge == stepupChallenge(payload_hash, frame id)',
  'authenticatorData.rpIdHash == sha256(RP_ID)',
  'flags UP and UV set',
  'signature verifies with the pinned credential public key',
  'signCount strictly increases when non-zero (stored per credential)',
] as const
