// The pinned Heartbeat section of the Schedules list: one row with the last outcome in words and colour, the next check,
// and the pause switch. A failure never reads as "Nothing new" (outcomeOfRun). With the Mac offline the row stays, from the
// cache, and its switch is off the table.
import type { ScheduleT } from '@talos-app/protocol'
import { useState } from 'react'
import { Link } from 'react-router'
import { useTalos, useTalosClient } from '../../../lib/client.ts'
import { cn } from '../../../ui/cn.ts'
import { Switch } from '../../../ui/index.ts'
import { CAPS, refusalWords, TONE, useSchedTime } from '../shared.tsx'
import { heartbeatView, rowOutcome } from './logic.ts'

function HeartbeatRow({ s, onNotice }: { s: ScheduleT; onNotice: (t: string) => void }) {
  const client = useTalosClient()
  const snap = useTalos((st) => st.schedules.snapshot)
  const t = useSchedTime(snap?.health ?? null)
  const [busy, setBusy] = useState(false)
  const view = heartbeatView(s)
  const pausedAll = snap?.health.paused_all ?? false
  const o =
    view?.kind === 'problem'
      ? { key: 'failed', word: "Can't be read", tone: 'danger' as const }
      : rowOutcome(s, pausedAll)
  const cap = view?.kind === 'config' ? view.config.wake_cap_per_day : null
  const sub = [
    s.when_text,
    s.enabled && !s.paused && !pausedAll && s.next_run ? `next ${t.when(s.next_run)}` : null,
    cap !== null ? `up to ${cap} ${cap === 1 ? 'wake' : 'wakes'} a day` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const canPause = s.enabled && !pausedAll && s.today !== 'held' && t.macOnline
  const toggle = async () => {
    setBusy(true)
    try {
      await client.schedules.controlSchedule(s.paused ? 'resume' : 'pause', s.id)
    } catch (e) {
      onNotice(refusalWords(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="flex min-h-16 items-center gap-3 px-4 py-2" data-testid="heartbeat-row">
      <Link
        to={`/schedules/${s.id}`}
        className="min-w-0 flex-1 rounded-button py-1 transition-colors duration-[var(--dur-1)] ease-talos hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
      >
        <span className="block truncate text-[1.0625rem] font-medium">
          <span aria-hidden="true">♥ </span>
          {s.name}
        </span>
        <span
          className={cn('block text-sm font-medium', TONE[o.tone])}
          data-testid="heartbeat-outcome"
          data-outcome={o.key}
        >
          {o.word}
          {s.last_run?.started_at && o.key !== 'none' && s.enabled && !s.paused ? (
            <span className="font-mono text-xs text-text-2"> · {t.time(s.last_run.started_at)}</span>
          ) : null}
        </span>
        <span className="line-clamp-2 text-sm text-text-2">{sub}</span>
      </Link>
      {s.enabled && !pausedAll ? (
        <Switch
          aria-label={`${s.name} runs on schedule`}
          checked={!s.paused}
          disabled={busy || !canPause}
          onCheckedChange={() => void toggle()}
        />
      ) : null}
    </li>
  )
}

export function HeartbeatSection({ rows, onNotice }: { rows: ScheduleT[]; onNotice: (t: string) => void }) {
  if (rows.length === 0) return null
  return (
    <section data-group="heartbeat" aria-labelledby="sg-heartbeat">
      <h2 id="sg-heartbeat" className={cn(CAPS, 'px-4 pt-4 pb-1 text-text-2')}>
        Heartbeat
      </h2>
      <ul className="m-0 list-none divide-y divide-line p-0">
        {rows.map((s) => (
          <HeartbeatRow key={s.id} s={s} onNotice={onNotice} />
        ))}
      </ul>
    </section>
  )
}
