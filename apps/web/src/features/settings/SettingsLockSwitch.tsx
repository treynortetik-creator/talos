// "Lock Talos settings" (settings on request, the owner's ruling 2026-11-14): off, the agent makes a setting change you ask
// for and tells you how to undo it; on, it only proposes and you approve each change on a card. An ordinary owner-signed
// config.patch either way. The agent may turn it on, never off (the bridge refuses that). Offered only to a bridge
// that says it reads the key (SETTINGS_LOCK_FEATURE): an older one would take the patch and ignore it.
import { SETTINGS_LOCK_FEATURE } from '@talos-app/protocol'
import { useId, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { placeWords, useHost } from '../../lib/hostWords.ts'
import { Switch } from '../../ui/index.ts'
import { friendlyPatchError } from '../threads/manage/useThreadPatch.ts'
import { NOT_CONNECTED_LINE, useWriteBlock } from './offline.ts'

/** The exact label: the bridge's undo lines say "turn Lock Talos settings off in Settings". */
export const SETTINGS_LOCK_LABEL = 'Lock Talos settings'
export const SETTINGS_LOCK_HELP =
  'Off: when you ask your agent to change a setting, it makes the change and tells you how to undo it. On: it only proposes, and you approve each change on a card.'

export function SettingsLockSwitch() {
  const id = useId()
  const descId = useId()
  const client = useTalosClient()
  const offered = useTalos((s) => s.presence.features?.includes(SETTINGS_LOCK_FEATURE) ?? false)
  const config = useTalos((s) => s.config)
  const block = useWriteBlock()
  const host = useHost()
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!offered || !config) return null
  // a config without the key (an older one) reads as off, like the schema's default
  const locked = config.settings_lock === true
  const set = async (on: boolean) => {
    if (busy) return // never disabled while saving: a disabled control drops keyboard focus on some phones
    setErr(null)
    setBusy(true)
    try {
      await client.patchConfig({ settings_lock: on })
    } catch (e) {
      // the switch follows the saved config, so it is already back where it was
      setErr(friendlyPatchError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-1" data-testid="settings-lock">
      <h3 className="m-0 mb-1 text-base font-medium">Settings changes</h3>
      <div className="flex min-h-11 items-center justify-between gap-3">
        <label htmlFor={id} className="text-base font-medium">
          {SETTINGS_LOCK_LABEL}
        </label>
        <Switch
          id={id}
          checked={locked}
          disabled={block !== null}
          aria-busy={busy}
          aria-describedby={descId}
          onCheckedChange={(v) => void set(v)}
        />
      </div>
      <p id={descId} className="m-0 text-text-2">
        {SETTINGS_LOCK_HELP}
      </p>
      {block === 'mac' && (
        <p className="m-0 text-text-2">{placeWords('Your Mac has to be online to change this.', host)}</p>
      )}
      {block === 'link' && <p className="m-0 text-text-2">{NOT_CONNECTED_LINE}</p>}
      {err && (
        <p role="alert" className="m-0 text-danger">
          {err}
        </p>
      )}
    </div>
  )
}
