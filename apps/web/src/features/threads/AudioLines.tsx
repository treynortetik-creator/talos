// The two plain lines a row that plays audio shows instead of sound: the start was refused (or never took), or the clip is waiting
// for data. One wording and one hook for every row (a voice note, read aloud, the Files sheet), so no row is silent.
import { useAudio } from './audioPlayer.ts'

export const AUDIO_REFUSED_TEXT = "Couldn't start playing. Tap Play to try again."
export const AUDIO_BUFFERING_TEXT = 'Loading audio…'

export type AudioLineKind = 'refused' | 'buffering'

/** What the player says about the clip with this row key right now, if it is loaded in the player. */
export function useAudioLine(key: string): AudioLineKind | null {
  const refused = useAudio((s) => s.item?.key === key && s.refused)
  const buffering = useAudio((s) => s.item?.key === key && s.buffering)
  return refused ? 'refused' : buffering ? 'buffering' : null
}

export const audioLineText = (line: AudioLineKind): string =>
  line === 'refused' ? AUDIO_REFUSED_TEXT : AUDIO_BUFFERING_TEXT

/** The line as its own block under a row. */
export function AudioLine({ line, className }: { line: AudioLineKind | null; className?: string }) {
  if (!line) return null
  return (
    <div role={line === 'refused' ? 'alert' : 'status'} data-testid={`audio-${line}`} className={className}>
      {audioLineText(line)}
    </div>
  )
}
