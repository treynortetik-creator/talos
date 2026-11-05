// The signed /share page (docs/V2-FEATURES.md V4.3, V4.4). It opens from the Android/Chromium share sheet (through the
// service worker), from the bookmarklet, or from a `?url=&title=&text=` link. The shared material sits read-only in a
// "Shared content" box; the owner types a note ("What should {agent} do?") and picks a thread. [Send] signs a `message`
// whose `text` is the note ONLY and whose `share_content` is the material, so the shared words can never pass as the
// owner's instruction (V4.7).
import { newId, SHARE_FEATURE } from '@talos-app/protocol'
import { useEffect, useId, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { Button, Textarea } from '../../ui/index.ts'
import { useAgentName, useVisibleThreads } from '../threads/useThreads.ts'
import { buildShareFrame, materialFromParams, normalizeMaterial, type SharedMaterial } from './material.ts'
import { SharedContentBox } from './SharedContentBox.tsx'
import { idbPendingStore, type PendingStore, startPendingSweep } from './shareTarget.ts'

type Loaded = { state: 'loading' } | { state: 'ready'; material: SharedMaterial; expired: boolean }

export function ShareScreen({ store }: { store?: PendingStore } = {}) {
  const [params] = useSearchParams()
  const client = useTalosClient()
  const noteId = useId()
  const shareOn = useFeature(SHARE_FEATURE) === 'on'
  const nav = useNavigate()
  const agent = useAgentName()
  const threads = useVisibleThreads()
  const defaultThread = useTalos((s) => s.config?.default_thread ?? 'general')
  const pendingStore = useMemo(() => store ?? idbPendingStore(), [store])
  const pendingId = params.get('pending')
  const retry = params.has('retry')
  const fromQuery = useMemo(() => materialFromParams(params), [params])

  const [loaded, setLoaded] = useState<Loaded>(
    pendingId ? { state: 'loading' } : { state: 'ready', material: fromQuery, expired: false },
  )
  const [note, setNote] = useState('')
  const [thread, setThread] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => startPendingSweep(pendingStore), [pendingStore])

  useEffect(() => {
    if (!pendingId) {
      setLoaded({ state: 'ready', material: fromQuery, expired: false })
      return
    }
    let live = true
    pendingStore
      .get(pendingId)
      .then((p) => {
        if (!live) return
        if (!p) return setLoaded({ state: 'ready', material: fromQuery, expired: true })
        const { id: _id, at: _at, ...rest } = p
        setLoaded({ state: 'ready', material: { ...fromQuery, ...rest }, expired: false })
      })
      .catch(() => live && setLoaded({ state: 'ready', material: fromQuery, expired: true }))
    return () => {
      live = false
    }
  }, [pendingId, pendingStore, fromQuery])

  if (loaded.state === 'loading') return <section className="p-6 text-text-2">Loading…</section>
  const { material, expired } = loaded
  const norm = normalizeMaterial(material)
  const target =
    thread ?? (threads.some((t) => t.id === defaultThread) ? defaultThread : (threads[0]?.id ?? defaultThread))

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      if (!client.sendOwnerFrame) throw new TalosClientError('internal', 'This app cannot send shares yet.')
      const attachments = []
      for (const f of material.files) attachments.push(await client.uploadMedia(f.blob, { name: f.name }))
      await client.sendOwnerFrame(
        buildShareFrame({
          threadId: target,
          note: note.trim(),
          content: norm.content,
          attachments,
          clientMsgId: newId('m'),
        }),
      )
      if (pendingId) await pendingStore.delete(pendingId).catch(() => {})
      nav(`/t/${target}`, { replace: true })
    } catch (e) {
      setError(
        e instanceof TalosClientError ? e.message : "Couldn't send that. Your shared content is still here; try again.",
      )
      setBusy(false)
    }
  }

  return (
    <section
      data-testid="share-screen"
      className="mx-auto flex h-full min-h-0 w-full max-w-xl flex-col gap-4 overflow-y-auto p-4 sm:p-6"
    >
      <h1 className="m-0 font-display text-2xl font-semibold">Share to {agent}</h1>
      {retry && (
        <p role="status" className="m-0 rounded-card border border-line bg-surface-2 p-3 text-sm">
          That share didn't make it through. Share it again from the other app, or use the link in Settings to share
          from this page.
        </p>
      )}
      {expired && (
        <p role="status" className="m-0 rounded-card border border-line bg-surface-2 p-3 text-sm">
          That shared item has expired (shares are kept for 24 hours). Share it again.
        </p>
      )}
      {norm.empty ? (
        <div className="flex flex-col gap-2 text-text-2">
          <p className="m-0">Nothing to send yet.</p>
          <p className="m-0 text-sm">
            Use Share in another app and pick Talos (Android and desktop Chrome), or use the bookmarklet or the iPhone
            Shortcut from Settings → Share from other apps.
          </p>
        </div>
      ) : (
        <>
          <SharedContentBox content={norm.content} files={material.files} />
          {norm.notes.map((n) => (
            <p key={n} role="status" className="m-0 text-sm text-text-2">
              {n}
            </p>
          ))}
          {!shareOn && (
            <p role="status" data-testid="share-off" className="m-0 text-text-2">
              Sharing isn't turned on for this server, so this can't be sent.
            </p>
          )}
          <div className="flex flex-col gap-1 text-sm font-medium">
            <label htmlFor={noteId}>What should {agent} do?</label>
            <Textarea
              id={noteId}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Summarise it, file it, reply…"
            />
          </div>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Send to
            <select
              value={target}
              onChange={(e) => setThread(e.target.value)}
              className="min-h-11 rounded-button border border-line bg-surface px-3 text-md text-text"
            >
              {threads.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <p role="alert" className="m-0 text-danger">
              {error}
            </p>
          )}
          {shareOn && (
            <Button onClick={() => void send()} disabled={busy}>
              {busy ? 'Sending…' : 'Send'}
            </Button>
          )}
        </>
      )}
    </section>
  )
}
