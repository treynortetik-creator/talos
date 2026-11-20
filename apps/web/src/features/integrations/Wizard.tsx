// The "Connect an app" wizard (spec 7.7): five screens, driven entirely by the catalog's SetupSpec.
//   1 Pick   2 What should reach you?   3 Connect (spec steps)   4 Test   5 Connected
import type { RouteRes } from '@talos-app/protocol'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { getPlatform } from '../../lib/platform.ts'
import { Button, Input } from '../../ui/index.ts'
import { copyText, useNow } from '../cards/util.ts'
import type { IntegrationWizardProps } from '../contracts.ts'
import { useWriteBlock } from '../settings/offline.ts'
import { scriptText, templateContext } from './adapters.ts'
import { ConnectionPanel } from './ConnectionPanel.tsx'
import { type Conn, type Spec, useCatalog } from './data.ts'
import { connName, filterLabel, type SlackIdentity, slackBot } from './slackBot.ts'
import { fillTemplate, MiniMd, safeUrl, withAgent } from './template.tsx'
import { useWorkGate, WorkEnableDialog } from './WorkEnable.tsx'

type Created = RouteRes<'connectionCreate'>
type SetupStep = Spec['connect'][number]
type Step = 1 | 2 | 3 | 4 | 5

const STEP_TITLES: Record<Step, string> = {
  1: 'Add a webhook',
  2: 'What should reach you?',
  3: 'Connect',
  4: 'Test',
  5: 'Connected',
}

/** How long the test screen waits before it shows what to check. */
export const TEST_WAIT_MS = 2 * 60 * 1000

export function IntegrationWizard({ integrationId, onDone }: IntegrationWizardProps) {
  const catalog = useCatalog()
  const specs = catalog.data ?? []
  const [picked, setPicked] = useState<string | undefined>(integrationId)
  const spec = specs.find((s) => s.id === picked)
  const [step, setStep] = useState<Step>(integrationId ? 2 : 1)
  // Slack only: the owner's messages or an agent's bot (chosen at the top of screen 2)
  const [identity, setIdentity] = useState<SlackIdentity>('owner')
  const bot = spec?.id === 'slack' && identity === 'bot'

  if (catalog.loading) return <p className="p-4 text-text-2">Loading…</p>
  if (catalog.error)
    return (
      <div className="space-y-2 p-4">
        <p role="alert" className="text-danger">
          Can't reach your server.
        </p>
        <Button variant="outline" onClick={catalog.reload}>
          Retry
        </Button>
      </div>
    )
  return (
    <section aria-label="Add a webhook" className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
      <header className="space-y-2">
        <h2 className="m-0 font-display text-xl font-semibold text-text">
          {bot && step === 2 ? slackBot.title : STEP_TITLES[step]}
        </h2>
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <span key={n} className={`h-1 w-6 rounded-pill ${n <= step ? 'bg-accent' : 'bg-line'}`} />
            ))}
          </span>
          <p className="m-0 text-sm text-text-2" data-testid="wizard-progress">
            Step {step} of 5
          </p>
        </div>
      </header>
      {step === 1 ? (
        <PickScreen
          specs={specs}
          onPick={(id) => {
            setPicked(id)
            setIdentity('owner')
            setStep(2)
          }}
        />
      ) : null}
      {step >= 2 && spec ? (
        <WizardBody
          key={spec.id}
          spec={spec}
          step={step}
          setStep={setStep}
          onDone={onDone}
          identity={spec.id === 'slack' ? identity : 'owner'}
          setIdentity={setIdentity}
        />
      ) : null}
    </section>
  )
}

// ---- screen 1 ---------------------------------------------------------------------------------------------------

export function PickScreen({ specs, onPick }: { specs: Spec[]; onPick: (id: string) => void }) {
  const agent = useTalos((s) => s.config?.agent.name ?? 'Talos')
  const gate = useWorkGate()
  const readOnly = useWriteBlock() !== null // not connected, or the Mac offline (settings/offline.ts)
  const [unlocking, setUnlocking] = useState<Spec | null>(null)
  const [turningOff, setTurningOff] = useState<Spec | null>(null)
  const personal = specs.filter((s) => s.category === 'personal')
  const work = specs.filter((s) => s.category === 'work')
  return (
    <div className="space-y-4">
      <p className="text-text-2">{agent} gets a note in your Inbox when something happens there.</p>
      <TileGroup title="Personal" specs={personal} onPick={onPick} gate={gate} onLocked={setUnlocking} />
      {work.length > 0 ? (
        <TileGroup
          title={gate.label}
          specs={work}
          onPick={onPick}
          gate={gate}
          onLocked={setUnlocking}
          onTurnOff={setTurningOff}
        />
      ) : null}
      <p className="text-sm text-text-2">
        Anything else that can send a webhook works too: pick <strong>Any app</strong>.
      </p>
      {unlocking ? <WorkEnableDialog spec={unlocking} readOnly={readOnly} onClose={() => setUnlocking(null)} /> : null}
      {turningOff ? (
        <WorkEnableDialog spec={turningOff} mode="disable" readOnly={readOnly} onClose={() => setTurningOff(null)} />
      ) : null}
    </div>
  )
}

export function TileGroup({
  title,
  specs,
  onPick,
  onLocked,
  onTurnOff,
  gate,
}: {
  title: string
  specs: Spec[]
  onPick: (id: string) => void
  onLocked: (s: Spec) => void
  /** Offered under a work tile that is switched on: opens the turn-off dialog. */
  onTurnOff?: (s: Spec) => void
  gate: ReturnType<typeof useWorkGate>
}) {
  return (
    <section aria-label={title}>
      <h3 className="mt-2 mb-2 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">{title}</h3>
      <ul className="grid gap-2 sm:grid-cols-2">
        {specs.map((s) => {
          const locked = !gate.isUnlocked(s)
          return (
            <li key={s.id}>
              <button
                type="button"
                data-tile={s.id}
                data-locked={locked}
                className="incised flex min-h-16 w-full flex-col items-start rounded-card bg-surface p-3.5 text-left transition-colors duration-[var(--dur-1)] ease-talos hover:bg-surface-2"
                onClick={() => (locked ? onLocked(s) : onPick(s.id))}
              >
                <span className="font-medium text-text">
                  {locked ? (
                    <>
                      <span aria-hidden>🔒 </span>
                      <span className="sr-only">Locked: </span>
                    </>
                  ) : null}
                  {s.name}
                </span>
                <span className="text-sm text-text-2">{locked ? gate.note : s.blurb}</span>
              </button>
              {!locked && s.category === 'work' && onTurnOff ? (
                <button
                  type="button"
                  data-turn-off={s.id}
                  className="mt-1 inline-flex min-h-11 items-center px-1 text-sm font-medium text-accent-text underline"
                  onClick={() => onTurnOff(s)}
                >
                  Turn off {s.name}
                </button>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ---- screens 2-5 ------------------------------------------------------------------------------------------------

function WizardBody({
  spec,
  step,
  setStep,
  onDone,
  identity,
  setIdentity,
}: {
  spec: Spec
  step: Step
  setStep: (s: Step) => void
  onDone: () => void
  identity: SlackIdentity
  setIdentity: (i: SlackIdentity) => void
}) {
  const client = useTalosClient()
  const config = useTalos((s) => s.config)
  const gate = useWorkGate()
  const readOnly = useWriteBlock() !== null // not connected, or the Mac offline (settings/offline.ts)
  const threads = useTalos((s) => s.threads)
  const agentName = config?.agent.name ?? 'Talos'
  const quiet = config?.quiet_window ?? null

  const [filters, setFilters] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(spec.filters.map((f) => [f.key, f.default])),
  )
  const [thread, setThread] = useState(spec.default_thread === 'work' ? (config?.work.thread ?? 'inbox') : 'inbox')
  const [created, setCreated] = useState<Created | null>(null)
  const [conn, setConn] = useState<Conn | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const creating = useRef(false)
  // What the relay currently holds for this connection; "Adjust what reaches me" PATCHes when the draft differs.
  const sentRef = useRef<{ thread: string; filters: Record<string, boolean>; identity: SlackIdentity } | null>(null)
  // Once a Signing Secret (or any field) has been sent, the connection may be real: whose messages it hears stays as it
  // is, and backing out never deletes it. Set on the attempt, not the answer: a lost reply must not unlock the choice.
  const [fieldsSaved, setFieldsSaved] = useState(false)
  const savedRef = useRef(false)
  savedRef.current = fieldsSaved
  // A create, or the delete-then-create of a switch, is under way: the choice and Next wait for it.
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const bot = identity === 'bot'
  const startedAt = useRef(Date.now())

  // Backing out before the test screen must not leave a half-set-up connection behind (FOLLOWUPS PR4 F16). Once the
  // test screen has been reached the connection may already be receiving events, so it is kept.
  const latest = useRef({ id: null as string | null, step })
  latest.current = { id: created?.id ?? null, step }
  useEffect(() => {
    alive.current = true // StrictMode runs the cleanup once and mounts again
    return () => {
      alive.current = false
      const { id, step: at } = latest.current
      if (id && at <= 3 && !savedRef.current) void client.api.connections.delete(id).catch(() => {})
    }
  }, [client])

  const locked = !gate.isUnlocked(spec)
  const targets = threads.filter((t) => !t.archived && (t.kind !== 'system' || t.id === 'inbox'))

  const createFresh = async () => {
    const c = await client.api.connections.create({
      integration: spec.id,
      name: connName(spec, identity),
      thread,
      filters,
      ...(bot ? { fields: { identity: 'bot' } } : {}),
    })
    // the wizard was closed while this was on its way: nobody will finish it, so it is not kept
    if (!alive.current) {
      void client.api.connections.delete(c.id).catch(() => {})
      return
    }
    sentRef.current = { thread, filters: { ...filters }, identity }
    setCreated(c)
    setConn(c)
    startedAt.current = Date.now()
  }

  // Screen 3 needs the hook URL, so the connection is created on entry (once).
  const createConnection = async () => {
    if (creating.current) return
    creating.current = true
    setBusy(true)
    setCreateError(null)
    let replaced = false
    try {
      // Whose messages is fixed when a connection is made: a draft made for the other choice (nothing sent to it yet, the
      // choice is locked after that) is replaced. Screen 3 says "Setting up…" meanwhile, never the old draft's URL.
      if (created && sentRef.current && sentRef.current.identity !== identity && !fieldsSaved) {
        const old = created.id
        replaced = true
        setCreated(null)
        setConn(null)
        sentRef.current = null
        await client.api.connections.delete(old).catch(() => {}) // a draft with no secret: gone or not, it hears nothing
        return await createFresh()
      }
      if (created) {
        const sent = sentRef.current
        if (sent && (sent.thread !== thread || JSON.stringify(sent.filters) !== JSON.stringify(filters))) {
          const next = await client.api.connections.patch(created.id, { thread, filters })
          sentRef.current = { thread, filters: { ...filters }, identity }
          setConn(next)
        }
        return
      }
      await createFresh()
    } catch {
      setCreateError(
        created && !replaced
          ? "Couldn't save your changes. Nothing was changed."
          : `Couldn't set up ${spec.name}. Nothing was created.`,
      )
    } finally {
      creating.current = false
      setBusy(false)
    }
  }

  if (locked)
    return (
      <div className="space-y-3">
        <p className="text-text">
          🔒 {spec.name} is off. {gate.note}
        </p>
        <WorkEnableDialog spec={spec} readOnly={readOnly} onClose={(changed) => (changed ? undefined : setStep(1))} />
      </div>
    )

  if (step === 2)
    return (
      <div className="space-y-4">
        {spec.id === 'slack' ? (
          <WhoseMessages identity={identity} setIdentity={setIdentity} locked={fieldsSaved} busy={busy} />
        ) : null}
        <p className="text-text-2">{bot ? slackBot.blurb : spec.blurb}</p>
        {spec.filters.length > 0 ? (
          <fieldset className="space-y-1">
            <legend className="mb-1 text-sm text-text-2">{bot ? slackBot.filtersLegend : 'Reach me for'}</legend>
            {spec.filters.map((f) => (
              <label key={f.key} className="flex min-h-11 items-center gap-2 text-text">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={filters[f.key] ?? f.default}
                  onChange={(e) => setFilters((cur) => ({ ...cur, [f.key]: e.target.checked }))}
                />
                {withAgent(filterLabel(f.key, f.label, spec.id === 'slack' ? identity : undefined), agentName)}
              </label>
            ))}
          </fieldset>
        ) : null}
        <label className="flex flex-col gap-1 text-sm text-text-2">
          Send to:
          <select
            className="min-h-11 rounded-button border border-line bg-surface px-3 text-md text-text"
            value={thread}
            onChange={(e) => setThread(e.target.value)}
          >
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id === 'inbox' ? 'Inbox' : t.name}
              </option>
            ))}
          </select>
          {bot ? <span className="text-text-2">{slackBot.threadNote}</span> : null}
        </label>
        {quiet ? (
          <p className="text-sm text-text-2">
            Between {quiet.start} and {quiet.end} these wait for your morning digest.
          </p>
        ) : null}
        <div className="flex justify-between">
          <Button variant="ghost" onClick={() => setStep(1)}>
            Back
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setStep(3)
              void createConnection()
            }}
          >
            Next
          </Button>
        </div>
      </div>
    )

  if (step === 3)
    return (
      <ConnectScreen
        spec={spec}
        identity={created?.identity ?? 'owner'} // the connection's own, once it exists
        onSaved={setFieldsSaved}
        created={created}
        createError={createError}
        retry={() => void createConnection()}
        onBack={() => setStep(2)}
        onNext={() => setStep(4)}
      />
    )

  if (step === 4 && created)
    return (
      <TestScreen
        spec={created?.identity === 'bot' ? { ...spec, test_hint: slackBot.test_hint } : spec}
        connId={created.id}
        startedAt={startedAt.current}
        onBack={() => setStep(3)}
        onAdjust={() => setStep(2)}
        onOk={async () => {
          try {
            setConn(await client.api.connections.get(created.id))
          } catch {
            /* the connected screen falls back to what we created */
          }
          setStep(5)
        }}
      />
    )

  if (step === 5 && conn)
    return (
      <div className="space-y-3">
        <ConnectionPanel conn={conn} spec={spec} onChange={setConn} onDisconnected={onDone} />
        <Button onClick={onDone}>Done</Button>
      </div>
    )
  return <p className="text-text-2">Setting up…</p>
}

// ---- screen 3 ---------------------------------------------------------------------------------------------------

function ConnectScreen({
  spec,
  identity,
  onSaved,
  created,
  createError,
  retry,
  onBack,
  onNext,
}: {
  spec: Spec
  identity: SlackIdentity
  /** true when a save is sent (kept if its answer is lost), false when the relay refused it (nothing was stored) */
  onSaved: (sent: boolean) => void
  created: Created | null
  createError: string | null
  retry: () => void
  onBack: () => void
  onNext: () => void
}) {
  const client = useTalosClient()
  const agent = useTalos((s) => s.config?.agent.name ?? 'Talos')
  const bot = identity === 'bot'
  const ctx = useMemo(() => templateContext(created), [created])
  // The bot's own steps: what both ways share, then the two ways (an app the owner already has first), then the paste.
  const steps = bot ? [...slackBot.intro, ...slackBot.after] : spec.connect
  const fields = steps.filter((s): s is Extract<Spec['connect'][number], { type: 'field' }> => s.type === 'field')
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(fields.length === 0)
  const [saveError, setSaveError] = useState<string | null>(null)

  const validate = (): boolean => {
    const next: Record<string, string> = {}
    for (const f of fields) {
      const v = (values[f.key] ?? '').trim()
      if (!v) {
        if (!/^optional/i.test(f.help ?? '')) next[f.key] = 'Required'
      } else if (f.pattern) {
        let ok = true
        try {
          ok = new RegExp(f.pattern).test(v)
        } catch {
          ok = true
        }
        if (!ok) next[f.key] = "That doesn't look right. Check it and paste again."
      }
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const save = async () => {
    if (!created || !validate()) return
    setSaveError(null)
    try {
      const payload = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]))
      onSaved(true) // sent: from here the connection may hold a secret even if the answer is lost
      const res = await client.api.connections.credentials(created.id, payload)
      if (res.ok) setSaved(true)
      else {
        onSaved(false) // refused before anything was stored: still a draft
        setSaveError(res.detail ?? 'Those did not work.')
      }
    } catch {
      setSaveError('Those did not work.')
    }
  }

  const renderStep = (step: SetupStep, key: string) => (
    <li key={key} className="space-y-2">
      {step.type === 'text' ? <MiniMd md={withAgent(step.md, agent)} /> : null}
      {step.type === 'link' ? (
        <LinkStep label={step.label} href={safeUrl(fillTemplate(step.href_template, ctx))} />
      ) : null}
      {step.type === 'copy' ? (
        <CopyStep label={step.label} value={fillTemplate(step.value_template, ctx)} secret={step.secret} />
      ) : null}
      {step.type === 'script' ? <ScriptStep templateId={step.template_id} ctx={ctx} /> : null}
      {step.type === 'field' ? (
        <div className="flex flex-col gap-1 text-sm text-text-2">
          <label htmlFor={`field-${step.key}`}>{step.label}</label>
          <Input
            id={`field-${step.key}`}
            type={step.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(errors[step.key])}
            value={values[step.key] ?? ''}
            onChange={(e) => {
              setSaved(false)
              setValues((v) => ({ ...v, [step.key]: e.target.value }))
            }}
          />
          {step.help ? <span className="text-xs">{withAgent(step.help, agent)}</span> : null}
          {errors[step.key] ? (
            <span role="alert" className="text-sm text-danger">
              {errors[step.key]}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  )

  if (createError)
    return (
      <div className="space-y-3">
        <p role="alert" className="text-danger">
          {createError}
        </p>
        <Button onClick={retry}>Try again</Button>
      </div>
    )
  if (!created) return <p className="text-text-2">Setting up…</p>

  return (
    <div className="space-y-4">
      <ol className="space-y-3">{(bot ? slackBot.intro : spec.connect).map((step, i) => renderStep(step, `s${i}`))}</ol>
      {bot
        ? slackBot.ways.map((way) => (
            <details key={way.title} className="rounded-card border border-line p-3">
              <summary className="min-h-11 cursor-pointer content-center font-medium text-text">{way.title}</summary>
              <ol className="mt-2 space-y-3">{way.steps.map((step, i) => renderStep(step, `${way.title}${i}`))}</ol>
            </details>
          ))
        : null}
      {bot ? <ol className="space-y-3">{slackBot.after.map((step, i) => renderStep(step, `a${i}`))}</ol> : null}
      {saveError ? (
        <p role="alert" className="text-sm text-danger">
          {saveError}
        </p>
      ) : null}
      {saved && fields.length > 0 ? (
        <p role="status" className="text-sm text-ok">
          Saved.
        </p>
      ) : null}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        {fields.length > 0 && !saved ? (
          <Button onClick={() => void save()}>Save and continue</Button>
        ) : (
          <Button onClick={onNext}>Next</Button>
        )}
      </div>
    </div>
  )
}

function LinkStep({ label, href }: { label: string; href: string | null }) {
  if (!href) return <p className="text-sm text-text-2">{label} isn't available yet.</p>
  return (
    <a
      className="inline-flex min-h-11 items-center text-accent-text underline"
      href={href}
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault()
        getPlatform().openExternal(href)
      }}
    >
      {label} ↗
    </a>
  )
}

function CopyStep({ label, value, secret }: { label: string; value: string | null; secret: boolean }) {
  const [copied, setCopied] = useState(false)
  const [revealed, setRevealed] = useState(false)
  if (value === null) return <p className="text-sm text-text-2">{label}: not available yet.</p>
  return (
    <div className="space-y-1">
      <p className="text-sm text-text-2">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-button bg-surface-2 p-2 font-mono text-xs text-text">
          {secret && !revealed ? '•'.repeat(24) : value}
        </code>
        {secret ? (
          <Button variant="ghost" aria-pressed={revealed} onClick={() => setRevealed((v) => !v)}>
            {revealed ? 'Hide' : 'Show'}
          </Button>
        ) : null}
        <Button variant="outline" aria-label={`Copy ${label}`} onClick={async () => setCopied(await copyText(value))}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {secret ? <p className="text-xs text-text-2">Shown once. Copy it now.</p> : null}
    </div>
  )
}

function ScriptStep({ templateId, ctx }: { templateId: string; ctx: Record<string, string | undefined> }) {
  const [copied, setCopied] = useState(false)
  const text = scriptText(templateId, ctx)
  if (text === null) return <p className="text-sm text-text-2">The setup script isn't available yet.</p>
  return (
    <Button variant="outline" onClick={async () => setCopied(await copyText(text))}>
      {copied ? 'Copied' : 'Copy script'}
    </Button>
  )
}

// ---- screen 4 ---------------------------------------------------------------------------------------------------

function TestScreen({
  spec,
  connId,
  startedAt,
  onBack,
  onAdjust,
  onOk,
}: {
  spec: Spec
  connId: string
  startedAt: number
  onBack: () => void
  onAdjust: () => void
  onOk: () => void
}) {
  const client = useTalosClient()
  const now = useNow(1000)
  const arrived = useTalos((s) => s.inbox.find((i) => i.connection === connId))
  const [lastError, setLastError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  useEffect(() => {
    if (arrived) return
    let live = true
    const poll = async () => {
      try {
        const d = await client.api.connections.deliveries(connId)
        const bad = d.find((x) => x.status >= 400)
        if (live) setLastError(bad?.reason ?? null)
      } catch {
        /* keep waiting */
      }
    }
    void poll()
    const t = setInterval(poll, 5000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [client, connId, arrived])

  const waited = now - startedAt
  return (
    <div className="space-y-4">
      <p className="text-text-2">{spec.test_hint}</p>
      {arrived ? (
        <div className="space-y-3" role="status">
          <p className="text-text">
            Got it: '<span data-testid="first-event">{arrived.title}</span>'.
          </p>
          <div className="flex gap-2">
            <Button onClick={onOk}>Looks right</Button>
            <Button variant="outline" onClick={onAdjust}>
              Adjust what reaches me
            </Button>
          </div>
        </div>
      ) : waited >= TEST_WAIT_MS ? (
        <div className="space-y-2" role="status">
          <p className="text-text">Nothing yet. Here's what to check:</p>
          <p className="text-sm text-text-2">{lastError ?? 'Nothing has reached Talos yet.'}</p>
          <p className="text-sm text-text-2">{spec.test_hint}</p>
        </div>
      ) : (
        <p role="status" className="text-text">
          Waiting for the first event…
        </p>
      )}
      {testResult ? <p className="text-sm text-text-2">{testResult}</p> : null}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          variant="outline"
          onClick={async () => {
            try {
              const r = await client.api.connections.test(connId)
              setTestResult(r.detail ?? (r.ok ? 'The connection works.' : 'The test failed.'))
            } catch {
              setTestResult('The test could not run.')
            }
          }}
        >
          Send a test
        </Button>
      </div>
    </div>
  )
}

// ---- Slack: whose messages ------------------------------------------------------------------------------------------

function WhoseMessages({
  identity,
  setIdentity,
  locked,
  busy,
}: {
  identity: SlackIdentity
  setIdentity: (i: SlackIdentity) => void
  locked: boolean
  busy: boolean
}) {
  const note = useId()
  const choices: Array<[SlackIdentity, string]> = [
    ['owner', 'My messages'],
    ['bot', "An agent's bot"],
  ]
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm text-text-2">Whose messages?</legend>
      <div className="flex gap-2">
        {choices.map(([id, label]) => (
          <Button
            key={id}
            variant={identity === id ? 'primary' : 'outline'}
            aria-pressed={identity === id}
            aria-describedby={locked ? note : undefined}
            disabled={locked || busy}
            onClick={() => setIdentity(id)}
          >
            {label}
          </Button>
        ))}
      </div>
      {locked ? (
        <p id={note} className="text-sm text-text-2">
          This connection listens to {identity === 'bot' ? "an agent's bot" : 'your messages'}. To listen to the other,
          add a second Slack connection.
        </p>
      ) : null}
    </fieldset>
  )
}
