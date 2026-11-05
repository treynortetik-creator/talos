// Screen 5 of the wizard and the connection page: status line, Pause, Edit filters, Recent deliveries, Rotate secret,
// Disconnect (spec 7.7).
import { useId, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input } from '../../ui/index.ts'
import { copyText, relativeTime, useNow } from '../cards/util.ts'
import { type Conn, type Spec, statusWord, useDeliveries } from './data.ts'

// Apps Script modules (claim) and provisioned ones (Linear, Calendly): a new secret cannot reach the pasted script or
// the vendor's webhook yet, so Rotate would silently break them. Re-claim support is a follow-up.
const NO_ROTATE = new Set<string>(['gmail', 'gmail_work', 'gcal', 'forward', 'linear', 'calendly'])

export function ConnectionPanel({
  conn,
  spec,
  onChange,
  onDisconnected,
}: {
  conn: Conn
  spec: Spec | undefined
  onChange: (c: Conn) => void
  onDisconnected: () => void
}) {
  const client = useTalosClient()
  const threads = useTalos((s) => s.threads)
  const nameId = useId()
  const threadId = useId()
  const [nameText, setNameText] = useState<string | null>(null)
  const now = useNow(30_000)
  const timeZone = useTalos((s) => s.config?.timezone ?? 'UTC')
  const [showFilters, setShowFilters] = useState(false)
  const [filters, setFilters] = useState<Record<string, boolean>>(() => ({
    ...Object.fromEntries((spec?.filters ?? []).map((f) => [f.key, f.default])),
    ...conn.filters,
  }))
  const [showDeliveries, setShowDeliveries] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deliveries = useDeliveries(conn.id)

  const act = async (fn: () => Promise<void>) => {
    setError(null)
    try {
      await fn()
    } catch {
      setError('That did not go through. Nothing was changed.')
    }
  }

  const name = spec?.name ?? conn.name
  const canRotate = !NO_ROTATE.has(conn.integration)
  return (
    <section aria-label={`${name} connection`} className="space-y-3">
      <p className="text-text" data-testid="conn-status">
        <strong>{name}</strong> ·{' '}
        <Badge tone={conn.status === 'active' ? 'ok' : 'warn'}>{statusWord(conn.status)}</Badge>
        {' · '}
        {conn.last_event_at ? `Last event ${relativeTime(conn.last_event_at, now)} ago` : 'No events yet'}
        {' · '}
        {conn.kept_24h} kept / {conn.received_24h} received today
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() =>
            act(async () => {
              onChange(
                await client.api.connections.patch(conn.id, {
                  status: conn.status === 'paused' ? 'active' : 'paused',
                }),
              )
            })
          }
        >
          {conn.status === 'paused' ? 'Resume' : 'Pause'}
        </Button>
        <Button variant="outline" aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>
          Edit filters
        </Button>
        <Button variant="outline" aria-expanded={showDeliveries} onClick={() => setShowDeliveries((v) => !v)}>
          Recent deliveries
        </Button>
        {canRotate ? (
          <Button
            variant="outline"
            onClick={() =>
              act(async () => {
                setSecret((await client.api.connections.rotate(conn.id)).secret)
              })
            }
          >
            Rotate secret
          </Button>
        ) : null}
        <Button variant="danger" onClick={() => setConfirmDelete(true)}>
          Disconnect
        </Button>
      </div>

      <div className="flex flex-col gap-2" data-testid="conn-edit">
        <div className="flex flex-col gap-1 text-sm text-text-2">
          <label htmlFor={nameId}>Name</label>
          <div className="flex gap-2">
            <Input
              id={nameId}
              value={nameText ?? conn.name}
              maxLength={80}
              onChange={(e) => setNameText(e.target.value)}
            />
            <Button
              variant="outline"
              disabled={nameText === null || nameText.trim() === '' || nameText.trim() === conn.name}
              onClick={() =>
                act(async () => {
                  onChange(await client.api.connections.patch(conn.id, { name: (nameText ?? '').trim() }))
                  setNameText(null)
                })
              }
            >
              Rename
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1 text-sm text-text-2">
          <label htmlFor={threadId}>Posts to</label>
          <select
            id={threadId}
            value={conn.thread}
            className="min-h-11 rounded-button border border-line bg-surface px-3 text-text"
            onChange={(e) =>
              void act(async () => onChange(await client.api.connections.patch(conn.id, { thread: e.target.value })))
            }
          >
            {threads
              .filter((t) => (!t.archived && (t.kind !== 'system' || t.id === 'inbox')) || t.id === conn.thread)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
          <span>New events go to this thread. Events already in the Inbox stay where they are.</span>
        </div>
      </div>

      {canRotate ? null : <p className="text-sm text-text-2">Rotating the secret is not supported for this app yet.</p>}

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {secret ? (
        <div className="rounded-card border border-line p-3" role="status">
          <p className="text-sm text-text">New secret (shown once). The old one keeps working for 24 hours.</p>
          <code className="block break-all font-mono text-sm text-text" data-testid="rotated-secret">
            {secret}
          </code>
          <Button variant="outline" onClick={() => void copyText(secret)}>
            Copy
          </Button>
        </div>
      ) : null}

      {showFilters ? (
        <fieldset className="space-y-1 rounded-card border border-line p-3">
          <legend className="px-1 text-sm text-text-2">What reaches you</legend>
          {(spec?.filters ?? []).length === 0 ? <p className="text-sm text-text-2">No filters for this app.</p> : null}
          {(spec?.filters ?? []).map((f) => (
            <label key={f.key} className="flex min-h-11 items-center gap-2 text-text">
              <input
                type="checkbox"
                className="size-5"
                checked={filters[f.key] ?? f.default}
                onChange={(e) => setFilters((cur) => ({ ...cur, [f.key]: e.target.checked }))}
              />
              {f.label}
            </label>
          ))}
          <Button onClick={() => act(async () => onChange(await client.api.connections.patch(conn.id, { filters })))}>
            Save filters
          </Button>
        </fieldset>
      ) : null}

      {showDeliveries ? (
        <div className="rounded-card border border-line p-3">
          <h3 className="mb-1 text-sm font-medium text-text">Recent deliveries</h3>
          {deliveries.loading ? <p className="text-sm text-text-2">Loading…</p> : null}
          {deliveries.data && deliveries.data.length === 0 ? (
            <p className="text-sm text-text-2">Nothing has arrived yet.</p>
          ) : null}
          <ul className="divide-y divide-line font-mono text-xs">
            {(deliveries.data ?? []).slice(0, 20).map((d) => (
              <li key={`${d.at}:${d.status}:${d.reason ?? ''}`} className="flex gap-3 py-1 text-text">
                <span>
                  {new Date(d.at).toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' })}
                </span>
                <span>{d.status}</span>
                <span className="min-w-0 flex-1 break-words text-text-2">{d.reason ?? ''}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent aria-describedby="disconnect-desc">
          <DialogTitle className="text-lg font-medium text-text">Disconnect {name}?</DialogTitle>
          <DialogDescription id="disconnect-desc" className="mt-1 text-sm text-text-2">
            Events from {name} stop arriving. Existing inbox items stay.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                act(async () => {
                  await client.api.connections.delete(conn.id)
                  setConfirmDelete(false)
                  onDisconnected()
                })
              }
            >
              Disconnect
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
