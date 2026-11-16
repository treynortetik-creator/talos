// The one truthful status line for a media file that is coming back from the Mac or did not.
/** One truthful line for a file that is coming back from the Mac or did not: never "Loading" forever. */
export function MediaStatus({
  state,
  what,
  onRetry,
  onLoad,
  removedDays,
}: {
  state: 'fetching' | 'failed' | 'gone' | 'removed'
  what: string
  /** For `removed`: the storage setting's day count, when the Mac said it. */
  removedDays?: number | null
  onRetry: () => void
  onLoad?: () => void
}) {
  if (state === 'fetching')
    return (
      <span role="status" data-testid="media-fetching">
        Loading {what} from your Mac…
      </span>
    )
  // not an error: the owner's storage setting removed it, and it cannot come back
  if (state === 'removed')
    return (
      <span role="status" data-testid="media-removed">
        {what} was removed from your Mac{removedDays ? ` after ${removedDays} days` : ''} (Settings, Storage).
      </span>
    )
  if (state === 'gone')
    return (
      <span role="status" data-testid="media-gone" className="flex flex-wrap items-center gap-x-3">
        <span>{what} is only on your Mac now.</span>
        <button type="button" onClick={onLoad} className="min-h-11 text-accent-text underline">
          Load from your Mac
        </button>
      </span>
    )
  return (
    <span role="alert" data-testid="media-failed" className="flex flex-wrap items-center gap-x-3">
      <span>Couldn't load {what}. Your Mac may be offline, or the file is gone.</span>
      <button type="button" onClick={onRetry} className="min-h-11 text-accent-text underline">
        Retry
      </button>
    </span>
  )
}
