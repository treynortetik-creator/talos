// Settings > Memory folders: which folders of the agent folder the Memory screen's Notes show (owner, 2026-11-15; before
// this only `talos-app memory init` in a terminal could set them, and a new user saw nothing). Ticked folders are what Notes
// shows; Save sends the owner's signed choice and the Mac checks every name against its own listing. No confirm: it is the
// owner's own choice. A Mac that is offline means nothing was saved, and this says so.
import { MEMORY_ROOTS_FEATURE, MEMORY_ROOTS_WORDING } from '@talos-app/protocol'
import { useEffect, useState } from 'react'
import { TalosClientError, useTalosClient } from '../../lib/client.ts'
import type { MemoryFolders } from '../../lib/v2Client.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { Button } from '../../ui/index.ts'
import type { SectionProps } from './sections.tsx'

export const MEMORY_FOLDERS_TEXT = {
  title: 'Memory folders',
  intro: 'Pick the folders of your agent folder that Notes in Memory shows. Nothing else in the agent folder is shown.',
  loading: 'Asking your Mac…',
  offline: "Your Mac is offline, so the folders can't be listed or saved now.",
  notSaved: "Your Mac didn't get this, so nothing was saved. Try again when it's online.",
  updateMac: 'Update Talos on your Mac to pick Memory folders here.',
  save: 'Save',
  saving: 'Saving…',
  none: 'Your agent folder has no folders to show.',
  notes: (n: number) => `${n} ${n === 1 ? 'note' : 'notes'}`,
} as const

export function MemoryFoldersSection({ readOnly }: SectionProps) {
  const client = useTalosClient()
  const feature = useFeature(MEMORY_ROOTS_FEATURE)
  const [data, setData] = useState<MemoryFolders | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const mf = client.memoryFolders

  // a tick only for a folder that is listed: one the Mac keeps but cannot show is never sent back
  const take = (d: MemoryFolders) => {
    setData(d)
    setPicked(new Set(d.chosen.filter((n) => d.folders.some((f) => f.name === n))))
  }

  useEffect(() => {
    if (feature !== 'on' || !mf) return
    let alive = true
    mf.list().then(
      (d) => {
        if (!alive) return
        setData(d)
        setPicked(new Set(d.chosen.filter((n) => d.folders.some((f) => f.name === n))))
      },
      (e) =>
        alive &&
        setNote({
          text:
            e instanceof TalosClientError && e.code === 'mac_offline' ? MEMORY_FOLDERS_TEXT.offline : String(e.message),
          bad: true,
        }),
    )
    return () => {
      alive = false
    }
  }, [feature, mf])

  const shown = data ? data.chosen.filter((n) => data.folders.some((f) => f.name === n)) : []
  const changed = data !== null && (picked.size !== shown.length || shown.some((n) => !picked.has(n)))
  const save = async () => {
    if (!mf || !data) return
    setBusy(true)
    setNote(null)
    try {
      const d = await mf.set([...picked])
      take(d)
      setNote(
        d.error
          ? { text: d.error, bad: true }
          : { text: d.chosen.length ? MEMORY_ROOTS_WORDING.saved : MEMORY_ROOTS_WORDING.off, bad: false },
      )
    } catch (e) {
      setNote({
        text:
          e instanceof TalosClientError && e.code === 'mac_offline'
            ? MEMORY_FOLDERS_TEXT.notSaved
            : String((e as Error).message),
        bad: true,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="memory-folders" className="flex flex-col gap-3" data-testid="memory-folders">
      <h2 id="memory-folders" className="m-0 text-base font-semibold">
        {MEMORY_FOLDERS_TEXT.title}
      </h2>
      <p className="m-0 text-sm text-text-2">{MEMORY_FOLDERS_TEXT.intro}</p>
      {feature === 'off' || !mf ? (
        <p className="m-0 text-sm text-text-2">{MEMORY_FOLDERS_TEXT.updateMac}</p>
      ) : feature === 'needs_mac' && data === null ? (
        <p role="status" className="m-0 text-sm text-text-2">
          {MEMORY_FOLDERS_TEXT.offline}
        </p>
      ) : data === null ? (
        !note && (
          <p role="status" className="m-0 text-sm text-text-2">
            {MEMORY_FOLDERS_TEXT.loading}
          </p>
        )
      ) : data.folders.length === 0 ? (
        <p className="m-0 text-sm text-text-2">{data.error ?? MEMORY_FOLDERS_TEXT.none}</p>
      ) : (
        <>
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0" disabled={readOnly || busy}>
            <legend className="sr-only">{MEMORY_FOLDERS_TEXT.title}</legend>
            {data.folders.map((f) => (
              <label key={f.name} className="flex min-h-11 items-center gap-3 rounded-button px-2 hover:bg-surface-2">
                <input
                  type="checkbox"
                  className="size-5 accent-accent"
                  checked={picked.has(f.name)}
                  onChange={(e) =>
                    setPicked((p) => {
                      const next = new Set(p)
                      if (e.target.checked) next.add(f.name)
                      else next.delete(f.name)
                      return next
                    })
                  }
                />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="shrink-0 text-sm text-text-2">{MEMORY_FOLDERS_TEXT.notes(f.notes)}</span>
              </label>
            ))}
          </fieldset>
          <div>
            <Button onClick={() => void save()} disabled={readOnly || busy || !changed} className="min-h-11">
              {busy ? MEMORY_FOLDERS_TEXT.saving : MEMORY_FOLDERS_TEXT.save}
            </Button>
          </div>
        </>
      )}
      {note && (
        <p
          role={note.bad ? 'alert' : 'status'}
          className={note.bad ? 'm-0 text-sm text-danger' : 'm-0 text-sm text-ok'}
        >
          {note.text}
        </p>
      )}
    </section>
  )
}
