// Settings -> Account: trust mode (docs/SECURITY.md "Trust mode"). Off is the default and costs nothing to go back to. Turning
// it on asks for the passkey (the session step-up, tapped here every time: trust mode itself never skips it) and goes to the
// Mac as an owner-signed config.patch. The agent cannot change it; the Mac's `talos-app trust on|off` still works.
import { trustOn } from '@talos-app/protocol'
import { useId, useState } from 'react'
import { TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { passkeyErrorCopy } from '../../lib/passkeyGate.ts'
import { Switch } from '../../ui/index.ts'
import { friendlyPatchError } from '../threads/manage/useThreadPatch.ts'

const OLDER =
  'Your relay or your Mac is older than this setting. Update Talos, or turn it on at your Mac with: talos-app trust on'

export function TrustModeSwitch() {
  const client = useTalosClient()
  const config = useTalos((s) => s.config)
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const id = useId()
  const descId = useId()
  if (!config) return null
  const on = trustOn(config)
  const set = async (next: boolean) => {
    if (busy) return // never disabled while saving: a disabled control drops keyboard focus on some phones
    setErr(null)
    setBusy(true)
    try {
      // Off needs no passkey. On always does, whatever this app believes about trust mode: the relay decides, and it
      // does not trust a copy of the config that may be stale.
      const token = next ? await client.stepup('config:session') : undefined
      await client.patchConfig({ trust_mode: next }, token ? { stepupToken: token } : {})
    } catch (e) {
      // the switch is driven by the saved config, so it is already back where it was
      setErr(
        passkeyErrorCopy(e) ??
          (e instanceof TalosClientError && e.code === 'config_field_forbidden' ? OLDER : friendlyPatchError(e)),
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-1" data-testid="trust-mode-state">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <label htmlFor={id} className="text-base font-medium">
          Trust mode: {on ? 'On' : 'Off'}
        </label>
        <Switch
          id={id}
          checked={on}
          disabled={!macOnline}
          aria-busy={busy}
          aria-describedby={descId}
          onCheckedChange={(v) => void set(v)}
        />
      </div>
      <p id={descId} className="m-0 text-text-2">
        {on
          ? 'Your own messages run without a card or a passkey unless they send as you, spend money or delete for good. Turning it off needs no passkey.'
          : 'Off: cards and passkeys as usual. On: your own messages run without a card or a passkey unless they send as you, spend money or delete for good. Turning it on asks for your passkey.'}
      </p>
      {!macOnline && <p className="m-0 text-text-2">Your Mac has to be online to change this.</p>}
      {err && (
        <p role="alert" className="m-0 text-danger">
          {err}
        </p>
      )}
    </div>
  )
}
