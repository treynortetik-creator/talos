import { detectShell } from './native/detect.ts'

/** What to say when the microphone is refused, pointing at the right switch for where the page runs. */
export function micOffText(): string {
  return detectShell() === 'desktop'
    ? 'Microphone is off for Talos. System Settings → Privacy & Security → Microphone.'
    : 'Microphone is off for Talos. Settings → Talos → Microphone.'
}
