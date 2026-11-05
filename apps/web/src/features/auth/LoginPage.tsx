import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useTalos } from '../../lib/client.ts'
import { HttpError } from '../../lib/http.ts'
import { inShell } from '../../lib/native/shell.ts'
import { useStorage } from '../../lib/storageContext.tsx'
import { resetStockTheme } from '../../lib/theme.ts'
import { countUnsent, discardUnsent } from '../../lib/unsent.ts'
import { Button } from '../../ui/index.ts'
import { Mascot } from '../../ui/Mascot.tsx'
import { HELP_PATH } from '../help/path.ts'
import { signInWithPasskey } from './passkeys.ts'
import { pendingWipe, retryPendingWipe } from './session.ts'

export function LoginPage() {
  const nav = useNavigate()
  const loc = useLocation()
  const agent = useTalos((s) => s.config?.agent.name) ?? 'Talos'
  const storage = useStorage()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Messages and voice notes the owner sent that no one has delivered yet stay on this device when a session merely ran
  // out of time. Only what this device's key can actually send is counted. A sign-out whose wipe did not finish is
  // retried here, and said out loud if it still fails.
  const [waiting, setWaiting] = useState(0)
  const [wipeFailed, setWipeFailed] = useState(false)
  const [discardError, setDiscardError] = useState(false)
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        if (pendingWipe() && !(await retryPendingWipe(storage))) {
          if (live) setWipeFailed(true)
          return
        }
        const { sendable } = await countUnsent(storage)
        if (live) setWaiting(sendable)
      } catch {}
    })()
    return () => {
      live = false
    }
  }, [storage])
  const discard = async () => {
    setDiscardError(false)
    try {
      await discardUnsent(storage)
      setWaiting(0)
    } catch {
      setDiscardError(true)
    }
  }
  // The iPhone shell cannot do passkeys in its web view: it signs in with a setup code from the Mac (WP-N0).
  const shell = inShell()
  const from = (loc.state as { from?: string } | null)?.from ?? '/'
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      await signInWithPasskey(storage)
      nav(from.startsWith('/') && !from.startsWith('//') ? from : '/', { replace: true })
    } catch (e) {
      const body = e instanceof HttpError ? (e.body as { error?: string } | null) : null
      setError(
        e instanceof Error && e.name === 'NotAllowedError'
          ? 'Sign-in was cancelled.'
          : body?.error === 'device_proof_required' || body?.error === 'device_proof_invalid'
            ? "This device couldn't prove its key. Run talos-app enroll on your Mac to set it up again."
            : "Couldn't sign in with a passkey.",
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-4">
      <div className="flex w-full max-w-[420px] flex-col items-center gap-4 incised rounded-card bg-surface p-7 text-center">
        <Mascot state={error ? 'worried' : 'pleased'} size={112} name={agent} decorative />
        <h1 className="m-0 font-display text-2xl font-semibold">{agent}</h1>
        {shell ? (
          <>
            <p className="m-0 text-text-2">
              This app signs in with a setup link from your Mac. Run <code>talos-app enroll</code> there, then paste the
              link here.
            </p>
            <Link to="/enroll" className="w-full">
              <Button className="w-full" tabIndex={-1}>
                Paste a setup link
              </Button>
            </Link>
          </>
        ) : (
          <Button className="w-full" onClick={() => void go()} disabled={busy}>
            Sign in with passkey
          </Button>
        )}
        {wipeFailed && (
          <p role="alert" className="m-0 text-danger">
            Some saved chats or unsent messages from your last session could not be removed from this device. Talos will
            not send them. It will try again each time you open it.
          </p>
        )}
        {waiting > 0 && (
          <div className="flex flex-col items-center gap-1">
            <p role="status" className="m-0 text-text-2">
              {waiting === 1 ? '1 unsent message is' : `${waiting} unsent messages are`} waiting on this device. They
              send once you sign in again.
            </p>
            <button
              type="button"
              onClick={() => void discard()}
              className="inline-flex min-h-11 items-center px-2 text-sm text-text-2 underline"
            >
              Discard
            </button>
            {discardError && (
              <p role="alert" className="m-0 text-danger">
                Couldn't discard them. They are still on this device.
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="m-0 text-danger">
            {error}
          </p>
        )}
        {!shell && (
          <Link to="/enroll" className="inline-flex min-h-11 items-center px-2 text-sm text-text-2 underline">
            Set up a new device
          </Link>
        )}
        <Link to={HELP_PATH} className="inline-flex min-h-11 items-center px-2 text-sm text-text-2 underline">
          Help
        </Link>
        <button
          type="button"
          onClick={resetStockTheme}
          className="inline-flex min-h-11 items-center px-2 text-sm text-text-2 underline"
        >
          Reset theme
        </button>
      </div>
    </main>
  )
}
