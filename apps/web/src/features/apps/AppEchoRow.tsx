// What a view said to the agent through `ui/message` (M2.6): a quiet, plain-text row. It is third-party text, so it is
// never markdown, never styled as the owner's voice, and it carries the "Third-party app" badge.
import type { MessageT } from '@talos-app/protocol'
import { ownValue } from '@talos-app/protocol'
import { useTalos } from '../../lib/client.ts'
import { clockTime } from '../../lib/format.ts'
import { useAgentName } from '../threads/useThreads.ts'

export function AppEchoRow({ message: m }: { message: MessageT }) {
  const agent = useAgentName()
  const label = useTalos(
    (s) => (ownValue(s.messages, m.thread_id) ?? []).find((x) => x.app && x.app.view_id === m.app_view_id)?.app?.label,
  )
  return (
    <article
      className="flex justify-start px-4 py-1"
      data-testid="app-echo"
      data-msg-id={m.id}
      aria-label={`${label ?? 'An app'} sent to ${agent}`}
    >
      <div className="min-w-0 max-w-[85%] text-sm text-text-2 md:max-w-[75%]">
        <p className="m-0 flex flex-wrap items-center gap-x-2 [overflow-wrap:anywhere]">
          <span>
            ↳ {label ?? 'An app'} sent to {agent}:
          </span>
          <span className="rounded-pill border border-line px-2 text-xs">Third-party app</span>
        </p>
        <p className="m-0 mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{m.text}</p>
        <time className="mt-0.5 block font-mono text-xs" dateTime={m.created_at}>
          {clockTime(m.created_at)}
        </time>
      </div>
    </article>
  )
}
