// The proof agent-request.json carries for the phone's Restart agent (frames.ts, `AgentRequestProof`): built from the owner's own
// `agent.recover` frame as received, so the Mac app can check the owner's signature itself instead of trusting the bridge.
import { b64urlEncode, utf8 } from './encoding.ts'
import type { AgentRequestProofT } from './frames.ts'
import { ownerSignedString } from './owner-sig.ts'

/**
 * `raw` is the frame exactly as received (never a parsed copy). The signed bytes are `ownerSignedString(raw)` as UTF-8: the same function
 * `verifyOwnerFrame` hashes, on the same object, so they are the bytes the bridge verified. Null when `raw` carries no signature or device.
 */
export function buildAgentRequestProof(raw: Record<string, unknown>): AgentRequestProofT | null {
  if (typeof raw.osig !== 'string' || typeof raw.device_id !== 'string') return null
  return { device_id: raw.device_id, osig: raw.osig, signed_b64url: b64urlEncode(utf8(ownerSignedString(raw))) }
}
