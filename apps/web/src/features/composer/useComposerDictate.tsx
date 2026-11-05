// Dictation as the composer uses it: the words go onto the end of whatever is in the box, like typed ones.
// Nothing here sends a message.
import { type ReactNode, type RefObject, useEffect } from 'react'
import { coarsePointer, hasKeyboardPlugin } from '../../lib/native.ts'
import { DictateButton, DictateStrip, focusIsLost } from './DictateUi.tsx'
import { appendWords } from './dictate.ts'
import type { Recording } from './recorder.ts'
import { useDictateAvailable, useDictation } from './useDictation.ts'

export function useComposerDictate(o: {
  threadId: string
  box: RefObject<HTMLTextAreaElement | null>
  text: string
  setText(next: string): void
  /** Clears the note line under the box when words arrive. */
  clearNote(): void
  sendRecording(r: Recording): Promise<void>
  /** A dictation got a 401: tell the app its session ended, with the relay's reason. */
  endSession(reason: string | null): void
}): { strip: ReactNode; button: ReactNode; busy: boolean } {
  const on = useDictateAvailable()
  const d = useDictation({
    threadId: o.threadId,
    onWords: (words) => {
      // Read the box as it is now, not as it was at the tap: the owner may have typed or cleared it since.
      o.setText(appendWords(o.box.current?.value ?? o.text, words))
      o.clearNote()
      // The button was off while working; keep a keyboard user in the flow. Same rule as the composer's picker: on touch
      // outside the shell (Safari, Home Screen) the refocus can pop the keyboard, so skip it there.
      if (focusIsLost() && (hasKeyboardPlugin() || !coarsePointer())) o.box.current?.focus()
    },
    onSignedOut: o.endSession,
    sendAsVoiceNote: o.sendRecording,
  })
  // Sending the message, or clearing the box, ends the story "Added to your message".
  const { phase, dismiss } = d
  useEffect(() => {
    if (phase.kind === 'done' && o.text === '') dismiss()
  }, [phase.kind, o.text, dismiss])
  if (!on) return { strip: null, button: null, busy: false }
  return {
    // Recording, working, or holding a recording that waits for a choice: nothing else may take the microphone or the call.
    busy:
      d.phase.kind === 'recording' || d.phase.kind === 'transcribing' || (d.phase.kind === 'failed' && d.phase.kept),
    strip: (
      <DictateStrip
        phase={d.phase}
        onStop={() => void d.stop()}
        onCancel={d.cancel}
        onRetry={d.retry}
        onVoiceNote={() => void d.asVoiceNote()}
        onDismiss={d.dismiss}
      />
    ),
    button: <DictateButton phase={d.phase} disabled={false} onStart={d.start} onStop={() => void d.stop()} />,
  }
}
