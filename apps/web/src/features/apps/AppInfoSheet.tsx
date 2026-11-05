// "App log" and "Details" from the overflow menu. Everything shown is data, rendered as text.
import type { AppViewT } from '@talos-app/protocol'
import { clockTime } from '../../lib/format.ts'
import { BoxSheet } from './BoxSheet.tsx'
import type { LogEntry } from './host.ts'

export type InfoKind = 'log' | 'details'

function List({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="mb-2">
      <dt className="text-xs text-text-2">{label}</dt>
      <dd className="m-0 font-mono text-sm [overflow-wrap:anywhere]">{items.length ? items.join('  ') : 'none'}</dd>
    </div>
  )
}

export function AppInfoSheet({
  kind,
  view,
  log,
  dropped,
  container,
  onClose,
}: {
  kind: InfoKind | null
  view: AppViewT
  log: LogEntry[]
  dropped: number
  container: HTMLElement | null
  onClose: () => void
}) {
  const c = view.csp
  return (
    <BoxSheet
      open={kind !== null}
      onOpenChange={(o) => !o && onClose()}
      container={container}
      title={kind === 'log' ? 'App log' : 'App details'}
      description={
        kind === 'log' ? 'What this app wrote to its log. Kept on this device only.' : 'What you approved for this app.'
      }
    >
      {kind === 'log' ? (
        <div data-testid="app-log">
          {log.length === 0 ? (
            <p className="m-0 text-sm text-text-2">Nothing logged.</p>
          ) : (
            <ol className="m-0 list-none p-0 font-mono text-xs">
              {log.map((e) => (
                <li key={e.n} className="border-b border-line py-1 [overflow-wrap:anywhere]">
                  <span className="text-text-2">{e.level}</span>{' '}
                  {e.logger ? <span className="text-text-2">{e.logger} </span> : null}
                  {e.text}
                </li>
              ))}
            </ol>
          )}
          {dropped > 0 && (
            <p className="m-0 mt-2 text-sm text-text-2">{dropped} more entries were dropped (too many).</p>
          )}
        </div>
      ) : kind === 'details' ? (
        <dl className="m-0" data-testid="app-details">
          <List label="Server" items={[view.server]} />
          <List label="Tool" items={[view.tool]} />
          <List label="Can connect to" items={c.connect_domains} />
          <List label="Loads files from" items={c.resource_domains} />
          <List label="Embeds" items={c.frame_domains} />
          <List label="Approval key" items={[view.approval_key.slice(0, 12)]} />
          <List label="Shown" items={[`${clockTime(view.shown_at)} (${view.shown_at})`]} />
          <List label="Buttons that need your agent work until" items={[view.calls_until]} />
        </dl>
      ) : null}
    </BoxSheet>
  )
}
