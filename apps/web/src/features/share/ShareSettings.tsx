// Settings -> Share from other apps (docs/V2-FEATURES.md V4.4). Share links are device-bound tokens for an iOS Shortcut
// (iPhone cannot add web apps to the share sheet, as of October 2026). What a token sends arrives in Inbox as something to
// look at, not as an instruction. A relay feature: works with the Mac offline.
import { SHARE_FEATURE, type ShareScopeT, type ShareTokenT } from '@talos-app/protocol'
import { useCallback, useEffect, useState } from 'react'
import { useTalos } from '../../lib/client.ts'
import { ago } from '../../lib/format.ts'
import { createHttp, type Http } from '../../lib/http.ts'
import { clearShareToken, setShareToken, shareSheetAvailable } from '../../lib/nativeShare.ts'
import { getPlatform } from '../../lib/platform.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { Button, Switch } from '../../ui/index.ts'
import { useAgentName } from '../threads/useThreads.ts'

const defaultHttp = createHttp()

export function shortcutRecipe(origin: string, agent: string, files: boolean): string[] {
  return [
    `Receive Text, URLs, Safari web pages${files ? ', Images and Files' : ''} from Share Sheet.`,
    `(optional) Ask for Input: "Note for ${agent}".`,
    `Get Contents of URL: ${origin}/api/share — Method POST, Header Authorization = Bearer <your secret>, Request Body Form: text = Shortcut Input (as text)${files ? ', file = Shortcut Input' : ''}, note = Provided Input.`,
    `Show Notification: "Sent to ${agent}".`,
  ]
}

export function bookmarklet(origin: string): string {
  return `javascript:location='${origin}/share?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)`
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      variant="outline"
      aria-label={`Copy ${label}`}
      onClick={() => {
        void getPlatform()
          .clipboard.write(text)
          .then((ok) => {
            setDone(ok)
            if (ok) setTimeout(() => setDone(false), 2000)
          })
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </Button>
  )
}

const scopesLabel = (s: ShareScopeT[]) => (s.includes('files') ? 'Text, photos and files' : 'Text and links')

export const SHEET_LABEL = 'iPhone share sheet'

export function ShareTokensPanel({
  http = defaultHttp,
  currentDeviceId,
  nativeScope = globalThis,
}: {
  http?: Http
  currentDeviceId?: string | null
  /** Where the iPhone shell's globals live. Tests pass a fake `window.Capacitor`. */
  nativeScope?: unknown
}) {
  const agent = useAgentName()
  const [tokens, setTokens] = useState<ShareTokenT[] | null>(null)
  const [label, setLabel] = useState('')
  // On by default: a text-only link made the iPhone share sheet refuse a photo only after the note was typed (audit D50).
  const [files, setFiles] = useState(true)
  const [created, setCreated] = useState<{ secret: string; files: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const origin = typeof location === 'undefined' ? 'https://your-relay' : location.origin
  const shell = shareSheetAvailable(nativeScope)
  // The relay is the source of truth (page storage can be cleared; the Keychain copy cannot be read back). The switch
  // reads on while this device has a live "iPhone share sheet" link. Until the device id is known the switch cannot say,
  // so every link with that label is replaced rather than risk a second live one.
  const isSheet = (t: ShareTokenT) => t.label === SHEET_LABEL
  const sheetTokens = (tokens ?? []).filter(
    (t) => isSheet(t) && (currentDeviceId ? t.device_id === currentDeviceId : true),
  )
  const sheetOn = currentDeviceId != null && sheetTokens.some((t) => t.device_id === currentDeviceId)
  // A link made before photos defaulted to on (audit D50) has no `files` scope, and the relay cannot change a token's
  // scopes. The share sheet then refuses every photo while the "Allow photos and files" switch below reads on. So say it.
  const sheetTextOnly = sheetOn && sheetTokens.some((t) => !t.scopes.includes('files'))

  const load = useCallback(async () => {
    try {
      setTokens(await http.get<ShareTokenT[]>('/api/share/tokens'))
    } catch {
      setError("Couldn't load your share links.")
      setTokens([])
    }
  }, [http])
  useEffect(() => void load(), [load])

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const scopes: ShareScopeT[] = files ? ['text', 'files'] : ['text']
      const r = await http.json<{ token: ShareTokenT; secret: string }>('POST', '/api/share/tokens', {
        label: label.trim(),
        scopes,
      })
      setCreated({ secret: r.secret, files })
      setLabel('')
      await load()
    } catch (e) {
      const status = (e as { status?: number }).status
      setError(
        status === 409
          ? 'You have 10 share links. Revoke one first.'
          : status === 403
            ? 'Open Talos on a device your Mac has confirmed to make a share link.'
            : "Couldn't make that share link.",
      )
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (t: ShareTokenT) => {
    setError(null)
    try {
      await http.json('DELETE', `/api/share/tokens/${t.id}`)
      await load()
    } catch {
      setError("Couldn't revoke that share link.")
    }
  }

  // iPhone shell: one switch makes (or revokes) the token the share extension uses. Never two live tokens for this
  // device: every older "iPhone share sheet" token is revoked first, and turning it off revokes on the relay AND clears it
  // from the Keychain.
  const toggleSheet = async (on: boolean, withFiles: boolean = files) => {
    setBusy(true)
    setError(null)
    try {
      if (!on) {
        // Fail closed: take the secret off the phone FIRST, so a relay that is unreachable cannot leave the share
        // extension holding a live token.
        await clearShareToken(nativeScope)
        for (const t of sheetTokens) await http.json('DELETE', `/api/share/tokens/${t.id}`)
      } else {
        for (const t of sheetTokens) await http.json('DELETE', `/api/share/tokens/${t.id}`)
        const scopes: ShareScopeT[] = withFiles ? ['text', 'files'] : ['text']
        const r = await http.json<{ token: ShareTokenT; secret: string }>('POST', '/api/share/tokens', {
          label: SHEET_LABEL,
          scopes,
        })
        if (!(await setShareToken(r.secret, scopes, nativeScope))) {
          await http.json('DELETE', `/api/share/tokens/${r.token.id}`)
          throw new Error('native')
        }
      }
    } catch (e) {
      const status = (e as { status?: number }).status
      setError(
        status === 403
          ? 'Open Talos on a device your Mac has confirmed to use the share sheet.'
          : on
            ? "Couldn't turn on the iPhone share sheet. Try again."
            : 'The share sheet is off on this phone, but the link could not be revoked on the relay. Revoke it below.',
      )
    } finally {
      await load()
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="share-h" className="flex flex-col gap-4">
      <h2 id="share-h" className="m-0 font-display text-xl font-semibold">
        Share from other apps
      </h2>
      <p className="m-0 text-sm text-text-2">
        In the Talos iPhone app, turn on the share sheet switch below. In Safari or the Home Screen app, an iPhone can't
        add Talos to the share sheet, so use a Shortcut instead. What you share arrives in Inbox as something to look
        at, not as an instruction. On Android and desktop Chrome, install Talos and pick it in the share sheet.
      </p>
      {error && (
        <p role="alert" className="m-0 text-danger">
          {error}
        </p>
      )}

      {shell && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-3">
            <span id="share-sheet-l" className="text-sm font-medium">
              Use the iPhone share sheet
            </span>
            <Switch
              aria-labelledby="share-sheet-l"
              checked={sheetOn}
              disabled={busy || tokens === null}
              onCheckedChange={(on) => void toggleSheet(on)}
            />
          </div>
          <p className="m-0 text-sm text-text-2">
            Adds Talos to the Share button in other apps. Photos and files follow the "Allow photos and files" switch
            below when you turn this on.
          </p>
          {sheetTextOnly && (
            <div
              data-testid="sheet-files-off"
              className="flex items-center justify-between gap-3 rounded-card border border-warn p-3 text-sm text-warn"
            >
              <span className="min-w-0 flex-1">The share sheet link on this phone only sends text and links.</span>
              <Button variant="outline" disabled={busy} onClick={() => void toggleSheet(true, true)}>
                Allow photos and files
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {tokens === null && <p className="m-0 text-text-2">Loading…</p>}
        {tokens?.length === 0 && <p className="m-0 text-text-2">No share links yet.</p>}
        {tokens?.map((t) => (
          <div
            key={t.id}
            data-testid={`share-token-${t.id}`}
            className="flex items-center justify-between gap-3 border-b border-line py-2"
          >
            <div className="min-w-0">
              <p className="m-0 font-medium">{t.label}</p>
              <p className="m-0 text-sm text-text-2">
                {t.device_id === currentDeviceId ? 'This device' : 'Another device'} · {scopesLabel(t.scopes)} ·{' '}
                {t.last_used_at
                  ? `used ${ago(t.last_used_at)}${t.last_used_net ? ` from ${t.last_used_net}` : ''}`
                  : 'never used'}
              </p>
            </div>
            <Button variant="danger" aria-label={`Revoke ${t.label}`} onClick={() => void revoke(t)}>
              Revoke
            </Button>
          </div>
        ))}
      </div>

      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <label className="flex flex-col gap-1 text-sm font-medium">
          Name
          <input
            value={label}
            maxLength={40}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="My iPhone"
            className="min-h-11 rounded-button border border-line bg-surface px-3 text-md text-text"
          />
        </label>
        <div className="flex items-center justify-between gap-3">
          <span id="share-files-l" className="text-sm font-medium">
            Allow photos and files
          </span>
          <Switch aria-labelledby="share-files-l" checked={files} onCheckedChange={setFiles} />
        </div>
        <Button type="submit" disabled={busy || label.trim() === ''}>
          Create a share link
        </Button>
      </form>

      {created && (
        <div
          data-testid="share-recipe"
          className="flex flex-col gap-3 rounded-card border border-line bg-surface-2 p-3 text-sm"
        >
          <p className="m-0 font-semibold">Copy this now. It is shown once.</p>
          <div className="flex items-center gap-2">
            <code data-testid="share-secret" className="min-w-0 flex-1 break-all font-mono text-xs">
              {created.secret}
            </code>
            <CopyButton text={created.secret} label="secret" />
          </div>
          <p className="m-0">Build this Shortcut in the Shortcuts app:</p>
          <ol className="m-0 flex list-decimal flex-col gap-1 pl-5">
            {shortcutRecipe(origin, agent, created.files).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">{`${origin}/api/share`}</code>
            <CopyButton text={`${origin}/api/share`} label="URL" />
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">{`Bearer ${created.secret}`}</code>
            <CopyButton text={`Bearer ${created.secret}`} label="header value" />
          </div>
          <p className="m-0 text-text-2">
            The secret is the key. Anyone who has it can put items in your Inbox until you revoke it.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-base font-medium">Bookmarklet</h3>
        <p className="m-0 text-sm text-text-2">
          On any browser: save this as a bookmark. Tapping it sends the current page to the share page here.
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all font-mono text-xs">{bookmarklet(origin)}</code>
          <CopyButton text={bookmarklet(origin)} label="bookmarklet" />
        </div>
      </div>
    </section>
  )
}

/** The Settings section: Share links need the relay to list `share/1` (it does not need the Mac). */
export function ShareSettingsSection(_props: { readOnly: boolean }) {
  const state = useFeature(SHARE_FEATURE)
  const deviceId = useTalos((s) => s.deviceId)
  if (state === 'off')
    return (
      <section className="flex flex-col gap-2">
        <h2 className="m-0 font-display text-xl font-semibold">Share from other apps</h2>
        <p className="m-0 text-text-2">This relay doesn't have sharing turned on.</p>
      </section>
    )
  return <ShareTokensPanel currentDeviceId={deviceId} />
}
