// Driving mode (docs/V2-FEATURES.md V4.1). Pure: the bridge's reply path and the app both call it.
//   - On: `config.patch {voice_notes:{driving_until: now + 2 h}}` (the bridge clamps it to now + 12 h).
//   - Every agent reply goes out as text at once; a spoken version follows as its own (silent) message.
import type { AgentConfigT } from './config.ts'
import { markdownToPlain } from './markdown-plain.ts'
import { stripExternalBlocks } from './untrusted.ts'

export const DRIVING_FEATURE = 'driving/1'
/** What the app asks for on the toggle (and re-extends to while /drive is open). */
export const DRIVING_DEFAULT_MS = 2 * 3600_000
/** The bridge clamps `driving_until` to now + this (config-file.ts). */
export const DRIVING_MAX_MS = 12 * 3600_000
/** /drive re-extends when less than this is left. */
export const DRIVING_REEXTEND_MS = 30 * 60_000
export const SPOKEN_MAX_CHARS = 1500
/** More than this share of the reply inside code fences: the bridge speaks DETAILS_IN_THREAD instead (the Codex rule). */
export const SPOKEN_CODE_SHARE = 0.4
export const DETAILS_IN_THREAD = 'Details are in the thread.'

type DrivingCfg = {
  voice_notes: Pick<AgentConfigT['voice_notes'], 'reply_with_voice'> & { driving_until?: string | null }
}

/** `driving_until > now`. */
export function drivingActive(cfg: DrivingCfg, now: number): boolean {
  const until = cfg.voice_notes.driving_until
  if (!until) return false
  const t = Date.parse(until)
  return Number.isFinite(t) && t > now
}

/** Driving active -> true (overrides 'never'); else 'always' -> true, 'never' -> false, 'when_voice' -> askedVoice. */
export function wantVoiceReply(cfg: DrivingCfg, now: number, askedVoice: boolean): boolean {
  if (drivingActive(cfg, now)) return true
  const p = cfg.voice_notes.reply_with_voice
  if (p === 'always') return true
  if (p === 'never') return false
  return askedVoice
}

const FENCE = /^\s*(```|~~~)/

/** Share of the text's characters (newlines excluded) that sit inside code fences, fence lines included. */
export function codeFenceShare(text: string): number {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let inside = 0
  let total = 0
  let fenced = false
  for (const line of lines) {
    const n = line.length
    total += n
    if (FENCE.test(line)) {
      inside += n
      fenced = !fenced
      continue
    }
    if (fenced) inside += n
  }
  return total === 0 ? 0 : inside / total
}

/**
 * What the TTS reads: `voiceText` if the agent gave one, else the reply as plain text, with every wrapExternal block
 * removed and at most 1,500 characters. `null` when more than 40 % of a reply without `voiceText` is code: the bridge then
 * speaks DETAILS_IN_THREAD.
 */
export function spokenText(text: string, voiceText?: string): string | null {
  const src = voiceText ?? text
  if (voiceText === undefined && codeFenceShare(stripExternalBlocks(text)) > SPOKEN_CODE_SHARE) return null
  const plain = markdownToPlain(stripExternalBlocks(src))
    .replace(/`+/g, '')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return [...plain].slice(0, SPOKEN_MAX_CHARS).join('')
}
