import type { MessageT } from '@talos-app/protocol'
import { useTalosClient } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { IconPause, IconPlay } from '../../ui/icons.tsx'
import { audioDock, useDock } from './audioDock.ts'
import { cancelSpeak, speakKey, startSpeak, useSpeak } from './speak.ts'

/**
 * The play button under an agent message: Listen -> (Preparing…) -> Pause/Resume in the app-level player. A failure or a
 * Mac with no voice set up says so in words under the message and the button turns into Try again. The audio is made by the
 * Mac's own voice command (see speak.ts); nothing is spoken until this button is tapped.
 */
export function SpeakButton({ m }: { m: MessageT }) {
  const client = useTalosClient()
  const key = speakKey(m.id)
  const view = useSpeak(m.id)
  const mine = useDock((s) => s.item?.key === key)
  const playing = useDock((s) => s.item?.key === key && s.playing)
  const dockFailed = useDock((s) => s.item?.key === key && s.failed)
  const loading = view.status === 'loading'
  const failed = view.status === 'failed' || dockFailed
  const label = loading
    ? 'Cancel preparing audio'
    : playing
      ? 'Pause'
      : mine && !dockFailed
        ? 'Resume'
        : failed
          ? 'Try again'
          : 'Listen'
  const onClick = () => {
    if (loading) return cancelSpeak(m.id)
    if (mine && !dockFailed) return playing ? audioDock.pause() : audioDock.resume()
    startSpeak(client, m)
  }
  const shown = loading ? 'Preparing audio…' : label
  return (
    <>
      <button
        type="button"
        data-testid="speak"
        data-state={
          loading ? 'loading' : playing ? 'playing' : mine && !dockFailed ? 'paused' : failed ? 'failed' : 'idle'
        }
        aria-label={`${label}${label === 'Listen' || label === 'Try again' ? ' to this message' : ''}`}
        aria-busy={loading}
        onClick={onClick}
        className={cn(
          'inline-flex min-h-11 items-center gap-1.5 rounded-pill px-2.5 font-sans text-xs text-text-2',
          'hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]',
        )}
      >
        {loading ? (
          <span
            aria-hidden="true"
            className="size-3.5 rounded-full border-2 border-line border-t-text-2 motion-safe:animate-spin"
          />
        ) : playing ? (
          <IconPause width={14} height={14} />
        ) : (
          <IconPlay width={14} height={14} />
        )}
        <span>{shown}</span>
      </button>
      {(failed && (view.message || dockFailed)) || view.note || (view.hint && !playing) ? (
        <p
          data-testid="speak-status"
          role={failed ? 'alert' : 'status'}
          className={cn('m-0 w-full font-sans text-sm', failed ? 'text-danger' : 'text-text-2')}
        >
          {failed
            ? (view.message ?? "The audio couldn't be played. Tap to make it again.")
            : [view.note, playing ? undefined : view.hint].filter(Boolean).join(' ')}
        </p>
      ) : null}
    </>
  )
}
