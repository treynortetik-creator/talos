// Settings -> Account: "Always allowed" (always-allow.ts). The send kinds the owner lets go out without a card, added by the
// "Always allow" button on a card (or by the agent when he asks). Each has Remove, and Remove all empties the list. Every
// change writes the WHOLE list as an ordinary owner-signed config.patch (an RFC 7386 patch replaces an array).
// Offered only to a bridge that says it reads the list (ALWAYS_ALLOW_FEATURE): an older one would take the patch and ignore it.
import { ALWAYS_ALLOW_FEATURE, type AlwaysAllowEntryT, type SendKind } from '@talos-app/protocol'
import { useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { placeWords, useHost } from '../../lib/hostWords.ts'
import { Button } from '../../ui/index.ts'
import { friendlyPatchError } from '../threads/manage/useThreadPatch.ts'
import { NOT_CONNECTED_LINE, useWriteBlock } from './offline.ts'

export const ALWAYS_ALLOWED_TITLE = 'Always allowed'
/** What each kind's row says (the card button's words, without "Always allow"). */
export const ALWAYS_ALLOWED_KIND: Record<SendKind, string> = {
  email: 'Emails',
  message: 'Messages',
  deploy: 'Deploys',
  publish: 'Publishing',
  purchase: 'Purchases',
  push: 'Pushing code',
}
export const ALWAYS_ALLOWED_EMPTY = 'Cards for sends always ask. Tap “Always allow” on a card to add its kind here.'
export const ALWAYS_ALLOWED_HELP =
  'These go out without a card. You still get a quiet line in the thread (no notification); passes within 10 minutes fold into one line.'

function addedOn(at: string | undefined, timeZone: string | undefined): string | null {
  if (!at) return null
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return null
  try {
    return d.toLocaleDateString(undefined, { dateStyle: 'medium', ...(timeZone ? { timeZone } : {}) })
  } catch {
    return d.toLocaleDateString(undefined, { dateStyle: 'medium' })
  }
}

export function AlwaysAllowedSection() {
  const client = useTalosClient()
  const offered = useTalos((s) => s.presence.features?.includes(ALWAYS_ALLOW_FEATURE) ?? false)
  const config = useTalos((s) => s.config)
  const block = useWriteBlock()
  const host = useHost()
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!offered || !config) return null
  // a config without the key (an older one) reads as empty, like the schema's default
  const list: AlwaysAllowEntryT[] = config.always_allow ?? []
  // `drop`: the kind to remove, or null for all. The list is read from the store when the patch is built, so it always goes
  // with the same config the patch's base_rev is read from (a sync landing after this render can never pair with an old list)
  const save = async (drop: string | null) => {
    const saved = client.store.getState().config?.always_allow ?? []
    const next: AlwaysAllowEntryT[] = drop === null ? [] : saved.filter((x) => x.kind !== drop)
    if (busy || block !== null) return // never disabled while saving: a disabled control drops keyboard focus on some phones
    setErr(null)
    setBusy(true)
    try {
      await client.patchConfig({ always_allow: next })
    } catch (e) {
      // the list follows the saved config, so it is already back where it was
      setErr(friendlyPatchError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-1" data-testid="always-allowed">
      <h3 className="m-0 mb-1 text-base font-medium">{ALWAYS_ALLOWED_TITLE}</h3>
      {list.length === 0 ? (
        <p className="m-0 text-text-2">{ALWAYS_ALLOWED_EMPTY}</p>
      ) : (
        <>
          <p className="m-0 text-text-2">{ALWAYS_ALLOWED_HELP}</p>
          <ul className="m-0 list-none p-0">
            {list.map((e) => {
              const name = Object.hasOwn(ALWAYS_ALLOWED_KIND, e.kind) ? ALWAYS_ALLOWED_KIND[e.kind] : e.kind
              const on = addedOn(e.added_at, config.timezone)
              return (
                <li
                  key={e.kind}
                  data-kind={e.kind}
                  className="flex min-h-11 items-center justify-between gap-3 border-b border-line py-2"
                >
                  <span className="flex flex-col">
                    <span className="text-base">{name}</span>
                    {on && <span className="text-xs text-text-2">Added {on}</span>}
                  </span>
                  <Button
                    variant="outline"
                    disabled={block !== null}
                    aria-busy={busy}
                    aria-label={`Remove ${name.toLowerCase()}`}
                    onClick={() => void save(e.kind)}
                  >
                    Remove
                  </Button>
                </li>
              )
            })}
          </ul>
          <div className="mt-1">
            <Button variant="outline" disabled={block !== null} aria-busy={busy} onClick={() => void save(null)}>
              Remove all
            </Button>
          </div>
        </>
      )}
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
