// Enabling (or disabling) a work integration: config.work.enabled changes through an owner-signed config.patch. The confirm
// dialog lists what leaves the work system and how long it is kept.
import { useState } from 'react'
import { TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/index.ts'
import { daysWord, useRelayLimits } from '../health/limits.ts'
import { NOT_CONNECTED_LINE, useWriteBlock } from '../settings/offline.ts'
import { connectionRefusal } from '../threads/manage/useThreadPatch.ts'
import type { Spec } from './data.ts'

export function useWorkGate() {
  const config = useTalos((s) => s.config)
  const enabled = config?.work.enabled ?? []
  return {
    label: config?.work.label ?? 'Work systems',
    note: config?.work.ask_note ?? 'Ask your IT team before connecting these.',
    retention: config?.work.retention ?? 'passthrough',
    enabled,
    isUnlocked: (spec: Pick<Spec, 'id' | 'category'>) => spec.category !== 'work' || enabled.includes(spec.id),
  }
}

export function WorkEnableDialog({
  spec,
  mode = 'enable',
  readOnly,
  onClose,
}: {
  spec: Spec
  mode?: 'enable' | 'disable'
  readOnly: boolean
  onClose: (changed: boolean) => void
}) {
  const client = useTalosClient()
  const block = useWriteBlock()
  const agent = useTalos((s) => s.config?.agent.name ?? 'Talos')
  const gate = useWorkGate()
  const { bufferDays } = useRelayLimits()
  const days = daysWord(bufferDays)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const next =
        mode === 'enable' ? [...new Set([...gate.enabled, spec.id])] : gate.enabled.filter((id) => id !== spec.id)
      await client.patchConfig({ work: { enabled: next } })
      onClose(true)
    } catch (e) {
      setError(
        connectionRefusal(e) ??
          (e instanceof TalosClientError && e.code === 'config_conflict'
            ? 'Your settings changed on another device. Close this and try again.'
            : e instanceof TalosClientError && e.code === 'mac_offline'
              ? e.message // not confirmed yet, in the client's words: the Mac may be fine and the link what dropped
              : 'That did not go through. Nothing was changed.'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent aria-describedby="work-enable-desc">
        <DialogTitle className="text-lg font-medium text-text">
          {mode === 'enable' ? `Turn on ${spec.name}?` : `Turn off ${spec.name}?`}
        </DialogTitle>
        <DialogDescription id="work-enable-desc" className="mt-2 space-y-2 text-sm text-text-2">
          {mode === 'enable' ? (
            <>
              <span className="block">{gate.note}</span>
              <span className="block">
                Titles, senders and short previews of matching messages leave {spec.name} and pass through Talos online
                to {agent} on your Mac.
              </span>
              <span className="block">
                {gate.retention === 'passthrough'
                  ? 'Passthrough: nothing is kept online once it reaches your Mac, and anything undelivered after an hour is dropped.'
                  : `Buffered: Talos online keeps events for up to ${days} until your Mac collects them.`}
              </span>
            </>
          ) : (
            <span className="block">New {spec.name} events will be refused. Existing connections stay saved.</span>
          )}
        </DialogDescription>
        {readOnly && block === 'link' ? <p className="mt-2 text-sm text-text-2">{NOT_CONNECTED_LINE}</p> : null}
        {error ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button disabled={busy || readOnly} onClick={confirm}>
            {readOnly && block !== 'link' ? 'Mac is offline' : mode === 'enable' ? 'Turn on' : 'Turn off'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
