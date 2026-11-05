// Settings -> Work systems: the words the app uses for them (`work.label`, `work.ask_note`) and whether their events are
// kept on the relay (`work.retention`). Wording saves with the button; retention changes what the relay holds, so it asks
// for the same passkey tap as turning a work system on (unless trust mode is on and the relay agrees).
import { useId, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { passkeyErrorCopy } from '../../lib/passkeyGate.ts'
import { withStepup } from '../../lib/stepup.ts'
import { Button, Input } from '../../ui/index.ts'
import { friendlyPatchError } from '../threads/manage/useThreadPatch.ts'

export function WorkWording({ readOnly }: { readOnly: boolean }) {
  const client = useTalosClient()
  const work = useTalos((s) => s.config?.work)
  const [label, setLabel] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const ids = { label: useId(), note: useId(), keep: useId() }
  if (!work) return null
  const shownLabel = label ?? work.label
  const shownNote = note ?? work.ask_note
  const dirty = shownLabel !== work.label || shownNote !== work.ask_note

  // Controls stay enabled while a save runs (a disabled control drops keyboard focus on some phones); a second save waits.
  const run = async (patch: Record<string, unknown>, tap: boolean) => {
    if (busy) return false
    setErr(null)
    setSaved(false)
    setBusy(true)
    try {
      if (tap)
        await withStepup(client, client.store.getState().config, 'config:work', (token) =>
          client.patchConfig({ work: patch }, token ? { stepupToken: token } : {}),
        )
      else await client.patchConfig({ work: patch })
      setSaved(true)
      return true
    } catch (e) {
      setErr(passkeyErrorCopy(e) ?? friendlyPatchError(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  const saveWords = async () => {
    const l = shownLabel.trim()
    if (!l) return setErr('The name can’t be empty.')
    if (await run({ label: l, ask_note: shownNote.trim() }, false)) {
      setLabel(null)
      setNote(null)
    }
  }
  return (
    <div className="flex flex-col gap-2" data-testid="work-wording">
      <h3 className="m-0 text-base font-medium">Wording and retention</h3>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void saveWords()
        }}
      >
        <label htmlFor={ids.label} className="text-sm font-medium">
          What to call work systems
        </label>
        <Input
          id={ids.label}
          value={shownLabel}
          maxLength={40}
          disabled={readOnly}
          onChange={(e) => setLabel(e.target.value)}
        />
        <label htmlFor={ids.note} className="text-sm font-medium">
          Note shown before connecting one
        </label>
        <Input
          id={ids.note}
          value={shownNote}
          maxLength={120}
          disabled={readOnly}
          onChange={(e) => setNote(e.target.value)}
        />
        <Button type="submit" variant="outline" aria-busy={busy} disabled={readOnly || !dirty}>
          Save wording
        </Button>
      </form>
      <label htmlFor={ids.keep} className="text-sm font-medium">
        Events from work systems
      </label>
      <select
        id={ids.keep}
        value={work.retention}
        disabled={readOnly}
        onChange={(e) => void run({ retention: e.target.value }, true)}
        className="min-h-11 rounded-button border border-line bg-surface px-3 text-text disabled:opacity-50"
      >
        <option value="passthrough">Pass through: nothing kept once delivered</option>
        <option value="buffer">Buffer: the relay holds them until your Mac collects them</option>
      </select>
      {saved && (
        <p role="status" className="m-0 text-sm">
          Saved.
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
