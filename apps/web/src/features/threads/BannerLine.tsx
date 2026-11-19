// The state banners as one compact line (owner: maximum room for the conversation on a phone). The first notice shows its
// cause on a single truncated line, its action (Retry, Health) at the right, and a More button once there is anything else
// to read. More opens every notice in full: cause, next step, action. A notice's test id sits in the page once: on the line
// while it is shut, on its full block once it is open.

import { type ReactNode, useId, useState } from 'react'
import { IconClock } from '../../ui/icons.tsx'
import { Button } from '../../ui/index.ts'
import { Mascot } from '../../ui/Mascot.tsx'

export type BannerEntry = {
  key: string
  testId?: string
  kind?: string
  icon: 'worried' | 'clock'
  /** What is wrong, in one sentence: it is the whole line while the banner is shut. */
  cause: ReactNode
  /** The next step, instructions or countdown: only in the open view. */
  detail?: ReactNode
  /** Retry, Retry now, Health: stays on the line for the first notice. */
  action?: ReactNode
}

const ICON = 18

function EntryIcon({ icon, size }: { icon: BannerEntry['icon']; size: number }) {
  return icon === 'clock' ? (
    <IconClock width={ICON} height={ICON} className="shrink-0 text-text-2" />
  ) : (
    <Mascot state="worried" size={size} decorative animate={false} />
  )
}

function FullBlock({ entry }: { entry: BannerEntry }) {
  return (
    <div
      role="status"
      data-testid={entry.testId}
      data-kind={entry.kind}
      className="flex items-start gap-3 px-4 py-2.5 text-sm"
    >
      <span className="mt-0.5 shrink-0">
        <EntryIcon icon={entry.icon} size={28} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span>{entry.cause}</span>
        {entry.detail ? <span className="text-text-2">{entry.detail}</span> : null}
      </div>
      {entry.action ? <span className="shrink-0">{entry.action}</span> : null}
    </div>
  )
}

export function BannerLine({ entries }: { entries: BannerEntry[] }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const first = entries[0]
  if (!first) return null
  const canOpen = entries.length > 1 || entries.some((e) => e.detail)
  const shown = open && canOpen
  const label = shown ? 'Less' : entries.length > 1 ? `More (${entries.length})` : 'More'
  // one row, always the same elements in the same order (keyed), so the toggle keeps focus when it flips
  return (
    <div className="border-b border-line bg-surface-2">
      <div
        role="status"
        data-testid={shown ? undefined : first.testId}
        data-kind={shown ? undefined : first.kind}
        className="flex min-h-11 items-center gap-2 px-4 text-sm"
      >
        {shown ? (
          <span key="head" className="min-w-0 flex-1 truncate font-semibold">
            {entries.length > 1 ? `${entries.length} notices` : 'Notice'}
          </span>
        ) : (
          [
            <span key="icon" className="flex shrink-0">
              <EntryIcon icon={first.icon} size={ICON} />
            </span>,
            <span key="cause" className="min-w-0 flex-1 truncate">
              {first.cause}
            </span>,
            first.action ? (
              <span key="action" className="shrink-0">
                {first.action}
              </span>
            ) : null,
          ]
        )}
        {canOpen ? (
          <Button
            key="toggle"
            variant="ghost"
            className="shrink-0 px-2 underline"
            aria-expanded={shown}
            aria-controls={panelId}
            onClick={() => setOpen(!shown)}
          >
            {label}
          </Button>
        ) : null}
      </div>
      {shown ? (
        <div id={panelId} className="flex flex-col divide-y divide-line border-t border-line">
          {entries.map((e) => (
            <FullBlock key={e.key} entry={e} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
