// Settings -> Notifications -> "iPhone notifications" (IOS-SPEC WP-I5). Only inside the iPhone app. It says what is true:
// Checking, Needs setup (and what is missing), Off, Blocked, On, or a failure with a way to retry.
import { useEffect } from 'react'
import { useTalosClient } from '../../lib/client.ts'
import type { Http } from '../../lib/http.ts'
import { nativeGrantSupported } from '../../lib/nativePush.ts'
import { Button } from '../../ui/index.ts'
import {
  disableNativePush,
  enableNativePush,
  type NativePushView,
  refreshNativePush,
  setNativeText,
  useNativePush,
} from './nativePush.ts'
import { sendNativeTest } from './push.ts'

const SETUP: Record<'build' | 'capability' | 'server', string> = {
  build:
    "This copy of the Talos app was built without push, so it can't receive notifications. Install the current Talos build from TestFlight or the App Store, then come back here.",
  capability:
    "This copy of the Talos app was built without the push capability, so it can't receive notifications. Install the current Talos build from TestFlight or the App Store, then come back here.",
  server: "Your Talos server doesn't have an Apple push key yet. Add the key, then come back here.",
}

export function statusText(v: NativePushView): string {
  switch (v.kind) {
    case 'checking':
      return 'Checking...'
    case 'needs_setup':
      return 'Needs setup'
    case 'off':
      return 'Off'
    case 'blocked':
      return 'Blocked'
    case 'on':
      return 'On'
    case 'error':
      return "Couldn't check"
    default:
      return ''
  }
}

export function NativePushRow({
  http,
  scope,
  onTest,
}: {
  http?: Http
  scope?: unknown
  onTest?: () => Promise<boolean>
}) {
  const client = useTalosClient()
  const { view, busy, note, rich, pendingRevoke } = useNativePush()
  // An older copy of the iPhone app cannot make the keys, so it has no text choice to offer or to describe.
  const canChooseText = nativeGrantSupported(scope ?? globalThis)
  const deps = { client, ...(http ? { http } : {}), ...(scope ? { scope } : {}) }
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh once per mount, not on every dependency object
  useEffect(() => {
    void refreshNativePush(deps)
    // Back from iOS Settings (Blocked -> allowed) or from sleep: read the truth again (review R12).
    const again = () => {
      if (document.visibilityState === 'visible') void refreshNativePush(deps)
    }
    document.addEventListener('visibilitychange', again)
    return () => document.removeEventListener('visibilitychange', again)
  }, [client])
  if (view.kind === 'hidden') return null
  const test = onTest ?? (() => sendNativeTest(http))
  return (
    <section className="flex flex-col gap-2" data-testid="native-push" aria-labelledby="native-push-h">
      <h3 id="native-push-h" className="m-0 text-base font-medium">
        iPhone notifications
      </h3>
      <p className="m-0 text-text-2" data-testid="native-push-status" aria-live="polite">
        {statusText(view)}
      </p>
      {view.kind === 'needs_setup' && (
        <p className="m-0 text-sm text-text-2" data-testid="native-push-detail">
          {SETUP[view.why]}
        </p>
      )}
      {view.kind === 'blocked' && (
        <p className="m-0 text-sm text-text-2">Turn notifications back on for Talos in the iPhone Settings app.</p>
      )}
      {(view.kind === 'off' || view.kind === 'on' || view.kind === 'blocked') && (
        <p className="m-0 text-sm text-text-2" data-testid="native-push-names">
          Show thread names changes browser notifications. On iPhone, Apple only ever sees General and Inbox by name;
          every other thread reads "a thread", because Apple can read what these notifications say.
          {canChooseText &&
            ' If you turn on message text, the words inside the seal name the thread as far as this setting allows.'}
        </p>
      )}
      {view.kind === 'on' && rich !== null && (
        <p className="m-0 text-sm text-text-2" data-testid="native-push-text">
          {rich
            ? 'Replies and cards show their words on this phone, with Reply and Approve buttons for simple ones. Apple only gets a fixed phrase; the words travel sealed and only this phone can open them. Your Talos server can still read them.'
            : 'Notifications show a fixed phrase. Message text and the Reply and Approve buttons are off for this phone.'}
        </p>
      )}
      {view.kind === 'on' && pendingRevoke && (
        <p role="status" className="m-0 text-sm text-text-2" data-testid="native-push-pending">
          Message text is off on this phone, but your Talos server has not confirmed it yet. Talos asks again each time
          you open the app. Until then your server can still seal text for this phone; the phone no longer holds the key
          to open it.
        </p>
      )}
      {view.kind === 'off' && canChooseText && (
        <p className="m-0 text-sm text-text-2" data-testid="native-push-text-intro">
          Notifications start as a fixed phrase. After you turn them on, you can choose to show message text and the
          Reply and Approve buttons on this phone. Apple still gets only a fixed phrase. Your Talos server can read your
          messages, as it can today.
        </p>
      )}
      {view.kind === 'off' && !canChooseText && (
        <p className="m-0 text-sm text-text-2" data-testid="native-push-text-intro">
          Notifications show a fixed phrase. This copy of the app cannot show message text or the Reply and Approve
          buttons.
        </p>
      )}
      {(view.kind === 'off' || view.kind === 'on') && (
        <p className="m-0 text-sm text-text-2" data-testid="native-push-double">
          If the Home Screen app on this phone also has notifications on, you get two. Turn them off there.
        </p>
      )}
      {view.kind === 'error' && (
        <p role="alert" className="m-0 text-sm text-text-2" data-testid="native-push-detail">
          {view.message}
        </p>
      )}
      {view.kind === 'off' && (
        <Button onClick={() => void enableNativePush(deps)} disabled={busy} className="self-start">
          Turn on notifications
        </Button>
      )}
      {view.kind === 'on' && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={async () => {
              useNativePush.setState({ note: (await test()) ? 'Test sent.' : "Couldn't send the test." })
            }}
          >
            Send a test notification
          </Button>
          {rich !== null && (
            <Button variant="outline" disabled={busy} onClick={() => void setNativeText(deps, !rich)}>
              {rich ? 'Use a fixed phrase only' : 'Show message text'}
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={() => void disableNativePush(deps)}>
            Turn off
          </Button>
        </div>
      )}
      {(view.kind === 'error' || view.kind === 'needs_setup' || view.kind === 'blocked') && (
        <Button variant="outline" disabled={busy} onClick={() => void refreshNativePush(deps)} className="self-start">
          Check again
        </Button>
      )}
      {note && (
        <p role="status" className="m-0 text-sm text-text-2">
          {note}
        </p>
      )}
    </section>
  )
}
