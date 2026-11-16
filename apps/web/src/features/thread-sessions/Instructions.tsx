// The thread's instructions (AGENTS.md in its own folder), in its settings. Shown for a thread with its own session, on a
// Mac that answers `agents_md.*` (agents-md/1). Claude Code loads AGENTS.md beside CLAUDE.md in thread sessions, so a save
// shapes the thread's next sessions. Loaded on Edit, not each time the sheet opens. A save goes over the file it was loaded
// from only: when the file changed meanwhile (the agent may edit its own instructions) the Mac refuses and the owner reloads.
// A change made outside Settings is shown as a diff against the last save from here, never refused.
import { AGENTS_MD_FEATURE, AGENTS_MD_WORDING, type ThreadT } from '@talos-app/protocol'
import { useId, useState } from 'react'
import { TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { Button, Textarea } from '../../ui/index.ts'

export const INSTRUCTIONS_TEXT = {
  title: 'Instructions',
  about: "AGENTS.md in this thread's folder. Its sessions read it when they start.",
  edit: 'Edit AGENTS.md',
  none: 'No AGENTS.md yet. What you write here becomes this thread’s AGENTS.md.',
  noFolder: 'Pick a folder for this thread’s session to give it its own instructions.',
  saved: 'Saved. The thread’s next session reads it.',
  reload: 'Reload',
  save: 'Save instructions',
  close: 'Close',
  outside: 'Changed outside Settings since your last save here. Save to keep it as it is now.',
  kept: 'Your text is kept. The file on your Mac is now:',
  viewDiff: 'View the diff',
  failed: "Your Mac didn't answer. Try again.",
} as const

type Loaded = { sha: string | null; text: string; outsideDiff?: string; crlf: boolean }

/** A textarea turns CRLF into LF, so a file written with CRLF gets it back on save instead of being rewritten whole. */
const withEndings = (text: string, crlf: boolean) => (crlf ? text.replace(/\r?\n/g, '\r\n') : text)
const shown = (text: string) => text.replace(/\r\n/g, '\n')

export function Instructions({ thread }: { thread: ThreadT }) {
  const am = useTalosClient().agentsMd
  const on = useFeature(AGENTS_MD_FEATURE) !== 'off'
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const id = useId()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'error'; stale?: boolean } | null>(null)
  const [tooLarge, setTooLarge] = useState(false)
  if (!am || !on || thread.session !== 'dedicated') return null
  const hasFolder = typeof thread.session_opts?.cwd === 'string' && thread.session_opts.cwd !== ''

  const say = (e: unknown, stale = false) =>
    setNote({
      text: e instanceof TalosClientError && e.message ? e.message : INSTRUCTIONS_TEXT.failed,
      tone: 'error',
      stale,
    })
  /** `keepDraft`: after a refused save, the owner's text stays and the Mac's is shown beside it. */
  const load = async (keepDraft = false) => {
    setBusy(true)
    setNote(null)
    try {
      const f = await am.read(thread.id)
      setTooLarge(f.tooLarge)
      if (f.tooLarge) setLoaded(null)
      else {
        const text = f.text ?? ''
        const dirty = keepDraft && loaded !== null && draft !== shown(loaded.text)
        setLoaded({
          sha: f.sha,
          text,
          crlf: text.includes('\r\n'),
          ...(f.outsideDiff ? { outsideDiff: f.outsideDiff } : {}),
        })
        if (dirty) setNote({ text: INSTRUCTIONS_TEXT.kept, tone: 'ok' })
        else setDraft(shown(text))
      }
    } catch (e) {
      say(e)
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    if (!loaded) return
    setBusy(true)
    setNote(null)
    try {
      const f = await am.write(thread.id, withEndings(draft, loaded.crlf), loaded.sha)
      setLoaded({ sha: f.sha, text: f.text ?? draft, crlf: loaded.crlf })
      setNote({ text: INSTRUCTIONS_TEXT.saved, tone: 'ok' })
    } catch (e) {
      say(e, e instanceof TalosClientError && e.code === 'stale')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-2 border-t border-line px-2 pt-2" aria-labelledby={`${id}-t`} data-testid="instructions">
      <h3 id={`${id}-t`} className="m-0 text-sm font-medium">
        {INSTRUCTIONS_TEXT.title}
      </h3>
      <p className="m-0 text-xs text-text-2">{INSTRUCTIONS_TEXT.about}</p>
      {!hasFolder ? (
        <p className="m-0 pt-1 text-xs text-text-2" data-testid="instructions-no-folder">
          {INSTRUCTIONS_TEXT.noFolder}
        </p>
      ) : tooLarge ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <p className="m-0 text-xs text-text-2">{AGENTS_MD_WORDING.tooLarge}</p>
          <Button variant="ghost" disabled={!macOnline || busy} onClick={() => void load()}>
            {INSTRUCTIONS_TEXT.reload}
          </Button>
        </div>
      ) : !loaded ? (
        <div className="pt-1">
          <Button variant="ghost" disabled={!macOnline || busy} onClick={() => void load()}>
            {INSTRUCTIONS_TEXT.edit}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 pt-1">
          {loaded.outsideDiff && (
            <div className="rounded-button border border-line p-2 text-xs" data-testid="instructions-outside">
              <p className="m-0">{INSTRUCTIONS_TEXT.outside}</p>
              <details>
                <summary className="min-h-11 cursor-pointer content-center">{INSTRUCTIONS_TEXT.viewDiff}</summary>
                <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
                  {loaded.outsideDiff}
                </pre>
              </details>
            </div>
          )}
          {note?.text === INSTRUCTIONS_TEXT.kept && draft !== shown(loaded.text) && (
            <pre
              className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-button border border-line p-2 font-mono text-xs"
              data-testid="instructions-mac-text"
            >
              {shown(loaded.text)}
            </pre>
          )}
          {loaded.sha === null && draft === '' && <p className="m-0 text-xs text-text-2">{INSTRUCTIONS_TEXT.none}</p>}
          <label htmlFor={`${id}-md`} className="sr-only">
            AGENTS.md
          </label>
          <Textarea
            id={`${id}-md`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={12}
            spellCheck={false}
            className="font-mono text-sm"
            data-testid="instructions-text"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              // unchanged text can still be saved over a change made outside Settings, to keep it as the new baseline
              disabled={!macOnline || busy || (draft === shown(loaded.text) && !loaded.outsideDiff)}
              onClick={() => void save()}
              data-testid="instructions-save"
            >
              {INSTRUCTIONS_TEXT.save}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setLoaded(null)
                setNote(null)
              }}
            >
              {INSTRUCTIONS_TEXT.close}
            </Button>
          </div>
        </div>
      )}
      {note && (
        <p
          role={note.tone === 'error' ? 'alert' : 'status'}
          className={note.tone === 'error' ? 'm-0 pt-1 text-xs text-danger' : 'm-0 pt-1 text-xs text-text-2'}
          data-testid="instructions-note"
        >
          {note.text}{' '}
          {note.stale && (
            <Button variant="ghost" disabled={busy} onClick={() => void load(true)}>
              {INSTRUCTIONS_TEXT.reload}
            </Button>
          )}
        </p>
      )}
    </section>
  )
}
