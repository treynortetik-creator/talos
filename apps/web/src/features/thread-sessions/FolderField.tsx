// The Folder field of a thread's own session: the real folder in words, a box to type one, Choose… (the Mac's own open panel
// inside the Mac app, the in-app browser elsewhere) and the last five folders as chips. Every way of choosing ends in `save`,
// the same owner-signed thread patch as typing, so the Mac still checks that the folder exists and may be used.
import { AbsolutePath, dialogVisibleText, FOLDERS_FEATURE } from '@talos-app/protocol'
import { useState } from 'react'
import { canPickNative, pickFolderNative } from '../../lib/native/folderPick.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { Button, Input } from '../../ui/index.ts'
import { FolderBrowser } from './FolderBrowser.tsx'
import { expandTilde, FOLDER_TEXT, loadRecent, saveRecent, tildePath, useFolderInfo, withRecent } from './folders.ts'

type Props = {
  /** The id the label points at. */
  id: string
  /** The saved folder (`session_opts.cwd`), or '' for the agent folder. */
  cwd: string
  locked: boolean
  /** Saves a folder (null clears it); true once the Mac took it. */
  save: (cwd: string | null) => Promise<boolean>
  /** A problem in words under the controls, or null to clear it. */
  problem: (text: string | null) => void
}

export function FolderField({ id, cwd, locked, save, problem }: Props) {
  const info = useFolderInfo()
  // 'needs_mac' (the Mac is away right now, but it has told us it can list folders) keeps the button, greyed out
  const listed = useFeature(FOLDERS_FEATURE) !== 'off'
  const native = canPickNative()
  const [typed, setTyped] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [recent, setRecent] = useState(loadRecent)
  const home = info.home
  const shown = cwd ? tildePath(cwd, home ?? '') : ''
  const agentShown = info.agentDir ? tildePath(info.agentDir, home ?? '') : null

  const choose = async (path: string): Promise<boolean> => {
    problem(null)
    const ok = await save(path)
    if (ok) {
      const next = withRecent(recent, path)
      setRecent(next)
      saveRecent(next)
      setBrowsing(false)
    }
    return ok
  }
  const commit = async () => {
    const v = (typed ?? shown).trim()
    if (v === shown) return setTyped(null)
    // saved or refused, the box goes back to the saved value (the Mac's words for a refusal show under the controls)
    if (v === '') {
      await save(null)
      return setTyped(null)
    }
    const full = expandTilde(v, home)
    if (full === null) return problem(FOLDER_TEXT.noHome)
    if (!AbsolutePath.safeParse(full).success) return problem(FOLDER_TEXT.badPath)
    await choose(full)
    setTyped(null)
  }
  const openChooser = async () => {
    problem(null)
    if (native) {
      const picked = await pickFolderNative(home)
      if (picked.why === 'not_now') return problem(FOLDER_TEXT.notNow)
      if (picked.why === 'bad_name') return problem(FOLDER_TEXT.badName)
      if (picked.path) await choose(picked.path)
      return
    }
    setBrowsing(true)
  }
  return (
    <div className="flex flex-col gap-1 text-xs text-text-2" data-testid="folder-field">
      <label htmlFor={id}>{FOLDER_TEXT.label}</label>
      <p className="m-0 text-sm text-text" data-testid="folder-current">
        {cwd
          ? FOLDER_TEXT.current(dialogVisibleText(shown), false)
          : FOLDER_TEXT.current(agentShown && dialogVisibleText(agentShown), true)}
      </p>
      <div className="flex gap-2">
        <Input
          id={id}
          value={typed ?? shown}
          disabled={locked}
          placeholder={agentShown ?? FOLDER_TEXT.placeholderUnknown}
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => {
            problem(null)
            setTyped(e.target.value)
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit()
          }}
        />
        {(listed || native) && (
          <Button variant="outline" disabled={locked} onClick={() => void openChooser()}>
            {FOLDER_TEXT.choose}
          </Button>
        )}
      </div>
      {browsing && <FolderBrowser onUse={(p) => void choose(p)} onCancel={() => setBrowsing(false)} />}
      {recent.length > 0 && (
        <fieldset className="m-0 flex flex-wrap gap-1 border-0 p-0" data-testid="recent-folders">
          <legend className="sr-only">{FOLDER_TEXT.recent}</legend>
          {recent.map((p) => (
            <Button
              key={p}
              variant="outline"
              className="max-w-full truncate px-3 font-normal"
              disabled={locked}
              onClick={() => void choose(p)}
            >
              {dialogVisibleText(tildePath(p, home ?? ''))}
            </Button>
          ))}
        </fieldset>
      )}
      <span>{FOLDER_TEXT.hint}</span>
    </div>
  )
}
