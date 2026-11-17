// Settings > Bug reports: the bug reporter itself, and where the relay sends a new report (`bug_webhook_url`, a Standard
// Webhooks call signed with the relay's BUG_WEBHOOK_SECRET). The address is the owner's: set here or at the Mac, never by the
// agent. The app never sees the address back, which may carry
// a token: it is told only the host it sends to (`bug_webhook_host`), so the field is write-only.
import { BUG_WEBHOOK_URL_RULE, type BugReportDestinationT, bugWebhookUrlOk } from '@talos-app/protocol'
import { useEffect, useId, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { Button } from '../../ui/index.ts'
import { openBugReport } from '../bugreport/store.ts'
import { connectionRefusal, friendlyPatchError } from '../threads/manage/useThreadPatch.ts'
import type { SectionProps } from './sections.tsx'

export const BUG_SETTINGS_TEXT = {
  title: 'Bug reports',
  report: 'Report a bug',
  reportHint: 'Takes a picture of this screen first, so you can mark what is wrong.',
  webhook: 'Send new reports to a webhook',
  webhookHint:
    'An https address that gets a signed note for each new report (Standard Webhooks). The address is kept on your relay and never shown again here.',
  on: (host: string) => `New reports go to ${host}.`,
  off: 'Off: reports go to your Mac (through your relay) and nowhere else.',
  team: 'New reports go to the Talos team, with the screenshot. This was set when your relay was deployed; an address of your own here takes its place.',
  unused: (host: string) =>
    `Off: an address (${host}) is saved, but your relay does not send to it (it has no signing secret, or it refuses the address). Reports go to your Mac (through your relay) and nowhere else.`,
  save: 'Save address',
  replace: 'Replace address',
  turnOff: 'Turn off',
  saved: 'Saved. Your Mac and relay will use it once they sync.',
  turnedOff: 'Address removed.',
  checking: 'Checking where reports go…',
  placeholder: 'https://hooks.example.com/…',
} as const

/**
 * The state line: the relay's own answer when it gave one; nothing claimed while it is being asked; and only when it could not
 * answer (an older relay has no such call) what the synced config says.
 */
function stateText(dest: BugReportDestinationT | 'asking' | 'unknown', host: string | undefined): string {
  if (dest === 'asking') return BUG_SETTINGS_TEXT.checking
  if (dest === 'unknown') return host ? BUG_SETTINGS_TEXT.on(host) : BUG_SETTINGS_TEXT.off
  if (dest.to === 'webhook') return BUG_SETTINGS_TEXT.on(dest.host)
  if (dest.to === 'team') return BUG_SETTINGS_TEXT.team
  return host ? BUG_SETTINGS_TEXT.unused(host) : BUG_SETTINGS_TEXT.off
}

export function BugReportsSection({ readOnly }: SectionProps) {
  const client = useTalosClient()
  const host = useTalos((s) => s.config?.bug_webhook_host)
  // What the relay really does (its environment decides too: the signing secret, a team inbox); asked again when the address changes
  const [dest, setDest] = useState<BugReportDestinationT | 'asking' | 'unknown'>('asking')
  useEffect(() => {
    let alive = true
    setDest('asking')
    void host
    ;(client.bugs ? client.bugs.destination() : Promise.reject(new Error('none'))).then(
      (d) => alive && setDest(d),
      () => alive && setDest('unknown'),
    )
    return () => {
      alive = false
    }
  }, [client, host])
  const [url, setUrl] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()
  const hint = useId()
  const save = async (value: string | null) => {
    if (busy) return
    setNote(null)
    if (value !== null && !bugWebhookUrlOk(value.trim())) return setNote({ ok: false, text: BUG_WEBHOOK_URL_RULE })
    setBusy(true)
    try {
      await client.patchConfig({ bug_webhook_url: value === null ? null : value.trim() })
      setUrl('')
      setNote({ ok: true, text: value === null ? BUG_SETTINGS_TEXT.turnedOff : BUG_SETTINGS_TEXT.saved })
    } catch (e) {
      setNote({ ok: false, text: connectionRefusal(e) ?? friendlyPatchError(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-labelledby="bug-reports" className="flex flex-col gap-4">
      <h2 id="bug-reports" className="m-0 text-base font-semibold">
        {BUG_SETTINGS_TEXT.title}
      </h2>
      <div className="flex flex-col items-start gap-1">
        <Button variant="outline" onClick={() => void openBugReport()} data-testid="settings-report-bug">
          {BUG_SETTINGS_TEXT.report}
        </Button>
        <span className="text-xs text-text-2">{BUG_SETTINGS_TEXT.reportHint}</span>
      </div>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void save(url)
        }}
      >
        <label htmlFor={id} className="block">
          {BUG_SETTINGS_TEXT.webhook}
        </label>
        <span id={hint} className="block text-xs text-text-2">
          {BUG_SETTINGS_TEXT.webhookHint}
        </span>
        <p className="m-0 text-sm" data-testid="bug-webhook-state">
          {stateText(dest, host)}
        </p>
        <input
          id={id}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={hint}
          placeholder={BUG_SETTINGS_TEXT.placeholder}
          value={url}
          disabled={readOnly}
          onChange={(e) => setUrl(e.target.value)}
          className="min-h-11 w-full max-w-md rounded-button border border-line bg-surface px-3 text-sm"
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={readOnly || url.trim() === ''} aria-busy={busy}>
            {host ? BUG_SETTINGS_TEXT.replace : BUG_SETTINGS_TEXT.save}
          </Button>
          {host && (
            <Button type="button" variant="outline" disabled={readOnly} onClick={() => void save(null)}>
              {BUG_SETTINGS_TEXT.turnOff}
            </Button>
          )}
        </div>
        {note && (
          <p
            role={note.ok ? 'status' : 'alert'}
            className={note.ok ? 'm-0 text-sm text-text-2' : 'm-0 text-sm text-danger'}
          >
            {note.text}
          </p>
        )}
      </form>
    </section>
  )
}
