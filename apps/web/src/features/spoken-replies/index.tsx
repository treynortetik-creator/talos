// Settings -> Voice: whether replies are spoken, and Driving mode. (Voice input, the live-call voice, the microphone mode and
// the persona were archived on 2026-11-19: tag archive/voice-2026-11-19, docs/archived/voice.md.)
import { useId, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import type { SettingsSectionProps } from '../contracts.ts'
import { DrivingRow } from '../drive/DrivingRow.tsx'
import { connectionRefusal, friendlyPatchError } from '../threads/manage/useThreadPatch.ts'

type ReplyWithVoice = 'always' | 'never'
const REPLY_CHOICES: Array<[ReplyWithVoice, string]> = [
  ['always', 'Always'],
  ['never', 'Never'],
]

/** A config saved by an older build may say 'when_voice' (only when I sent a voice note): with no voice notes that is never. */
export const spokenRepliesChoice = (saved: string | undefined): ReplyWithVoice =>
  saved === 'always' ? 'always' : 'never'

export function VoiceSettingsSection({ readOnly }: SettingsSectionProps) {
  return (
    <section aria-label="Voice settings" className="flex flex-col gap-4">
      <h2 className="m-0 font-display text-xl font-semibold">Voice</h2>
      <SpokenReplies readOnly={readOnly} />
      <DrivingRow readOnly={readOnly} />
    </section>
  )
}

/** Whether a reply is also spoken (`voice_notes.reply_with_voice`). Saves at once. The words say what each choice really does. */
function SpokenReplies({ readOnly }: { readOnly: boolean }) {
  const client = useTalosClient()
  const saved = useTalos((s) => spokenRepliesChoice(s.config?.voice_notes.reply_with_voice))
  const ready = useTalos((s) => s.config !== null)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const pick = async (next: string) => {
    setError(null)
    try {
      await client.patchConfig({ voice_notes: { reply_with_voice: next } })
    } catch (e) {
      setError(connectionRefusal(e) ?? friendlyPatchError(e)) // the select shows the saved value, so it is back on it
    }
  }
  return (
    <div className="flex flex-col gap-1" data-testid="spoken-replies">
      <label htmlFor={id} className="text-sm font-medium">
        Spoken replies
      </label>
      <select
        id={id}
        value={saved}
        disabled={readOnly || !ready}
        onChange={(e) => void pick(e.target.value)}
        className="min-h-11 rounded-button border border-line bg-surface px-3 text-text disabled:opacity-50"
      >
        {REPLY_CHOICES.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      <p className="m-0 text-sm text-text-2">
        When a reply is spoken, your Mac reads it with its speech command. Always still sends text if your Mac has no
        speech command set. Never is overridden by Driving mode, which speaks every reply until it ends. Replies that
        come with a spoken version always include audio.
      </p>
      {error && (
        <p role="alert" className="m-0 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
