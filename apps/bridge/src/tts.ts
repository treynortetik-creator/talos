// Text to speech through the owner's own command (spec 4.2), optionally transcoded to AAC with ffmpeg.
import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { BridgeEnv, BridgePaths } from './config.ts'
import { fillArgv, runArgv } from './exec.ts'

export const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
}

export type TtsResult = { ok: true; path: string; mime: string; ext: string } | { ok: false; reason: string }

export async function synthesize(env: BridgeEnv, p: BridgePaths, text: string, id: string): Promise<TtsResult> {
  if (!env.ttsCmd) return { ok: false, reason: 'no TTS command configured' }
  const out = join(p.media, `tts-${id}.${env.ttsExt}`)
  const res = await runArgv(
    fillArgv(env.ttsCmd, {
      out,
      text: text.startsWith('-') ? ` ${text}` : text,
    }) /* never starts with '-': no flag injection */,
    env.ttsTimeoutS * 1000,
  )
  if (!res.ok) return { ok: false, reason: res.reason === 'timeout' ? 'timed out' : `command failed (${res.reason})` }
  if (!existsSync(out) || statSync(out).size === 0) return { ok: false, reason: 'command wrote no audio' }
  if (!env.ffmpeg)
    return { ok: true, path: out, ext: env.ttsExt, mime: AUDIO_MIME[env.ttsExt] ?? 'application/octet-stream' }
  const m4a = join(p.media, `tts-${id}.m4a`)
  const tmp = `${m4a}.part.m4a`
  const t = await runArgv(
    [env.ffmpeg, '-y', '-loglevel', 'error', '-i', out, '-c:a', 'aac', '-b:a', '48k', '-ac', '1', tmp],
    env.ttsTimeoutS * 1000,
  )
  if (!t.ok || !existsSync(tmp) || statSync(tmp).size === 0) {
    try {
      unlinkSync(tmp)
    } catch {
      // nothing written
    }
    return { ok: false, reason: 'ffmpeg transcode failed' }
  }
  renameSync(tmp, m4a)
  if (out !== m4a) {
    try {
      unlinkSync(out) // the uncompressed original is no longer needed
    } catch {
      // already gone
    }
  }
  return { ok: true, path: m4a, ext: 'm4a', mime: 'audio/mp4' }
}

/** Floor for how long kept audio and upload copies live: the app keeps history 90 days by default, and a file must outlast the row that points at it. */
export const TTS_KEEP_MS = 7 * 24 * 3600_000

/** Name prefix of the copy `MediaStore.upload` keeps in the media folder. */
export const UPLOAD_COPY_PREFIX = 'up-'
/** Name prefix of the per-message read-aloud index (`speak-<message id>.json`); it goes when the audio it points at goes. */
export const SPEAK_CACHE_PREFIX = 'speak-'

/**
 * Deletes files in the media folder whose name starts with one of `prefixes` and that are older than `keepMs`; returns
 * how many went. Callers pass the history window, so an attachment on screen can still be asked back from the Mac.
 */
export function pruneKeptFiles(mediaDir: string, now: number, keepMs: number, prefixes: readonly string[]): number {
  let n = 0
  try {
    for (const f of readdirSync(mediaDir)) {
      if (!prefixes.some((p) => f.startsWith(p))) continue
      const full = join(mediaDir, f)
      try {
        if (now - statSync(full).mtimeMs > keepMs) {
          unlinkSync(full)
          n++
        }
      } catch {
        // raced with another process
      }
    }
  } catch {
    // no media folder yet
  }
  return n
}

/** Deletes synthesized audio (`tts-*`), read-aloud indexes (`speak-*`) and upload copies (`up-*`) older than `keepMs` (the history window). */
export const pruneTtsFiles = (mediaDir: string, now: number, keepMs: number = TTS_KEEP_MS): number =>
  pruneKeptFiles(mediaDir, now, keepMs, ['tts-', SPEAK_CACHE_PREFIX, UPLOAD_COPY_PREFIX])
