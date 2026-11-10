// The in-app folder browser (web and iPhone; the Mac app uses its own open panel). It asks the Mac for the NAMES of the folders
// in one folder at a time (`fs.list`), starting at home, with breadcrumbs, dot-folders hidden unless asked, and "Use this
// folder" for the level on screen. Nothing is saved here: the choice goes back to the Folder field, which saves it through the
// same owner-signed thread patch as a typed path. A name with a hidden or direction-changing character is shown with the
// character spelled out (dialogVisibleText), never as it would draw.
import { dialogVisibleText, FOLDER_WORDING } from '@talos-app/protocol'
import { useEffect, useId, useRef, useState } from 'react'
import { TalosClientError, useTalosClient } from '../../lib/client.ts'
import type { FolderListing } from '../../lib/v2Client.ts'
import { Button } from '../../ui/index.ts'
import { FOLDER_TEXT } from './folders.ts'

const joinPath = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`

/** `~` and one crumb for each folder below home on the way to `path`, each with the full path it goes to. */
export function crumbs(path: string, home: string): Array<{ label: string; path: string }> {
  const h = home.replace(/\/+$/, '')
  const out = [{ label: '~', path: h }]
  if (path === h || !path.startsWith(`${h}/`)) return out
  let cur = h
  for (const part of path.slice(h.length).split('/').filter(Boolean)) {
    cur = joinPath(cur, part)
    out.push({ label: part, path: cur })
  }
  return out
}

export function FolderBrowser({ onUse, onCancel }: { onUse: (path: string) => void; onCancel: () => void }) {
  const folders = useTalosClient().folders
  const hiddenId = useId()
  const [path, setPath] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [home, setHome] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const turn = useRef(0)

  useEffect(() => {
    if (!folders) return
    const mine = ++turn.current
    const stale = () => mine !== turn.current
    const fail = (e: unknown) => {
      if (stale()) return
      setListing(null)
      setErr(e instanceof TalosClientError && e.message ? e.message : FOLDER_WORDING.refused)
    }
    setErr(null)
    if (path === null) {
      // the first look: where home is. The browser starts there.
      folders.list(null, false).then((r) => {
        if (stale()) return
        setHome(r.home)
        setPath(r.home)
      }, fail)
      return
    }
    setListing(null)
    folders.list(path, hidden).then((r) => {
      if (!stale()) setListing(r)
    }, fail)
  }, [folders, path, hidden])

  // the folder asked for, which is what gets saved; the answer's own `path` is never used for that
  const here = listing ? path : null
  return (
    <div
      className="mt-1 flex flex-col gap-2 rounded-button border border-line bg-surface-2 p-2"
      data-testid="folder-browser"
    >
      {home && path && (
        <nav aria-label={FOLDER_TEXT.pathLabel} className="flex flex-wrap items-center gap-x-1 text-sm">
          {crumbs(path, home).map((c, i, all) => (
            <span key={c.path} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden="true">/</span>}
              <Button
                variant="ghost"
                className="min-h-11 px-2"
                aria-current={i === all.length - 1 ? 'location' : undefined}
                onClick={() => setPath(c.path)}
              >
                {dialogVisibleText(c.label)}
              </Button>
            </span>
          ))}
        </nav>
      )}
      <div className="max-h-56 overflow-y-auto" aria-live="polite">
        {err && (
          <p role="alert" className="m-0 p-2 text-xs text-danger">
            {err}
          </p>
        )}
        {!err && !listing && <p className="m-0 p-2 text-xs text-text-2">{FOLDER_TEXT.loading}</p>}
        {listing && listing.entries.length === 0 && <p className="m-0 p-2 text-xs text-text-2">{FOLDER_TEXT.empty}</p>}
        <ul className="m-0 flex list-none flex-col p-0">
          {listing?.entries.map((name) => (
            <li key={name}>
              <Button
                variant="ghost"
                className="w-full justify-start px-2 text-left font-normal"
                data-testid="folder-entry"
                onClick={() => setPath(joinPath(path ?? '/', name))}
              >
                {dialogVisibleText(name)}
              </Button>
            </li>
          ))}
        </ul>
        {listing && listing.more > 0 && (
          <p className="m-0 p-2 text-xs text-text-2">{FOLDER_WORDING.hiddenCount(listing.more)}</p>
        )}
      </div>
      <label htmlFor={hiddenId} className="flex min-h-11 items-center gap-2 text-sm">
        <input id={hiddenId} type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
        {FOLDER_TEXT.showHidden}
      </label>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!here} onClick={() => here && onUse(here)}>
          {FOLDER_TEXT.useThis}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          {FOLDER_TEXT.cancel}
        </Button>
      </div>
    </div>
  )
}
