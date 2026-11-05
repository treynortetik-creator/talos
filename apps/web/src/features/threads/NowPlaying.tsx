// The now-playing pill (audit D37): a small floating player under the phone header, shown only while the dock has a clip
// loaded. Play/pause, the title, and a tap on the title goes back to the thread it came from. It floats instead of docking so
// the shell's layout does not change; a docked bar can move into Shell later.
import { useNavigate } from 'react-router'
import { cn } from '../../ui/cn.ts'
import { IconClose, IconPause, IconPlay } from '../../ui/icons.tsx'
import { audioDock, useDock } from './audioDock.ts'

export function NowPlaying() {
  const nav = useNavigate()
  const item = useDock((s) => s.item)
  const playing = useDock((s) => s.playing)
  const failed = useDock((s) => s.failed)
  if (!item) return null
  const threadId = item.threadId
  return (
    <section
      aria-label="Now playing"
      data-testid="now-playing"
      className="fixed left-1/2 z-40 flex w-[min(92vw,22rem)] -translate-x-1/2 items-center gap-1 rounded-pill border border-line bg-surface py-1 pl-1 pr-1 shadow-lg"
      // Under the phone header: safe area + its 2.75rem + a small gap.
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 2.75rem + 0.5rem)' }}
    >
      <button
        type="button"
        aria-label={playing ? 'Pause' : 'Play'}
        disabled={failed}
        onClick={() => audioDock.toggle()}
        className="grid size-11 shrink-0 place-items-center rounded-pill bg-accent text-on-accent disabled:opacity-50"
      >
        {playing ? <IconPause /> : <IconPlay />}
      </button>
      <button
        type="button"
        data-testid="now-playing-open"
        aria-label={threadId ? `Back to the thread: ${item.title}` : item.title}
        disabled={!threadId}
        onClick={() => threadId && nav(`/t/${threadId}`)}
        className={cn('min-h-11 min-w-0 flex-1 truncate px-2 text-left text-sm', failed && 'text-text-2')}
      >
        {failed ? (
          <span role="alert" data-testid="now-playing-failed">
            Couldn't play {item.title}
          </span>
        ) : (
          item.title
        )}
      </button>
      <button
        type="button"
        aria-label="Stop playback"
        onClick={() => audioDock.stop()}
        className="grid size-11 shrink-0 place-items-center rounded-pill text-text-2"
      >
        <IconClose />
      </button>
    </section>
  )
}
