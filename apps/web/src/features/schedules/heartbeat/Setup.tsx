// Heartbeat setup (docs/HEARTBEAT.md "Set up"): a form that builds a talos.heartbeat config and the job around it. Nothing is
// saved by it. [Test run] opens the test sheet; [Turn on] is enabled only by a passing test of exactly this config, and then
// goes through the ordinary schedule card (`schedule.patch` -> approval card), never a direct write.
import { HEARTBEAT_FEATURE, heartbeatConfigHashOf, ScheduleChange } from '@talos-app/protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useTalos } from '../../../lib/client.ts'
import { IconBack } from '../../../ui/icons.tsx'
import { Button, Input } from '../../../ui/index.ts'
import { ScrollRegion } from '../../../ui/ScrollRegion.tsx'
import { NewThread } from '../../threads/ThreadSettings.tsx'
import { slug } from '../logic.ts'
import { ProposalSheet } from '../Proposal.tsx'
import { CAPS, FIELD, Field } from '../shared.tsx'
import { blankSetup, CADENCES, configFromSetup, draftFromSetup, eligibleThreads, type SetupForm } from './logic.ts'
import { TestSheet } from './TestSheet.tsx'

export function HeartbeatSetupScreen() {
  const nav = useNavigate()
  const config = useTalos((s) => s.config)
  const features = useTalos((s) => s.presence.features)
  const relayFeatures = useTalos((s) => s.relayFeatures)
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const snap = useTalos((s) => s.schedules.snapshot)
  const quiet = useTalos((s) => s.config?.quiet_window ?? null)
  // a heartbeat posts to a thread of its own: never General, the default, inbox, or one another job already uses
  const used = useMemo(() => (snap?.schedules ?? []).flatMap((x) => (x.thread_id ? [x.thread_id] : [])), [snap])
  const threads = useMemo(() => (config ? eligibleThreads(config, used) : []), [config, used])
  const [pick, setPick] = useState<SetupForm>(() => {
    const own = threads.find((t) => t.name.toLowerCase() === 'heartbeat')
    return { ...blankSetup(), threadId: own?.id ?? null }
  })
  // a thread that stopped being eligible (another job took it) counts as not picked
  const f = useMemo(
    () => ({ ...pick, threadId: threads.some((t) => t.id === pick.threadId) ? pick.threadId : null }),
    [pick, threads],
  )
  const setF = setPick
  const formRef = useRef<HTMLFormElement>(null)
  const [submits, setSubmits] = useState(0)
  const [checked, setChecked] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  const [propose, setPropose] = useState<ReturnType<typeof ScheduleChange.parse> | null>(null)
  const up = <K extends keyof SetupForm>(k: K, v: SetupForm[K]) => setF((x) => ({ ...x, [k]: v }))

  const built = useMemo(() => configFromSetup(f), [f])
  const errors = built.ok ? {} : built.errors
  const hash = built.ok ? heartbeatConfigHashOf(built.config) : null
  const canTest = (features ?? []).includes(HEARTBEAT_FEATURE) && (relayFeatures ?? []).includes(HEARTBEAT_FEATURE)
  const shown = (k: string) => (checked ? errors[k] : undefined)

  // after a failed submit, focus and scroll to the first field that has an error (a phone shows one screenful at a time)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per failed submit
  useEffect(() => {
    if (submits === 0) return
    const first = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-first-error]')
    first?.focus()
    first?.scrollIntoView({ block: 'center' })
  }, [submits])

  const turnOn = () => {
    if (!built.ok) return
    const taken = new Set(snap?.schedules.map((x) => x.id) ?? [])
    const draft = draftFromSetup(f, built.config, built.times, slug('heartbeat', taken))
    const change = ScheduleChange.safeParse({ op: 'create', draft })
    if (!change.success) return
    setTestOpen(false)
    setPropose(change.data)
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="heartbeat-setup">
      <div className="top-band">
        <header className="flex items-center gap-2 px-2 pt-[max(1rem,env(safe-area-inset-top))] pb-3">
          <button
            type="button"
            aria-label="Back"
            onClick={() => nav('/schedules')}
            className="grid size-11 place-items-center rounded-pill hover:bg-surface-2"
          >
            <IconBack />
          </button>
          <h1 className="m-0 flex-1 font-display text-xl font-semibold">Set up Heartbeat</h1>
        </header>
      </div>
      <ScrollRegion label="Heartbeat setup" className="min-h-0 flex-1 overflow-y-auto">
        <form
          className="space-y-4 p-4"
          noValidate
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault()
            setChecked(true)
            if (built.ok && canTest) setTestOpen(true)
            else setSubmits((n) => n + 1)
          }}
        >
          <p className="m-0 text-sm text-text-2">
            Checks your sources a few times a day and tells you only what needs you. It starts in shadow: it records and
            reports, and never wakes the agent.
          </p>
          {!canTest ? (
            <p role="status" data-testid="hb-needs-update" className="m-0 text-sm text-warn">
              Update Talos on your Mac and your relay to test and turn on a heartbeat.
            </p>
          ) : null}

          <Field label="How often" error={shown('every')}>
            {(a) => (
              <select
                {...a}
                className={FIELD}
                value={f.every}
                onChange={(e) => up('every', e.target.value as SetupForm['every'])}
              >
                {CADENCES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="First check" error={shown('first')}>
              {(a) => (
                <Input {...a} value={f.first} inputMode="numeric" onChange={(e) => up('first', e.target.value)} />
              )}
            </Field>
            <Field label="Last check" error={shown('last')}>
              {(a) => <Input {...a} value={f.last} inputMode="numeric" onChange={(e) => up('last', e.target.value)} />}
            </Field>
          </div>
          <Field label="Days">
            {(a) => (
              <select
                {...a}
                className={FIELD}
                value={f.days}
                onChange={(e) => up('days', e.target.value as SetupForm['days'])}
              >
                <option value="weekdays">Weekdays</option>
                <option value="daily">Every day</option>
              </select>
            )}
          </Field>
          <p className="m-0 text-sm text-text-2" data-testid="hb-quiet">
            {quiet ? (
              `Quiet hours ${quiet.start} to ${quiet.end}: no checks run then.`
            ) : (
              <>
                Quiet hours are not set.{' '}
                <Link className="underline" to="/settings">
                  Set them in Settings
                </Link>
                .
              </>
            )}
          </p>

          <fieldset className="m-0 space-y-2 border-0 p-0">
            <legend className={`${CAPS} mb-1 text-text-2`}>Sources</legend>
            <label className="flex min-h-11 items-center gap-2 text-md">
              <input type="checkbox" checked={f.failures} onChange={(e) => up('failures', e.target.checked)} /> Failed
              scheduled jobs
            </label>
            <label className="flex min-h-11 items-center gap-2 text-md">
              <input type="checkbox" checked={f.inbox} onChange={(e) => up('inbox', e.target.checked)} /> Inbox
            </label>
            <label className="flex min-h-11 items-center gap-2 text-md">
              <input type="checkbox" checked={f.github} onChange={(e) => up('github', e.target.checked)} /> GitHub
            </label>
            {f.github ? (
              <Field label="Repos" hint="owner/name, separated by spaces or commas." error={shown('repos')}>
                {(a) => <Input {...a} value={f.repos} onChange={(e) => up('repos', e.target.value)} />}
              </Field>
            ) : null}
            <p className="m-0 min-h-11 py-2 text-sm text-text-2">Slack: Not set up</p>
            {shown('sources') ? (
              <p
                role="alert"
                tabIndex={-1}
                data-first-error
                data-testid="hb-sources-error"
                className="m-0 text-sm text-danger focus-visible:outline-2 focus-visible:outline-focus"
              >
                {shown('sources')}
              </p>
            ) : null}
          </fieldset>

          <Field label="Most wakes a day" error={shown('wakes')}>
            {(a) => <Input {...a} value={f.wakes} inputMode="numeric" onChange={(e) => up('wakes', e.target.value)} />}
          </Field>

          <Field
            label="Thread"
            hint="A heartbeat posts to a thread of its own. General, your default thread and threads another job uses are not offered."
            error={shown('thread')}
          >
            {(a) => (
              <select
                {...a}
                className={FIELD}
                value={f.threadId ?? ''}
                onChange={(e) => up('threadId', e.target.value || null)}
              >
                <option value="">Pick a thread</option>
                {threads.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <NewThread defaultName="Heartbeat" onCreated={(id) => up('threadId', id)} />

          {shown('form') ? (
            <p role="alert" className="m-0 text-sm text-danger">
              {shown('form')}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={!macOnline}>
              Test run
            </Button>
            <Button variant="ghost" type="button" onClick={() => nav('/schedules')}>
              Cancel
            </Button>
          </div>
        </form>
      </ScrollRegion>
      {testOpen && built.ok && hash ? (
        <TestSheet config={built.config} hash={hash} onClose={() => setTestOpen(false)} onTurnOn={turnOn} />
      ) : null}
      {propose ? (
        <ProposalSheet
          title="Turn on Heartbeat"
          change={propose}
          threadId={f.threadId ?? ''}
          onClose={() => {
            setPropose(null)
          }}
        />
      ) : null}
    </div>
  )
}
