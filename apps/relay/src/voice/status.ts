// Whether live voice can work on this relay, and if not why. Served in GET /api/me so the app can tell the owner how to
// turn it on. Only a reason code leaves the relay, never the key.
import type { RelayEnv } from '../env.ts'

export type VoiceStatus = { available: true } | { available: false; reason: 'no_key' | 'unsupported_provider' }

export function voiceStatus(env: Pick<RelayEnv, 'OPENAI_API_KEY'>): VoiceStatus {
  if (!env.OPENAI_API_KEY) return { available: false, reason: 'no_key' }
  // There is one provider and no VOICE_PROVIDER variable any more, so no provider can be unsupported; the reason code stays for older apps.
  return { available: true }
}
