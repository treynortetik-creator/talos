// Settings → Thread sessions (docs/OPTION-C.md 9.2, 9.4): the master switch (off by default) and one row per thread that
// has its own session, parked ones included.
import {
  type AgentConfigT,
  applyMergePatch,
  DedicatedConfigStrict,
  dedicatedPatchIssue,
  dedicatedSettings,
  trustOn,
} from '@talos-app/protocol'
import { useId, useState } from 'react'
import { Link } from 'react-router'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { Input, Switch } from '../../ui/index.ts'
import type { SettingsSectionProps } from '../contracts.ts'
import { friendlyPatchError } from '../threads/manage/useThreadPatch.ts'
import { useThreadSessionsSupported, useWorkersStatus, workerLine } from './store.ts'

export function ThreadSessionsSection({ readOnly }: SettingsSectionProps) {
  const client = useTalosClient()
  const config = useTalos((s) => s.config)
  const threads = useTalos((s) => s.threads)
  const status = useWorkersStatus()
  const supported = useThreadSessionsSupported(status)
  const [err, setErr] = useState<string | null>(null)
  const enabled = config ? dedicatedSettings(config).enabled : false
  const toggle = async (v: boolean) => {
    setErr(null)
    try {
      await client.patchConfig({ dedicated: { enabled: v } })
    } catch (e) {
      setErr(friendlyPatchError(e))
    }
  }
  const g = status?.governor
  // With trust mode on, the "limits are close" band only warns; sessions still start until the park-all mark
  const warnOnly = g?.state === 'paused' && config !== undefined && trustOn(config)
  const paused = g?.state === 'paused' || g?.state === 'park_all'
  return (
    <section aria-labelledby="thread-sessions-h" className="flex flex-col gap-3" data-testid="thread-sessions">
      <h2 id="thread-sessions-h" className="m-0 font-display text-xl font-semibold">
        Thread sessions
      </h2>
      {!status && <p className="m-0 text-text-2">Your Mac needs a newer Talos for thread sessions.</p>}
      {/* turning it off is never refused, so the switch stays reachable on a Mac that no longer reports a status */}
      {(status || enabled) && (
        <div className="flex min-h-11 items-center justify-between gap-3">
          <label htmlFor="thread-sessions-on" className="text-sm font-medium">
            Allow threads to have their own session
          </label>
          <Switch
            id="thread-sessions-on"
            checked={enabled}
            disabled={readOnly || (!supported && !enabled)}
            onCheckedChange={(v) => void toggle(v)}
          />
        </div>
      )}
      {status && (
        <>
          <p className="m-0 text-sm text-text-2">
            {supported
              ? 'Then turn on Own session in a thread’s settings. Everything else stays with the main session.'
              : 'Your Mac app isn’t running thread sessions. Main answers every thread.'}
          </p>
          {paused && (
            <p className="m-0 text-sm" role="status" data-testid="thread-sessions-paused">
              {warnOnly
                ? 'Limits are close: thread sessions still start, but may run out sooner'
                : 'Saving limits: thread sessions paused'}
              {g?.resets_at
                ? `${warnOnly ? ', until' : ' until'} ${new Date(g.resets_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
                : ''}
              {warnOnly ? '.' : '. Main keeps answering.'}
            </p>
          )}
          <Limits readOnly={readOnly} />
          {status.threads.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="thread-session-rows">
              {status.threads.map((w) => {
                const t = threads.find((x) => x.id === w.thread_id)
                return (
                  <li key={w.thread_id} className="flex min-h-11 items-center justify-between gap-2 text-sm">
                    <Link to={`/t/${w.thread_id}`} className="font-medium">
                      {t?.name ?? w.thread_id}
                    </Link>
                    <span className="text-text-2">
                      {workerLine(w)}
                      {w.model && w.model !== 'inherit' ? ` · ${w.model}` : ''}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
      {err && (
        <p role="alert" className="m-0 text-sm text-danger">
          {err}
        </p>
      )}
    </section>
  )
}

type LimitKey = 'max_live' | 'five_hour' | 'weekly' | 'park_all'
const LIMITS: Array<{ key: LimitKey; label: string; hint: string; min: number; max: number }> = [
  {
    key: 'max_live',
    label: 'Sessions running at once',
    hint: 'From 1 to 6. More use more of your plan.',
    min: 1,
    max: 6,
  },
  {
    key: 'five_hour',
    label: 'Stop starting new sessions at (5-hour usage, %)',
    hint: 'From 1 to 100.',
    min: 1,
    max: 100,
  },
  { key: 'weekly', label: 'Stop starting new sessions at (weekly usage, %)', hint: 'From 1 to 100.', min: 1, max: 100 },
  {
    key: 'park_all',
    label: 'Park every session at (usage, %)',
    hint: 'From 1 to 100. Each parks after its current turn.',
    min: 1,
    max: 100,
  },
]

const limitValue = (c: ReturnType<typeof dedicatedSettings>, k: LimitKey): number =>
  k === 'max_live' ? c.max_live : c.governor[k]
const patchFor = (k: LimitKey, n: number) =>
  k === 'max_live' ? { dedicated: { max_live: n } } : { dedicated: { governor: { [k]: n } } }

/**
 * The worker cap and the usage limits (`dedicated.max_live`, `dedicated.governor`). Each saves at once. The value is checked
 * here with the same schema and rule the Mac uses (DedicatedConfigStrict, dedicatedPatchIssue) before anything is sent, and
 * whatever the Mac still refuses shows in its own words with the box back on the saved number.
 */
function Limits({ readOnly }: { readOnly: boolean }) {
  const client = useTalosClient()
  const config = useTalos((s) => s.config)
  const [typed, setTyped] = useState<Partial<Record<LimitKey, string>>>({})
  const [err, setErr] = useState<string | null>(null)
  const idBase = useId()
  const offId = useId()
  if (!config) return null
  const cur = dedicatedSettings(config)
  const clear = (k: LimitKey) => setTyped(({ [k]: _x, ...rest }) => rest)

  const send = async (patch: Record<string, unknown>) => {
    setErr(null)
    const after = applyMergePatch(config, patch) as AgentConfigT
    const shape = DedicatedConfigStrict.safeParse(after.dedicated)
    if (!shape.success) return setErr('That value is out of range.')
    const issue = dedicatedPatchIssue(config, after)
    if (issue) return setErr(issue)
    try {
      await client.patchConfig(patch)
    } catch (e) {
      setErr(friendlyPatchError(e))
    }
  }
  const commit = async (l: (typeof LIMITS)[number]) => {
    const raw = typed[l.key]
    if (raw === undefined) return
    const n = Number(raw)
    if (
      raw.trim() === '' ||
      !Number.isFinite(n) ||
      n < l.min ||
      n > l.max ||
      (l.key === 'max_live' && !Number.isInteger(n))
    ) {
      setErr(`${l.label}: use ${l.key === 'max_live' ? 'a whole number' : 'a number'} from ${l.min} to ${l.max}.`)
      return clear(l.key)
    }
    if (n === limitValue(cur, l.key)) return clear(l.key)
    await send(patchFor(l.key, n))
    clear(l.key)
  }
  return (
    <div className="flex flex-col gap-2" data-testid="session-limits">
      <h3 className="m-0 text-base font-medium">Limits</h3>
      {LIMITS.map((l) => {
        const id = `${idBase}-${l.key}`
        return (
          <div key={l.key} className="flex flex-col gap-1 text-sm">
            <label htmlFor={id}>{l.label}</label>
            <Input
              id={id}
              type="number"
              inputMode="numeric"
              min={l.min}
              max={l.max}
              disabled={readOnly || (l.key !== 'max_live' && cur.governor.off)}
              value={typed[l.key] ?? String(limitValue(cur, l.key))}
              onChange={(e) => setTyped((t) => ({ ...t, [l.key]: e.target.value }))}
              onBlur={() => void commit(l)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit(l)
              }}
            />
            <span className="text-xs text-text-2">{l.hint}</span>
          </div>
        )
      })}
      <div className="flex min-h-11 items-center justify-between gap-3">
        <label htmlFor={offId} className="text-sm">
          Ignore my usage limits
          <span className="block text-xs text-text-2">Sessions then start and run whatever the usage says.</span>
        </label>
        <Switch
          id={offId}
          checked={cur.governor.off}
          disabled={readOnly}
          onCheckedChange={(v) => void send({ dedicated: { governor: { off: v } } })}
        />
      </div>
      {err && (
        <p role="alert" className="m-0 text-sm text-danger" data-testid="limits-error">
          {err}
        </p>
      )}
    </div>
  )
}
