// Whether live voice is switched on at the relay, and the plain-words note shown where voice controls appear when it is
// not. The key lives in the relay's environment only; the app never asks for one.
import { useSession } from '../auth/session.ts'

export const VOICE_SETUP_URL = 'https://github.com/treynortetik-creator/talos/blob/main/docs/SETUP.md#voice'
export const VOICE_OFF_TEXT =
  "Live voice is off. Add OPENAI_API_KEY to your relay's environment (Railway → your service → Variables), then redeploy."

export const VOICE_OFF_TITLE = 'Live voice is off. Tap for how to turn it on.'

// Fake mode has no relay to ask: `?voice=off` (read once, so it survives in-app navigation) shows the off state.
const FAKE_VOICE_OFF =
  import.meta.env.VITE_FAKE === '1' && new URLSearchParams(globalThis.location?.search ?? '').get('voice') === 'off'

export type VoiceAvailability = { available: boolean; reason?: string }

/** Unknown (older relay, not signed in yet, offline cache from before this field) counts as available: no false alarm. */
export function useVoiceAvailability(): VoiceAvailability {
  const voice = useSession((s) => s.me?.voice)
  if (FAKE_VOICE_OFF) return { available: false, reason: 'no_key' }
  return voice ?? { available: true }
}

export function VoiceOffNotice({ reason, className }: { reason?: string; className?: string }) {
  const text =
    reason === 'unsupported_provider'
      ? 'Live voice is off. VOICE_PROVIDER=realtime is not supported yet; remove it or set it to live, then redeploy.'
      : VOICE_OFF_TEXT
  return (
    <p data-testid="voice-off-notice" className={className ?? 'm-0 text-sm text-text-2'}>
      {text}{' '}
      <a href={VOICE_SETUP_URL} target="_blank" rel="noreferrer" className="text-accent underline">
        How to set this up
      </a>
    </p>
  )
}
