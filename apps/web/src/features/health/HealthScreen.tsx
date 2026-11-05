// Settings -> Health (docs/V2-FEATURES.md V2.5). A relay feature: reachable, and honest, with the Mac offline.
import { PROTOCOL_VERSION, SCHEDULES_FEATURE } from '@talos-app/protocol'
import { useEffect, useState } from 'react'
import { useTalos } from '../../lib/client.ts'
import { ago } from '../../lib/format.ts'
import { createHttp, HttpError } from '../../lib/http.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { cn } from '../../ui/cn.ts'
import { Button } from '../../ui/index.ts'
import { Mascot } from '../../ui/Mascot.tsx'
import { StatusDot } from '../../ui/StatusDot.tsx'
import { ReportProblem } from '../problems/ReportProblem.tsx'
import { gatherDiagnosticsText } from './gather.ts'
import { limitsLine } from './limits.ts'
import { PermissionRelaySwitch } from './PermissionRelaySwitch.tsx'
import { type HealthRow, healthNotes, healthRows, NOBODY, type Tone, testOutcome } from './rows.ts'
import { useHealthStatus } from './useHealthStatus.ts'

const http = createHttp()

const DOT: Record<Tone, 'solid' | 'half' | 'ring' | 'live'> = { ok: 'solid', warn: 'half', bad: 'live', idle: 'ring' }
const COLOR: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-danger', idle: 'text-text-2' }
const WORD: Record<Tone, string> = { ok: 'OK', warn: 'Needs a look', bad: 'Problem', idle: 'Not active' }

function Row({ row }: { row: HealthRow }) {
  return (
    <li
      data-testid={`health-row-${row.id}`}
      data-tone={row.tone}
      className="flex min-h-14 items-center gap-3 px-4 py-2.5"
    >
      <span className={cn('flex w-5 justify-center', COLOR[row.tone])}>
        <StatusDot shape={DOT[row.tone]} size={12} />
      </span>
      <span className="w-28 shrink-0 text-sm font-semibold">{row.label}</span>
      <span className="min-w-0 flex-1 text-sm text-text-2">{row.detail}</span>
      <span className="sr-only">{WORD[row.tone]}</span>
    </li>
  )
}

/** The Mac, the server and the queue between them: the page that used to be Settings -> Connection (audit D5). */
function ConnectionBlock() {
  const presence = useTalos((s) => s.presence)
  const connection = useTalos((s) => s.connection)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const mac = presence.bridge_online ? 'Mac online' : 'Mac offline'
  const seen = presence.last_seen ? ` · last seen ${ago(presence.last_seen, now)}` : ''
  const line = 'flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2 text-sm'
  return (
    <div data-testid="connection-block" className="flex flex-col">
      <h3 className="m-0 mb-1 text-base font-medium">Connection</h3>
      <div className={line}>
        <span>Mac</span>
        <span
          data-testid="mac-status"
          className={cn('inline-flex items-center gap-1.5', presence.bridge_online ? 'text-ok' : 'text-text-2')}
        >
          <StatusDot shape={presence.bridge_online ? 'solid' : 'ring'} />
          {mac}
          {seen}
        </span>
      </div>
      <div className={line}>
        <span>Server</span>
        <span>
          {connection === 'online' ? 'Connected' : connection === 'connecting' ? 'Connecting…' : 'Not connected'}
        </span>
      </div>
      <div className={line}>
        <span>Waiting to deliver</span>
        <span>{presence.queue_depth} messages queued</span>
      </div>
    </div>
  )
}

/** Settings shown here: the tool-prompts switch, and the relay limits (set on the server, so only a line). */
function ReadOnlySettings({ limits, declared }: { limits: string | null; declared: boolean | undefined }) {
  return (
    <div data-testid="health-readonly" className="flex flex-col gap-1">
      <h3 className="m-0 text-base font-medium">Tool prompts and limits</h3>
      <PermissionRelaySwitch declared={declared} />
      {limits && (
        <p className="m-0 text-sm" data-testid="relay-limits">
          <span className="font-medium">Relay limits:</span>{' '}
          <span className="text-text-2">{limits}. Set on your server.</span>
        </p>
      )}
    </div>
  )
}

export function HealthScreen() {
  const { state, refresh } = useHealthStatus()
  const schedules = useFeature(SCHEDULES_FEATURE)
  const cached = useTalos((s) => s.schedules.snapshot?.health.state ?? null)
  const [test, setTest] = useState<{ kind: 'idle' | 'sending' | 'sent' | 'failed'; text: string }>({
    kind: 'idle',
    text: '',
  })

  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')

  const noPath = state.status?.relay_problems.includes('no_alert_path') ?? false
  const sendTest = async () => {
    setTest({ kind: 'sending', text: '' })
    try {
      const res = await http.json<{ push?: { sent: number; ok: number }; ntfy?: string } | undefined>(
        'POST',
        '/api/health/test',
      )
      setTest(testOutcome(res, noPath))
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) setTest({ kind: 'failed', text: NOBODY })
      else setTest({ kind: 'failed', text: "Couldn't send the test alert." })
    }
  }

  const status = state.status
  const rows = status ? healthRows(status, { scheduler: schedules === 'off' ? undefined : { state: cached } }) : []
  const copyDiagnostics = async () => {
    const text = gatherDiagnosticsText({
      rows,
      at: status?.at ?? null,
      relay: status?.relay.version ?? null,
      notes: status ? healthNotes(status) : [],
    })
    try {
      await navigator.clipboard.writeText(text)
      setCopied('copied')
    } catch {
      setCopied('failed')
    }
  }
  const notes = status ? healthNotes(status) : []

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4" aria-labelledby="health-h">
      <div className="flex items-center gap-3">
        <h2 id="health-h" className="m-0 flex-1 font-display text-xl font-semibold">
          Health
        </h2>
        <Button variant="outline" onClick={sendTest} disabled={test.kind === 'sending'}>
          Send test alert
        </Button>
      </div>

      {test.kind === 'sent' && (
        <p role="status" className="m-0 text-sm text-text-2">
          {test.text}
        </p>
      )}
      {test.kind === 'failed' && (
        <p role="alert" className="m-0 text-sm font-medium text-danger">
          {test.text}
        </p>
      )}

      <ConnectionBlock />

      {state.phase === 'loading' && <p className="m-0 text-text-2">Checking…</p>}

      {state.phase === 'error' && rows.length > 0 && (
        <div data-testid="health-stale" className="flex items-center gap-3">
          <p role="alert" className="m-0 flex-1 text-sm font-medium text-danger">
            Couldn't load health.
          </p>
          <Button variant="outline" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}

      {state.phase === 'error' && rows.length === 0 && (
        <div
          data-testid="health-error"
          className="mx-auto flex max-w-[420px] flex-col items-center gap-4 px-6 py-8 text-center"
        >
          <Mascot state="worried" size={96} decorative />
          <p role="alert" className="m-0 font-display text-xl font-semibold">
            Couldn't load health.
          </p>
          <Button variant="outline" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}

      {rows.length > 0 && (
        <ul className="incised m-0 flex list-none flex-col divide-y divide-line overflow-hidden rounded-card bg-surface p-0">
          {rows.map((r) => (
            <Row key={r.id} row={r} />
          ))}
        </ul>
      )}

      <ReadOnlySettings
        limits={status ? limitsLine(status.limits) : null}
        declared={status?.beat?.permission_relay_declared}
      />

      {notes.map((n) => (
        <p key={n} data-testid="health-note" className="m-0 text-sm text-text-2">
          {n}
        </p>
      ))}

      <dl data-testid="health-versions" className="m-0 flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-text-2">Protocol</dt>
          <dd className="m-0 font-mono">v{PROTOCOL_VERSION}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-text-2">App</dt>
          <dd className="m-0 font-mono">{import.meta.env.VITE_APP_VERSION ?? '0.0.0'}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={() => void copyDiagnostics()}>
          Copy diagnostics
        </Button>
        {copied === 'copied' && (
          <p role="status" className="m-0 text-sm text-text-2">
            Copied. It holds versions and status only: no messages, no keys.
          </p>
        )}
        {copied === 'failed' && (
          <p role="alert" className="m-0 text-sm font-medium text-danger">
            Couldn't copy. Copy the versions above by hand.
          </p>
        )}
      </div>
      <ReportProblem />
    </section>
  )
}
