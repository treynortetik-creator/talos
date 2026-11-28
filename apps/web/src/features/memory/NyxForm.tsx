// The one field: "Nyx address". https only, checked here and again where it is saved (the Mac's config and the Talos server).
// Talos keeps only the address and holds no Nyx credentials: [Connect] saves it and opens Nyx's own sign-in.
import { NYX_URL_PROBLEM, nyxSignInUrl, parseNyxUrl } from '@talos-app/protocol'
import { useId, useState } from 'react'
import { useTalosClient } from '../../lib/client.ts'
import { getPlatform } from '../../lib/platform.ts'
import { Button, Input } from '../../ui/index.ts'
import type { WriteBlock } from '../settings/offline.ts'
import { connectionRefusal, friendlyPatchError } from '../threads/manage/useThreadPatch.ts'
import { NYX_TEXT } from './nyxText.ts'

export function NyxForm({
  initial,
  block,
  onCancel,
  onSaved,
}: {
  initial: string
  /** Why the address cannot be saved now (this device or the Mac is not connected), or null. */
  block: WriteBlock
  onCancel?: () => void
  /** The sign-in page is opened as a best effort; the screen always shows the link too, since a blocked tab can't be told. */
  onSaved: (r: { signIn: string }) => void
}) {
  const client = useTalosClient()
  const id = useId()
  const hint = useId()
  const err = useId()
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (busy || block !== null) return
    const typed = value.trim()
    const url = parseNyxUrl(typed)
    if (url === null) return setError(NYX_URL_PROBLEM)
    setError(null)
    setBusy(true)
    try {
      await client.patchConfig({ memory: { nyx_url: url.href } })
    } catch (e) {
      setBusy(false)
      return setError(connectionRefusal(e) ?? friendlyPatchError(e))
    }
    setBusy(false)
    const signIn = nyxSignInUrl(url.href) as string
    getPlatform().openExternal(signIn)
    onSaved({ signIn })
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-2"
      data-testid="nyx-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label htmlFor={id} className="font-medium">
        {NYX_TEXT.addressLabel}
      </label>
      <span id={hint} className="text-sm text-text-2">
        {NYX_TEXT.addressHint}
      </span>
      <Input
        id={id}
        type="text"
        inputMode="url"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="https://nyx.example.com"
        aria-describedby={error ? `${hint} ${err}` : hint}
        aria-invalid={error ? true : undefined}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        data-testid="nyx-address"
      />
      {block !== null && (
        <p role="status" className="m-0 text-sm text-text-2" data-testid="nyx-blocked">
          {block === 'mac' ? NYX_TEXT.macOffline : NYX_TEXT.notConnected}
        </p>
      )}
      {error && (
        <p id={err} role="alert" className="m-0 text-sm text-danger" data-testid="nyx-error">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" aria-busy={busy} disabled={busy || block !== null} data-testid="nyx-connect">
          {busy ? NYX_TEXT.saving : NYX_TEXT.connect}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            {NYX_TEXT.cancel}
          </Button>
        )}
      </div>
    </form>
  )
}
