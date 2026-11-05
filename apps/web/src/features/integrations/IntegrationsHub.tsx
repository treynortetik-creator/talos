// The Integrations list: connected apps, the "Connect an app" tiles (Personal and the work group with its lock), and the
// views a tap opens (wizard, connection page). Self-contained so it works under any route WP6 mounts it on.
import { useId, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { Badge, Button } from '../../ui/index.ts'
import { relativeTime, useNow } from '../cards/util.ts'
import { friendlyPatchError } from '../threads/manage/useThreadPatch.ts'
import { ConnectionPanel } from './ConnectionPanel.tsx'
import { type Conn, statusWord, useCatalog, useConnection, useConnections } from './data.ts'
import { IntegrationWizard, PickScreen } from './Wizard.tsx'
import { WorkWording } from './WorkWording.tsx'

type View = { kind: 'list' } | { kind: 'wizard'; id?: string } | { kind: 'conn'; id: string }

export function IntegrationsHub({ readOnly: readOnlyProp }: { readOnly?: boolean }) {
  // Follows the Mac unless a caller says otherwise: the work switches and the work thread are synced config (audit U11)
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const readOnly = readOnlyProp ?? !macOnline
  const [view, setView] = useState<View>({ kind: 'list' })
  const catalog = useCatalog()
  const conns = useConnections()
  const now = useNow(30_000)
  const specs = catalog.data ?? []

  if (view.kind === 'wizard')
    return (
      <IntegrationWizard
        {...(view.id ? { integrationId: view.id } : {})}
        onDone={() => {
          conns.reload()
          setView({ kind: 'list' })
        }}
      />
    )
  if (view.kind === 'conn')
    return (
      <div className="space-y-3 p-4">
        <Button variant="ghost" onClick={() => setView({ kind: 'list' })}>
          ← Integrations
        </Button>
        <ConnectionDetail
          connectionId={view.id}
          onGone={() => {
            conns.reload()
            setView({ kind: 'list' })
          }}
        />
      </div>
    )

  return (
    <section aria-label="Integrations" className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl text-text">Integrations</h2>
        <Button onClick={() => setView({ kind: 'wizard' })}>Add an integration</Button>
      </div>
      <p className="-mt-2 text-sm text-text-2">
        Apps and webhooks that send events to your Inbox. Your agent's own tools and connectors are set up in Claude
        Code.
      </p>
      {readOnly ? (
        <p role="status" className="rounded-card border border-line p-2 text-sm text-text-2">
          Your Mac is offline, so work systems can't be switched on or off right now.
        </p>
      ) : null}
      {conns.data && conns.data.length > 0 ? (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface" aria-label="Connected apps">
          {conns.data.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex min-h-16 w-full items-center gap-3 px-3 text-left"
                data-conn={c.id}
                onClick={() => setView({ kind: 'conn', id: c.id })}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-text">{c.name}</span>
                  <span className="block text-sm text-text-2">
                    {c.last_event_at ? `Last event ${relativeTime(c.last_event_at, now)} ago` : 'No events yet'}
                  </span>
                </span>
                <Badge tone={c.status === 'active' ? 'ok' : 'warn'}>{statusWord(c.status)}</Badge>
              </button>
            </li>
          ))}
        </ul>
      ) : conns.loading ? null : conns.error || catalog.error ? (
        <div className="space-y-2">
          <p role="alert" className="text-danger">
            Can't reach your server.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              conns.reload()
              catalog.reload()
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <p className="text-text-2">No integrations yet.</p>
      )}
      <PickScreen specs={specs} onPick={(id) => setView({ kind: 'wizard', id })} />
      <WorkThread readOnly={readOnly} />
      <WorkWording readOnly={readOnly} />
    </section>
  )
}

export function ConnectionDetail({ connectionId, onGone }: { connectionId: string; onGone?: () => void }) {
  const catalog = useCatalog()
  const conn = useConnection(connectionId)
  const [override, setOverride] = useState<Conn | null>(null)
  const c = override ?? conn.data
  if (conn.loading || catalog.loading) return <p className="p-4 text-text-2">Loading…</p>
  if (!c) return <p className="p-4 text-text-2">This connection isn't here any more.</p>
  return (
    <div className="p-4">
      <ConnectionPanel
        conn={c}
        spec={catalog.data?.find((s) => s.id === c.integration)}
        onChange={setOverride}
        onDisconnected={() => onGone?.()}
      />
    </div>
  )
}

/**
 * Where new work connections post by default (`work.thread`), moved here from Settings -> Agent. It only sets the starting
 * choice for a connection you add later: a connection that already exists keeps its own thread (audit M9). Saves at once.
 */
function WorkThread({ readOnly }: { readOnly: boolean }) {
  const client = useTalosClient()
  const config = useTalos((s) => s.config)
  const threads = useTalos((s) => s.threads)
  const [err, setErr] = useState<string | null>(null)
  const id = useId()
  if (!config) return null
  const set = async (v: string) => {
    setErr(null)
    try {
      await client.patchConfig({ work: { thread: v === '' ? null : v } })
    } catch (e) {
      setErr(friendlyPatchError(e)) // the select is driven by the saved config, so it goes back
    }
  }
  return (
    <div className="flex flex-col gap-1" data-testid="work-thread">
      <label htmlFor={id} className="text-sm font-medium">
        {config.work.label} thread
      </label>
      <select
        id={id}
        value={config.work.thread ?? ''}
        disabled={readOnly}
        onChange={(e) => void set(e.target.value)}
        className="min-h-11 rounded-button border border-line bg-surface px-3 text-text disabled:opacity-50"
      >
        <option value="">Inbox (default)</option>
        {threads
          .filter((t) => !t.archived && (t.kind !== 'system' || t.id === 'inbox') && t.id !== 'inbox')
          .map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
      </select>
      <p className="m-0 text-xs text-text-2">
        The starting choice for new {config.work.label.toLowerCase()} connections. Connections you already added keep
        their own thread.
      </p>
      {err && (
        <p role="alert" className="m-0 text-sm text-danger">
          {err}
        </p>
      )}
    </div>
  )
}
