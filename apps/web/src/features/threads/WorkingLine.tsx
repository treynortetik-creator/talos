// Option B (the owner, 2026-11-20): while the agent works, a line at the very end of the thread, inside its scroll area:
// a dot, "<agent> is working…", and Stop as a pill. It replaced the red-ring square in the message box, which the owner read as
// "stop recording". It scrolls with the thread and Timeline keeps the view at the end when it comes and goes (footer slot).
// This is the live status for screen readers (role="status" on the text only, so "Stopping…" is not read again); the thin bar
// above the message box (WorkingRow) is silent.
import { useTalosClient } from '../../lib/client.ts'
import { offerStopError, offerStopped } from './StoppedStrip.tsx'
import { useAgentName } from './useThreads.ts'
import { useThreadState, useWorkingStop } from './WorkingRow.tsx'

export function WorkingLineView(p: {
  agent: string
  /** Stop can be offered (the same rule as the Session panel's Stop). Without it the line is the text alone. */
  showStop: boolean
  /** A stop request is in flight. */
  busy: boolean
  /** `hadFocus`: the keyboard was on Stop, which goes with the turn, so focus has to be put somewhere. */
  onStop: (hadFocus: boolean) => void
}) {
  return (
    // overflow-anchor: none: the line coming or going is never the browser's scroll anchor, so an owner scrolled up stays put
    // (macOS 26 WebKit moved the view 22 px on its coming, under load, with no script write).
    <div data-testid="stop-line" className="flex items-center gap-3 px-4 py-1 [overflow-anchor:none]">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-pill bg-accent motion-safe:animate-pulse" />
      <span role="status" className="min-w-0 flex-1 text-sm text-text-2">
        {p.agent} is working…
      </span>
      {p.showStop && (
        <button
          type="button"
          aria-label={p.busy ? 'Stopping your agent' : 'Stop your agent'}
          data-testid="stop-line-button"
          disabled={p.busy}
          // a tap must not pull focus off the message box (the on-screen keyboard stays up)
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => p.onStop(document.activeElement === e.currentTarget)}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-pill border border-accent-text bg-transparent px-4 text-sm font-semibold text-accent-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50"
        >
          {p.busy ? 'Stopping…' : 'Stop'}
        </button>
      )}
    </div>
  )
}

/** The footer of the thread's timeline: nothing unless this thread is working. The error goes to the strip above the box. */
export function WorkingLine({ threadId }: { threadId: string }) {
  const agent = useAgentName()
  const client = useTalosClient()
  const state = useThreadState(threadId)
  const w = useWorkingStop(threadId)
  if (state !== 'working') return null
  return (
    <WorkingLineView
      agent={agent}
      showStop={w.showStop}
      busy={w.busy}
      onStop={(focus) => {
        void w.stop().then((o) => {
          // a line that went with the turn must not take the strip with it, so this does not depend on the line being mounted
          if (o.kind === 'ok') offerStopped(client, threadId, { focus })
          else if (o.kind === 'error') offerStopError(threadId, o.text, { focus })
        })
      }}
    />
  )
}
