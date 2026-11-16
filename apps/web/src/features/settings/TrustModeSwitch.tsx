// Settings -> Account: trust mode (docs/SECURITY.md "Trust mode"). Off is the default and costs nothing to go back to. Either way
// it goes to the Mac as an owner-signed config.patch, nothing else to confirm (owner ruling 2026-11-14). The agent cannot change it; the Mac's `talos-app trust on|off` still works.
import { trustOn } from '@talos-app/protocol'
import { useId, useState } from 'react'
import { TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { Switch } from '../../ui/index.ts'
import { connectionRefusal, friendlyPatchError } from '../threads/manage/useThreadPatch.ts'
import { NOT_CONNECTED_LINE, useWriteBlock } from './offline.ts'

const OLDER =
  'Your relay or your Mac is older than this setting. Update Talos, or turn it on at your Mac with: talos-app trust on'

export const TRUST_HELP_ON =
  'Your own messages run without a card unless they send as you, spend money or delete for good.'
export const TRUST_HELP_OFF =
  'Off: cards as usual. On: your own messages run without a card unless they send as you, spend money or delete for good.'

export function TrustModeSwitch() {
  const client = useTalosClient()
  const config = useTalos((s) => s.config)
  const block = useWriteBlock()
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
      await client.patchConfig({ trust_mode: next })
    } catch (e) {
      // the switch is driven by the saved config, so it is already back where it was
      setErr(
        connectionRefusal(e) ??
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
          disabled={block !== null}
          aria-busy={busy}
          aria-describedby={descId}
          onCheckedChange={(v) => void set(v)}
        />
      </div>
      <p id={descId} className="m-0 text-text-2">
        {on ? TRUST_HELP_ON : TRUST_HELP_OFF}
      </p>
      {block === 'mac' && <p className="m-0 text-text-2">Your Mac has to be online to change this.</p>}
      {block === 'link' && <p className="m-0 text-text-2">{NOT_CONNECTED_LINE}</p>}
      {err && (
        <p role="alert" className="m-0 text-danger">
          {err}
        </p>
      )}
    </div>
  )
}
