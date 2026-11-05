// The live permission card (docs/CLAUDE-CODE.md C3.2). Claude Code asked to run a tool; the bridge turned the request into
// this card. The raw call comes FIRST, in a monospace box that scrolls and is never clamped or cut; Claude's own summary
// comes after it, because the model wrote that and the call is the evidence. Allow exists only when the card shows the
// whole bound call and nothing warns (permissionCardAllowsPrimary, the same function the bridge re-checks); otherwise only
// Deny, with the reason. Everything is plain text. There is no Edit and no revise: you answer the question or you don't.
import {
  type CardT,
  PERMISSION_HIDDEN_WARNING,
  PERMISSION_MAYBE_ANSWERED,
  PERMISSION_MAYBE_ANSWERED_MS,
  permissionCardAllowsPrimary,
} from '@talos-app/protocol'
import type { ReactNode, Ref } from 'react'
import { cn } from '../../ui/cn.ts'
import { IconAlert } from '../../ui/icons.tsx'
import { Button } from '../../ui/index.ts'
import { formatClock, revealHidden } from './util.ts'

export function PermissionCardLive({
  card,
  header,
  titleId,
  rootRef,
  pulse,
  hash,
  now,
  busy,
  error,
  timeZone,
  onAllow,
  onDeny,
}: {
  card: CardT
  header: ReactNode
  titleId: string
  rootRef: Ref<HTMLElement>
  pulse: boolean
  hash: string
  now: number
  busy: boolean
  error: string | null
  timeZone: string
  onAllow: () => void
  onDeny: () => void
}) {
  const canAllow = permissionCardAllowsPrimary(card)
  const summary = card.fields.find((f) => f.key === 'summary')
  const maybeAnswered = now - Date.parse(card.created_at) >= PERMISSION_MAYBE_ANSWERED_MS
  const reason = card.warning ?? (canAllow ? null : PERMISSION_HIDDEN_WARNING)
  return (
    <article
      ref={rootRef}
      aria-labelledby={titleId}
      data-card-id={card.id}
      data-card-state="pending"
      data-card-kind="permission"
      data-payload-hash={hash}
      className={cn(
        'incised rounded-card border border-warn bg-surface p-4 transition-shadow duration-[var(--dur-2)] ease-talos',
        pulse && 'ring-2 ring-accent',
      )}
    >
      {header}
      <h3 id={titleId} className="mt-1 text-lg font-medium text-text">
        {revealHidden(card.title)}
      </h3>
      <p className="mt-2 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">The call</p>
      <pre
        data-testid="permission-call"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll box must be reachable by keyboard
        tabIndex={0}
        className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-button bg-surface-2 p-2 font-mono text-sm text-text"
      >
        {revealHidden(card.body ?? '')}
      </pre>
      {summary ? (
        <div data-testid="permission-summary" className="mt-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">{summary.label}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-text">{revealHidden(summary.value)}</p>
        </div>
      ) : null}
      {reason ? (
        <p role="status" className="mt-3 flex items-start gap-1.5 text-sm text-warn">
          <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
          {revealHidden(reason)}
        </p>
      ) : null}
      {maybeAnswered ? <p className="mt-2 text-sm text-text-2">{PERMISSION_MAYBE_ANSWERED}</p> : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="danger" disabled={busy} onClick={onDeny}>
          {card.kill_label}
        </Button>
        {canAllow ? (
          <Button className="ml-auto" disabled={busy} onClick={onAllow}>
            {card.primary_label}
            {card.risk === 'high' ? <span className="sr-only"> (asks you to confirm with Face ID)</span> : null}
          </Button>
        ) : null}
      </div>
      <p className="mt-2 font-mono text-xs text-text-2" data-testid="card-expiry">
        Expires {formatClock(card.expires_at, timeZone)} if untouched
      </p>
    </article>
  )
}
