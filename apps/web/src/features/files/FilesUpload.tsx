// Upload into the thread's folder from the Files pane or the phone's Files sheet (files-put/1). The file goes up the media
// path (POST /api/media, as an attachment does), then the Mac is asked to put it in a folder of the thread's folder: the
// folder of the file on view, else the thread's folder itself; a drop on a folder row puts it in that folder. The Mac never
// overwrites: a taken name comes back as "name (2).ext", and the line says so.
import { FILES_PUT_FEATURE, FILES_PUT_MAX_BYTES } from '@talos-app/protocol'
import { type DragEvent, useEffect, useRef, useState } from 'react'
import { TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { cn } from '../../ui/cn.ts'
import type { FilesBrowser } from './useFilesBrowser.ts'

export const UPLOAD_TEXT = {
  button: (where: string) => (where === 'this folder' ? 'Upload' : `Upload to ${where}`),
  label: (where: string) => `Upload a file to ${where}`,
  busy: 'One upload at a time: wait for this one to finish.',
  folderDrop: 'Folders can’t be uploaded: drop the files inside it.',
  relay: "The upload didn't reach the relay. Try again.",
  some: (failed: string[]) => `Not put: ${failed.join('; ')}`,
  root: 'this folder',
  sending: (name: string) => `Uploading ${name}…`,
  done: (name: string, where: string) => `Put ${name} in ${where}.`,
  renamed: (asked: string, got: string, where: string) => `${asked} was taken, so it is ${got} in ${where}.`,
  tooLarge: (name: string) => `${name} is larger than 50 MB.`,
  failed: "Your Mac didn't take that file. Try again.",
  offline: "Your Mac is offline, so files can't be put in its folders.",
} as const

const where = (dir: string) => (dir === '' ? UPLOAD_TEXT.root : dir)
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

export type FilesUploader = {
  on: boolean
  busy: boolean
  /** The folder an Upload click puts files in: the one holding the file on view, else the thread's folder. */
  target: string
  upload(files: FileList | File[], dir: string): Promise<void>
  /** Handlers for a drop target that puts files in `dir`. */
  dropOn(dir: string): {
    onDragOver(e: DragEvent): void
    onDragLeave(e: DragEvent): void
    onDrop(e: DragEvent): void
  }
  over: string | null
  line: { text: string; tone: 'ok' | 'error' } | null
}

export function useFilesUpload(b: FilesBrowser): FilesUploader {
  const client = useTalosClient()
  const put = client.files?.put
  const on = useFeature(FILES_PUT_FEATURE) !== 'off' && Boolean(put)
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState<string | null>(null)
  const [line, setLine] = useState<FilesUploader['line']>(null)
  const thread = b.threadId
  const target = b.viewing ? dirOf(b.viewing.path) : ''
  // the uploader belongs to one thread: a switch starts it over, and an upload still running for the old one says nothing here
  const live = useRef(thread)
  live.current = thread
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a thread switch only
  useEffect(() => {
    setLine(null)
    setOver(null)
  }, [thread])

  const upload = async (list: FileList | File[], dir: string) => {
    if (!put) return
    if (busy) {
      setLine({ text: UPLOAD_TEXT.busy, tone: 'error' })
      return
    }
    if (!macOnline) {
      setLine({ text: UPLOAD_TEXT.offline, tone: 'error' })
      return
    }
    setBusy(true)
    const failed: string[] = []
    let last: string | null = null
    const here = () => live.current === thread
    try {
      for (const file of [...list]) {
        if (file.size > FILES_PUT_MAX_BYTES) {
          failed.push(UPLOAD_TEXT.tooLarge(file.name))
          continue
        }
        if (here()) setLine({ text: UPLOAD_TEXT.sending(file.name), tone: 'ok' })
        let ref: Awaited<ReturnType<typeof client.uploadMedia>>
        try {
          ref = await client.uploadMedia(file, { name: file.name })
        } catch (e) {
          failed.push(`${file.name}: ${e instanceof TalosClientError && e.message ? e.message : UPLOAD_TEXT.relay}`)
          continue
        }
        try {
          const got = await put(thread, dir, file.name, ref)
          last =
            got.name === file.name
              ? UPLOAD_TEXT.done(got.name, where(dir))
              : UPLOAD_TEXT.renamed(file.name, got.name, where(dir))
        } catch (e) {
          failed.push(`${file.name}: ${e instanceof TalosClientError && e.message ? e.message : UPLOAD_TEXT.failed}`)
        }
        // listed again either way: an answer that never came may still mean the file is there
        if (here()) b.reload(dir)
      }
    } finally {
      setBusy(false)
      if (here()) {
        if (failed.length === 1 && last === null) setLine({ text: failed[0] as string, tone: 'error' })
        else if (failed.length > 0) setLine({ text: UPLOAD_TEXT.some(failed), tone: 'error' })
        else if (last) setLine({ text: last, tone: 'ok' })
      }
    }
  }
  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files')
  const dropOn = (dir: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!on || !hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      setOver(dir)
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
      setOver((o) => (o === dir ? null : o))
    },
    onDrop: (e: DragEvent) => {
      if (!on || !hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      setOver(null)
      // a dropped folder shows up as a file with no type; the browser can say what it really is
      const items = [...e.dataTransfer.items]
      if (items.some((i) => i.webkitGetAsEntry?.()?.isDirectory)) {
        setLine({ text: UPLOAD_TEXT.folderDrop, tone: 'error' })
        return
      }
      void upload(e.dataTransfer.files, dir)
    },
  })
  return { on, busy, target, upload, dropOn, over, line }
}

/** The Upload button and the line that says what happened. */
export function UploadBar({ u, layout }: { u: FilesUploader; layout: 'pane' | 'sheet' }) {
  const input = useRef<HTMLInputElement>(null)
  if (!u.on) return null
  return (
    <div className="flex flex-col gap-1">
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="files-upload-input"
        onChange={(e) => {
          const files = e.target.files
          if (files && files.length > 0) void u.upload(files, u.target)
          e.target.value = ''
        }}
      />
      <button
        type="button"
        disabled={u.busy}
        aria-label={UPLOAD_TEXT.label(where(u.target))}
        onClick={() => input.current?.click()}
        className={cn(
          'inline-flex w-full items-center justify-center rounded-button border border-line px-2.5 text-sm font-medium text-text hover:bg-surface-2 disabled:opacity-60',
          layout === 'pane' ? 'min-h-8' : 'min-h-11',
        )}
      >
        <span className="min-w-0 truncate">{UPLOAD_TEXT.button(where(u.target))}</span>
      </button>
      {u.line && (
        <p
          role={u.line.tone === 'error' ? 'alert' : 'status'}
          data-testid="files-upload-line"
          className={cn('m-0 text-xs', u.line.tone === 'error' ? 'text-danger' : 'text-text-2')}
        >
          {u.line.text}
        </p>
      )}
    </div>
  )
}
