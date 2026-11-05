// Settings → Agent (spec 8.5 #3). Edits are a draft; Save sends one signed `config.patch` that touches only the
// allowlisted fields that changed. Read-only while the Mac is offline.
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { Button, Input } from '../../ui/index.ts'
import type { SettingsSectionProps } from '../contracts.ts'
import { AgentRecover } from './AgentRecover.tsx'
import { setAgentDraft, useEffectiveAgentDraft } from './draftStore.ts'
import { type AgentDraft, draftFromConfig, validateDraft } from './patch.ts'
import { SetupAgent } from './SetupAgent.tsx'

function zones(): string[] {
  try {
    return (
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['UTC']
    )
  } catch {
    return ['UTC']
  }
}

export function AgentSettingsSection({ readOnly }: SettingsSectionProps) {
  const client = useTalosClient()
  // The draft and the config it started from live in a store outside this component (draftStore.ts), so leaving the
  // screen keeps them. When the config moves under an edit (another section here, another device, the agent), the
  // untouched fields follow it and the edited ones stay: Save then sends only what he changed.
  const { draft, conflicts, moved, patch, edited, config, state } = useEffectiveAgentDraft()
  const threads = useTalos((st) => st.threads)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!config) return
    if (state.draft === null) setAgentDraft(draftFromConfig(config), config)
    else if (moved && draft) setAgentDraft(draft, config, conflicts)
  }, [config, state.draft, moved, draft, conflicts])

  const issues = useMemo(() => (draft ? validateDraft(draft) : {}), [draft])
  const dirty = Object.keys(patch).length > 0
  const browserZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, [])
  const zoneList = useMemo(zones, [])

  if (!config || !draft) return <p className="p-4 text-text-2">Waiting for your Mac to share its settings…</p>
  const locked = readOnly
  const set = (p: Partial<AgentDraft>) => {
    setMessage(null)
    setAgentDraft({ ...draft, ...p }, config, conflicts)
  }
  const discard = () => {
    setAgentDraft(draftFromConfig(config), config)
    setMessage(null)
  }

  const save = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await client.patchConfig(patch)
      setMessage({ tone: 'ok', text: 'Saved.' })
      setAgentDraft(null, null) // re-seeded from the new config by the effect above
    } catch (e) {
      if (e instanceof TalosClientError && e.code === 'config_conflict') {
        // Nothing is thrown away: the edits stay and merge onto the newer config when it arrives.
        setMessage({
          tone: 'error',
          text: 'Your settings changed on another device just now. Your edits are kept and nothing was saved; review and save again.',
        })
      } else if (e instanceof TalosClientError && e.code === 'config_field_forbidden') {
        setMessage({ tone: 'error', text: "One of those settings can't be changed from the app." })
      } else if (e instanceof TalosClientError && e.code === 'mac_offline') {
        setMessage({ tone: 'error', text: "Your Mac is offline. Try again when it's back." })
      } else {
        setMessage({ tone: 'error', text: "Couldn't save. Nothing was changed." })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Agent settings" className="w-full space-y-6" data-readonly={locked}>
      <h2 className="m-0 font-display text-xl font-semibold">Agent</h2>
      {locked ? (
        <p role="status" className="rounded-card border border-line p-3 text-sm text-text-2">
          Your Mac is offline, so these settings are read-only until it's back.
        </p>
      ) : null}

      <Group title="Names">
        <Field label="Agent name" error={issues.agentName}>
          {(id) => (
            <Input
              id={id}
              disabled={locked}
              value={draft.agentName}
              maxLength={32}
              onChange={(e) => set({ agentName: e.target.value })}
            />
          )}
        </Field>
        <Field label="Your name" error={issues.ownerName}>
          {(id) => (
            <Input
              id={id}
              disabled={locked}
              value={draft.ownerName}
              maxLength={40}
              onChange={(e) => set({ ownerName: e.target.value })}
            />
          )}
        </Field>
      </Group>

      <Group title="Set up my agent">
        <SetupAgent macOnline={!locked} />
      </Group>

      <Group title="If the agent is stuck">
        <AgentRecover macOnline={!locked} />
      </Group>

      <Group title="Threads">
        <p className="m-0 text-sm text-text-2">
          Names, order, icons, colors and archiving live in Manage threads. Each thread's own settings (notifications,
          live-call context, its own session) are in that thread's settings.
        </p>
        <Link
          to="/threads?manage=1"
          data-testid="manage-threads-link"
          className="inline-flex min-h-11 items-center font-medium text-accent-text underline"
        >
          Manage threads
        </Link>
      </Group>

      <Group title="Where things go">
        <Field label="Default thread">
          {(id) => (
            <Select
              id={id}
              disabled={locked}
              value={draft.defaultThread}
              onChange={(v) => set({ defaultThread: v })}
              options={threads.filter((t) => !t.archived).map((t) => [t.id, t.name])}
            />
          )}
        </Field>
      </Group>

      <Group title="Time">
        <Field label="Timezone" error={issues.timezone}>
          {(id) => (
            <>
              <Input
                id={id}
                list="zone-list"
                disabled={locked}
                value={draft.timezone}
                autoCapitalize="off"
                spellCheck={false}
                onChange={(e) => set({ timezone: e.target.value })}
              />
              <datalist id="zone-list">
                {zoneList.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
              {browserZone && browserZone !== draft.timezone ? (
                <Button variant="ghost" disabled={locked} onClick={() => set({ timezone: browserZone })}>
                  Use this device's timezone ({browserZone})
                </Button>
              ) : null}
            </>
          )}
        </Field>
        <p className="m-0 text-xs text-text-2">Quiet hours are in Settings, Notifications. They use this timezone.</p>
      </Group>

      {edited ? (
        <p role="status" data-testid="agent-unsaved" className="m-0 text-sm font-medium text-warn">
          Unsaved changes
        </p>
      ) : null}
      {conflicts.length > 0 ? (
        <p role="status" data-testid="agent-conflicts" className="m-0 text-sm text-text-2">
          Also changed elsewhere since you started: {conflicts.join(', ')}. Saving keeps your version of{' '}
          {conflicts.length === 1 ? 'it' : 'them'}.
        </p>
      ) : null}
      {message ? (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={message.tone === 'error' ? 'text-danger' : 'text-ok'}
        >
          {message.text}
        </p>
      ) : null}
      <div className="sticky bottom-0 flex gap-2 bg-bg py-2">
        <Button disabled={locked || busy || !dirty || Object.keys(issues).length > 0} onClick={() => void save()}>
          Save changes
        </Button>
        <Button variant="ghost" disabled={!edited || busy} onClick={discard}>
          Discard
        </Button>
      </div>
    </section>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">
        {title}
      </legend>
      {children}
    </fieldset>
  )
}

function Field({
  label,
  error,
  children,
}: {
  label: string
  error?: string | undefined
  children: (id: string) => ReactNode
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1 text-sm text-text-2">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {error ? (
        <span role="alert" className="text-danger">
          {error}
        </span>
      ) : null}
    </div>
  )
}

function Select({
  id,
  value,
  onChange,
  options,
  disabled,
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  options: Array<[string, string]> | Array<readonly [string, string]>
  disabled?: boolean
}) {
  return (
    <select
      id={id}
      className="min-h-11 rounded-button border border-line bg-surface px-3 text-md text-text disabled:opacity-50"
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  )
}
