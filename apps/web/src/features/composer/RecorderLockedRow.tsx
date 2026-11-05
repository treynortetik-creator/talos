// The row shown while a voice note is locked: cancel, time, pause with preview, send.
import { formatDuration } from '../../lib/format.ts'
import { IconPause, IconPlay, IconSend, IconTrash } from '../../ui/icons.tsx'

export function RecorderLockedRow({
  elapsed,
  paused,
  preview,
  onCancel,
  onTogglePause,
  onSend,
}: {
  elapsed: number
  paused: boolean
  preview: string | null
  onCancel: () => void
  onTogglePause: () => void
  onSend: () => void
}) {
  return (
    <div className="flex items-center gap-3" data-testid="recorder-locked">
      <button
        type="button"
        aria-label="Cancel recording"
        onClick={onCancel}
        className="grid size-11 place-items-center rounded-pill text-danger"
      >
        <IconTrash />
      </button>
      <span className="font-mono text-sm" role="timer" aria-label="Recording time">
        <span className="mr-2 inline-block size-2 rounded-pill bg-danger" aria-hidden="true" />
        {formatDuration(elapsed)}
      </span>
      <button
        type="button"
        aria-label={paused ? 'Resume recording' : 'Pause recording'}
        onClick={onTogglePause}
        className="grid size-11 place-items-center rounded-pill border border-line"
      >
        {paused ? <IconPlay /> : <IconPause />}
      </button>
      {preview && (
        // biome-ignore lint/a11y/useMediaCaption: owner's own recording preview
        <audio controls src={preview} className="h-9 min-w-0 flex-1" aria-label="Preview recording" />
      )}
      <span className="flex-1" />
      <button
        type="button"
        aria-label="Send voice note"
        onClick={onSend}
        className="grid size-14 place-items-center rounded-pill bg-accent text-on-accent"
      >
        <IconSend />
      </button>
    </div>
  )
}
