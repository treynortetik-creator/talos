// The socket SpeakClient: one signed `speak.request`, one `speak.result` routed back by `request_id`. A refusal from the relay
// or the Mac is an `error{ref}` and rejects with `TalosClientError` (see askRead in socketClient.ts).
import { newUlid } from '@talos-app/protocol'
import type { SpeakAnswer, SpeakClient } from './v2Client.ts'

export type SocketSpeakDeps = {
  /** Signs and sends `frame`, resolves with the `speak.result` that carries its `request_id`. */
  ask(frame: Record<string, unknown>): Promise<Record<string, unknown>>
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** One `speak.result` frame as an answer. Anything the app does not know degrades to 'working' (ask again) or a plain failure. */
export function toSpeakAnswer(f: Record<string, unknown>): SpeakAnswer {
  const counts = {
    ...(num(f.chars) !== undefined ? { chars: num(f.chars) as number } : {}),
    ...(num(f.total_chars) !== undefined ? { totalChars: num(f.total_chars) as number } : {}),
    ...(typeof f.truncated === 'boolean' ? { truncated: f.truncated } : {}),
  }
  if (f.state === 'ready') {
    const media = f.media as SpeakAnswerMedia | undefined
    if (!media || typeof media.media_id !== 'string')
      return { state: 'failed', reason: 'tts_failed', message: 'Your Mac said the audio was ready but sent none.' }
    return { state: 'ready', media: media as never, ...counts }
  }
  if (f.state === 'failed') {
    return {
      state: 'failed',
      reason: typeof f.reason === 'string' ? f.reason : 'unknown',
      message: typeof f.message === 'string' && f.message ? f.message : "Your Mac couldn't make the audio.",
    }
  }
  const waitS = num(f.wait_s)
  return { state: 'working', ...(waitS !== undefined ? { waitS } : {}), ...counts }
}
type SpeakAnswerMedia = { media_id?: unknown }

export function createSocketSpeak(d: SocketSpeakDeps): SpeakClient {
  return {
    async request({ messageId, threadId, fresh }) {
      const f = await d.ask({
        type: 'speak.request',
        request_id: newUlid(),
        message_id: messageId,
        thread_id: threadId,
        fresh,
      })
      return toSpeakAnswer(f)
    },
  }
}
