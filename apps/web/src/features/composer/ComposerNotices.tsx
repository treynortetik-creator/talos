// The lines above the box: a calm note, an error, the too-long offer, and the reply bar.
import { MAX_MESSAGE_CHARS } from '../../lib/socketClient.ts'
import { IconAlert, IconClose } from '../../ui/icons.tsx'
import type { ReplyTarget } from './composerStore.ts'
import type { Note } from './useComposerSend.ts'

export function NoteLine({ note }: { note: Note }) {
  return (
    <p
      role="status"
      data-testid="composer-note"
      className={`m-0 mb-2 text-sm ${note.kind === 'error' ? 'text-danger' : 'text-text-2'}`}
    >
      {note.text}
    </p>
  )
}

export function ErrorLine({ error }: { error: string }) {
  return (
    <p role="alert" className="m-0 mb-2 flex items-center gap-2 text-sm text-danger">
      <IconAlert width={16} height={16} /> {error}
    </p>
  )
}

export function TooLongBar({
  length,
  uploading,
  onSendAsFile,
}: {
  length: number
  uploading: boolean
  onSendAsFile: () => void
}) {
  return (
    <div
      role="alert"
      data-testid="too-long"
      className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-danger"
    >
      <span>
        This is {length.toLocaleString('en-US')} characters. A message can hold{' '}
        {MAX_MESSAGE_CHARS.toLocaleString('en-US')}.
      </span>
      <button
        type="button"
        data-testid="send-as-file"
        onClick={onSendAsFile}
        disabled={uploading}
        className="min-h-11 rounded-pill border border-line px-3 text-text"
      >
        Send as a text file
      </button>
    </div>
  )
}

export function ReplyBar({ target, onCancel }: { target: ReplyTarget; onCancel: () => void }) {
  return (
    <div
      data-testid="reply-bar"
      className="mb-2 flex min-h-9 items-center gap-2 rounded-button border-l-2 border-accent bg-surface px-3 text-sm"
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="text-text-2">Replying to {target.author === 'owner' ? 'yourself' : 'a message'}: </span>
        {target.excerpt}
      </span>
      <button type="button" aria-label="Cancel reply" className="grid size-8 place-items-center" onClick={onCancel}>
        <IconClose width={16} height={16} />
      </button>
    </div>
  )
}
