// The Schedules empty and error states (docs/SCHEDULES.md S5.6). Each one says what is wrong and what to do.
import type { ScheduleSnapshotT } from '@talos-app/protocol'
import { useState } from 'react'
import { useTalosClient } from '../../lib/client.ts'
import { placeWords, useHost } from '../../lib/hostWords.ts'
import { Button } from '../../ui/index.ts'
import { Mascot, type MascotState } from '../../ui/Mascot.tsx'
import { copyText } from '../cards/util.ts'
import { CHRONOS_INSTALL_CMD, CHRONOS_LINUX_INSTALL_CMD, CHRONOS_UPDATE_CMD, COPY, fill } from './constants.ts'
import type { EmptyKind } from './logic.ts'
import { Ticks } from './shared.tsx'
import { refreshSchedules } from './sync.ts'

function CodeBlock({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex w-full items-start gap-2 rounded-card bg-surface-2 p-3 text-left">
      <code data-testid="install-cmd" className="min-w-0 flex-1 break-all font-mono text-sm">
        {cmd}
      </code>
      <Button
        variant="outline"
        onClick={async () => {
          setCopied(await copyText(cmd))
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

export function EmptyState({
  kind,
  agent,
  snapshot,
  onTell,
}: {
  kind: Exclude<EmptyKind, null>
  agent: string
  snapshot: ScheduleSnapshotT | null
  onTell: () => void
}) {
  const client = useTalosClient()
  const host = useHost()
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    setBusy(true)
    await refreshSchedules(client)
    setBusy(false)
  }
  let mascot: MascotState = 'pleased'
  let title = ''
  let body: React.ReactNode = null
  let action: React.ReactNode = null
  switch (kind) {
    case 'not_installed':
      // Off a Mac, Chronos runs jobs in a Talos thread only (no background timer yet). Linux installs it by hand; the PC's
      // Setup installs it, so on a PC this state means Setup did not finish (Hestia and Titan, 2026-11-14)
      if (host === 'windows') {
        title = 'Run Talos Setup again to set up scheduled jobs.'
        break
      }
      if (host === 'linux') {
        title = 'Install Chronos to schedule jobs here: jobs that run in a Talos thread work on Linux.'
        body = (
          <>
            <CodeBlock cmd={CHRONOS_LINUX_INSTALL_CMD} />
            <p className="text-sm text-text-2">
              <Ticks text="Then run `talos-app schedules adopt`." />
            </p>
          </>
        )
        break
      }
      title = placeWords(fill(COPY.noScheduler, { agent }), host)
      body = (
        <>
          <CodeBlock cmd={CHRONOS_INSTALL_CMD} />
          <p className="text-sm text-text-2">
            <Ticks text={COPY.afterInstall} />
          </p>
        </>
      )
      break
    case 'old_chronos': {
      const v = snapshot?.health.adapter.version
      title = `Chronos ${v ?? ''}${v ? ' ' : ''}is installed. ${COPY.oldChronos}`.replace('  ', ' ')
      body = <CodeBlock cmd={CHRONOS_UPDATE_CMD} />
      break
    }
    case 'update_mac':
      title = placeWords(COPY.bridgeOld, host)
      mascot = 'worried'
      break
    case 'update_relay':
      title = 'Update your Talos relay to use Schedules.'
      mascot = 'worried'
      break
    case 'update_app':
      title = COPY.updateApp
      mascot = 'worried'
      body = (
        <p className="text-sm text-text-2">
          {placeWords('Your Mac speaks a newer version of Schedules than this app does.', host)}
        </p>
      )
      action = (
        <Button variant="outline" onClick={() => location.reload()}>
          Reload the app
        </Button>
      )
      break
    case 'off':
      title = COPY.turnedOff
      body = (
        <p className="text-sm text-text-2">
          <Ticks
            text={placeWords('Remove that setting on your Mac and restart your session to turn them back on.', host)}
          />
        </p>
      )
      break
    case 'no_jobs':
      title = fill(COPY.empty, { agent })
      action = <Button onClick={onTell}>Tell {agent}</Button>
      break
    case 'unreadable': {
      mascot = 'worried'
      const why =
        snapshot?.unreadable[0]?.unreadable ??
        snapshot?.health.issues.find((i) => i.code === 'registry_unreadable')?.text
      title = `Your scheduler's job file can't be read${why ? `: ${why}` : '.'}`
      break
    }
    case 'no_answer':
      mascot = 'worried'
      title = COPY.noAnswer
      action = (
        <Button variant="outline" disabled={busy} onClick={retry}>
          Try again
        </Button>
      )
      break
    case 'mac_offline':
      mascot = 'worried'
      title = placeWords('Your Mac is offline.', host)
      body = <p className="text-sm text-text-2">{placeWords('Schedules show up here once your Mac is back.', host)}</p>
      break
    default:
      mascot = 'worried'
      title = "Couldn't load your schedules."
      action = (
        <Button variant="outline" disabled={busy} onClick={retry}>
          Try again
        </Button>
      )
  }
  return (
    <div
      data-testid={`empty-${kind}`}
      className="mx-auto flex max-w-[420px] flex-col items-center gap-4 px-6 py-10 text-center"
    >
      <Mascot state={mascot} size={96} name={agent} decorative />
      <h2 className="m-0 font-display text-xl font-semibold">
        <Ticks text={title} />
      </h2>
      {body}
      {action}
    </div>
  )
}
