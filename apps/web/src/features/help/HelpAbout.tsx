// The live part of the About section: which build is running here, and an Ask button. Everything else on the page is static text.
import { PROTOCOL_VERSION } from '@talos-app/protocol'
import { useNavigate } from 'react-router'
import { useTalos } from '../../lib/client.ts'
import { detectShell } from '../../lib/native/detect.ts'
import { isNativeShell } from '../../lib/native.ts'
import { Button } from '../../ui/index.ts'
import { useSession } from '../auth/session.ts'
import { prefillComposer } from '../composer/composerStore.ts'
import { iosAppVersion, macAppVersion } from '../health/diagnostics.ts'
import { useHealthStatus } from '../health/useHealthStatus.ts'
import { ASK_DRAFT } from './content.ts'

export type Running = 'Mac app' | 'iPhone app' | 'Browser'

export function whereRunning(): Running {
  return detectShell() === 'desktop' ? 'Mac app' : isNativeShell() ? 'iPhone app' : 'Browser'
}

/** The build identifiers this page can see. The Mac app's own build number is in Mac settings → General; the page cannot read it. */
export function buildRows(input: {
  app: string
  running: Running
  userAgent: string | undefined
  relay: string | null
}): Array<{ label: string; value: string }> {
  const rows = [
    { label: 'App build', value: input.app },
    { label: 'Running in', value: input.running },
  ]
  if (input.running === 'Mac app') {
    rows.push({ label: 'Mac app version', value: macAppVersion(input.userAgent) ?? 'not reported (an older Mac app?)' })
  }
  if (input.running === 'iPhone app') {
    rows.push({ label: 'iPhone app', value: iosAppVersion(input.userAgent) ?? 'not reported (an older build?)' })
  }
  rows.push({ label: 'Protocol', value: `v${PROTOCOL_VERSION}` })
  if (input.relay) rows.push({ label: 'Server', value: input.relay })
  return rows
}

export function AboutBuild() {
  // Help is readable signed out. A signed-out reader gets plain text here and no requests: the server would only answer 401.
  const signedOut = useSession((s) => s.status) === 'anon'
  const { state, refresh } = useHealthStatus(undefined, !signedOut)
  const running = whereRunning()
  const relay = signedOut ? null : (state.status?.relay.version ?? null)
  const rows = buildRows({
    app: import.meta.env.VITE_APP_VERSION ?? '0.0.0',
    running,
    userAgent: globalThis.navigator?.userAgent,
    relay,
  })
  return (
    <div className="flex flex-col gap-2" data-testid="help-build">
      <h3 className="m-0 text-base font-medium">This copy of Talos</h3>
      <dl className="incised m-0 flex flex-col divide-y divide-line rounded-card bg-surface px-4 py-1 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3 py-2">
            <dt className="text-text-2">{r.label}</dt>
            <dd className="m-0 font-mono [overflow-wrap:anywhere]">{r.value}</dd>
          </div>
        ))}
      </dl>
      {running === 'Mac app' && (
        <p className="m-0 text-sm text-text-2">The Mac app&rsquo;s own build number is under Mac settings → General.</p>
      )}
      {signedOut && (
        <p data-testid="help-build-signedout" className="m-0 text-sm text-text-2">
          Sign in to see the server&rsquo;s version.
        </p>
      )}
      {!signedOut && state.phase === 'loading' && !relay && (
        <p role="status" data-testid="help-build-loading" className="m-0 text-sm text-text-2">
          Reading the server&rsquo;s version…
        </p>
      )}
      {!signedOut && state.phase === 'error' && !relay && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" data-testid="help-build-failed" className="m-0 text-sm text-danger">
            Couldn&rsquo;t read the server&rsquo;s version. Check your connection and that you are signed in.
          </p>
          <Button variant="outline" onClick={refresh}>
            Try again
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Opens a message to the agent in the default thread, with the search words in it, under any draft already there. The owner reads it and presses send.
 * It waits for the app's config, because that is what says which thread is the default; until then it says why it can't.
 */
export function AskAgent({ agent, query }: { agent: string; query: string }) {
  const nav = useNavigate()
  const thread = useTalos((s) => s.config?.default_thread)
  if (thread === undefined) {
    return (
      <p className="m-0 text-sm text-text-2" data-testid="help-ask-waiting">
        Ask works once this device is signed in and connected. Until then, search above or read the sections.
      </p>
    )
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        data-testid="help-ask"
        onClick={() => {
          // append: an unsent draft in that thread stays, and the question goes under it
          prefillComposer(thread, `${ASK_DRAFT}${query.trim()}`.trimEnd(), 'append')
          nav(`/t/${thread}`)
        }}
      >
        Ask {agent} about this
      </Button>
      <p className="m-0 text-sm text-text-2">
        Opens a message to {agent} in your default thread. You read it and press send.
      </p>
    </div>
  )
}
