// Settings → Agent: Set up my agent. One tap starts or resumes the setup interview in the Setup thread and opens it.
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { TalosClientError, useTalosClient } from '../../lib/client.ts'
import { Button } from '../../ui/index.ts'
import { friendlyPatchError } from '../threads/manage/useThreadPatch.ts'
import { SETUP_THREAD_ID, startSetup } from './setupThread.ts'

export const SETUP_OFFLINE_TEXT = "Your Mac is offline. Setup needs your agent running; try again when it's back."

export function SetupAgent({ macOnline }: { macOnline: boolean }) {
  const client = useTalosClient()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    if (busy) return // not disabled: a disabled control drops keyboard focus on some phones
    setError(null)
    if (!macOnline) {
      setError(SETUP_OFFLINE_TEXT)
      return
    }
    setBusy(true)
    try {
      await startSetup(client)
      navigate(`/t/${SETUP_THREAD_ID}`)
    } catch (e) {
      setError(
        e instanceof TalosClientError && e.code === 'mac_offline'
          ? SETUP_OFFLINE_TEXT
          : friendlyPatchError(e, 'threads'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <p className="m-0 text-sm text-text-2">
        Optional. Your agent already works. It asks a few short questions in the Setup thread, one wave at a time, and
        you can stop after any of them. Tap again later to pick up where you left off.
      </p>
      <Button onClick={start} aria-busy={busy} data-testid="set-up-my-agent">
        Set up my agent
      </Button>
      {error ? (
        <p role="alert" className="m-0 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
