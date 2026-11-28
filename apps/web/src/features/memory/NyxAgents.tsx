// "Add Nyx to agents": one row per agent (Main, then each live thread's own agent). A STUB: the boxes are off and say so. The real
// write (adding Nyx to an agent's own Claude setup) is bridge work; docs/FOLLOWUPS.md names it.
import { useId } from 'react'
import { useTalos } from '../../lib/client.ts'
import { NYX_TEXT } from './nyxText.ts'

export type AgentRow = { id: string; name: string }

/** Main first, then every thread that is not archived, not the system inbox and not the thread Main already speaks in. */
export function agentRows(
  threads: ReadonlyArray<{ id: string; name: string; kind: string; archived?: boolean }>,
  defaultThread: string | undefined,
): AgentRow[] {
  return [
    { id: 'main', name: NYX_TEXT.mainAgent },
    ...threads
      .filter((t) => !t.archived && t.kind !== 'system' && t.id !== defaultThread)
      .map((t) => ({ id: t.id, name: t.name })),
  ]
}

export function NyxAgents() {
  const threads = useTalos((s) => s.threads)
  const defaultThread = useTalos((s) => s.config?.default_thread)
  const heading = useId()
  const soon = useId()
  const rows = agentRows(threads, defaultThread)
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2" data-testid="nyx-agents">
      <h2 id={heading} className="m-0 text-base font-semibold">
        {NYX_TEXT.agentsTitle}
      </h2>
      <p id={soon} className="m-0 text-sm text-text-2" data-testid="nyx-agents-soon">
        {NYX_TEXT.agentsSoon}
      </p>
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map((a) => (
          <li key={a.id} className="border-b border-line/60 last:border-b-0">
            <label className="flex min-h-11 items-center gap-3 text-text-2">
              <input
                type="checkbox"
                disabled
                checked={false}
                readOnly
                aria-describedby={soon}
                data-testid={`nyx-agent-${a.id}`}
                className="size-5"
              />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  )
}
