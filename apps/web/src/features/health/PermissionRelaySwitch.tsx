// Settings -> Health: the permission relay switch (`permission_relay`). On, Claude Code's tool prompts reach the phone as
// approval cards. The Mac reads it when the agent starts, so the line says a restart is needed. Saved On while the running
// session did not declare it (the Mac's health beat says so) reads "On after restart"; the restart itself is the Mac menu bar's. Turning it on or off asks
// for a passkey tap (`config:session`) unless trust mode is on and the relay agrees.
import { useId, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { passkeyErrorCopy } from '../../lib/passkeyGate.ts'
import { withStepup } from '../../lib/stepup.ts'
import { Switch } from '../../ui/index.ts'
import { friendlyPatchError } from '../threads/manage/useThreadPatch.ts'

/** `declared`: what the running session told Claude Code at start (the Mac's health beat). The Health page owns the one poller and passes it down; undefined = an older bridge that does not say. */
export function PermissionRelaySwitch({ declared }: { declared?: boolean | undefined } = {}) {
  const client = useTalosClient()
  const relay = useTalos((s) => s.config?.permission_relay)
  const online = useTalos((s) => s.connection === 'online')
  // Claude Code only sends prompts to a session that declared the relay when it started: On, but not for this session yet.
  const afterRestart = relay === true && declared === false
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const id = useId()
  if (relay === undefined) return null
  const set = async (on: boolean) => {
    if (busy) return // never disabled while saving: a disabled control drops keyboard focus on some phones
    setErr(null)
    setSaved(false)
    setBusy(true)
    try {
      await withStepup(client, client.store.getState().config, 'config:session', (token) =>
        client.patchConfig({ permission_relay: on }, token ? { stepupToken: token } : {}),
      )
      setSaved(true)
    } catch (e) {
      setErr(passkeyErrorCopy(e) ?? friendlyPatchError(e)) // the switch is driven by the saved config, so it goes back
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-1" data-testid="permission-relay-state">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          Tool prompts as approval cards: {relay ? (afterRestart ? 'On after restart' : 'On') : 'Off'}
        </label>
        <Switch id={id} checked={relay} disabled={!online} aria-busy={busy} onCheckedChange={(v) => void set(v)} />
      </div>
      <p className="m-0 text-sm text-text-2">
        {!online
          ? 'Your Mac is not connected, so this can’t change now.'
          : afterRestart
            ? 'The running session started before this was turned on, so prompts still go elsewhere. On your Mac, choose Restart session in the Talos menu bar, or quit and restart Claude Code in your terminal.'
            : 'A change takes effect when the agent restarts.'}
      </p>
      {saved && (
        <p role="status" className="m-0 text-sm">
          Saved. Restart the agent for it to take effect.
        </p>
      )}
      {err && (
        <p role="alert" className="m-0 text-sm text-danger">
          {err}
        </p>
      )}
    </div>
  )
}
