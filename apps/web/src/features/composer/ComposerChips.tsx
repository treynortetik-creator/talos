// The attachment chips above the box, and the two effects that keep the list tidy.
import { type Dispatch, type MutableRefObject, type RefObject, type SetStateAction, useEffect, useState } from 'react'
import type { TalosClient } from '../../lib/client.ts'
import { IconClose } from '../../ui/icons.tsx'
import { type Chip, removeChip, uploadChip } from './composerStore.ts'
import { isTooBigNote } from './uploadError.ts'
import type { Note } from './useComposerSend.ts'

export function useChipUpkeep(o: {
  chips: Chip[]
  chipsRef: RefObject<HTMLUListElement | null>
  leftNote: MutableRefObject<boolean>
  setNote: Dispatch<SetStateAction<Note | null>>
}) {
  const { chips, chipsRef, leftNote, setNote } = o
  // The chip list scrolls while the keyboard is up (app.css caps it then): a new or failed chip is brought into view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chips changing is the trigger
  useEffect(() => {
    const ul = chipsRef.current
    if (ul) ul.scrollTop = ul.scrollHeight
  }, [chips])
  // The "didn't upload" note belongs to the chips it names: once none of them is left it goes too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: leftNote and setNote are stable; the list is kept as it was
  useEffect(() => {
    if (leftNote.current && !chips.some((c) => c.state === 'error')) {
      leftNote.current = false
      setNote(null)
    }
  }, [chips])
}

/** Larger images get no thumbnail: decoding a phone photo whole for a 32 px picture costs tens of MB. */
const THUMB_MAX_BYTES = 8 * 1024 * 1024

/**
 * A small picture of an image attachment, from its own bytes (an object URL, let go when the chip goes). None for a large
 * image, and none when the browser cannot draw the type (HEIC outside Safari): the name is always there.
 */
function ChipThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    let u: string | null = null
    try {
      u = URL.createObjectURL(file)
    } catch {
      // no object URLs here (an old engine, a test without them): the chip shows its name only
    }
    setUrl(u)
    return () => {
      if (u) URL.revokeObjectURL(u)
    }
  }, [file])
  if (!url || broken) return null
  return (
    <img
      src={url}
      alt=""
      onError={() => setBroken(true)}
      data-testid="chip-thumb"
      className="-ml-2 size-8 shrink-0 rounded-button border border-line bg-surface-2 object-cover"
    />
  )
}

export function ChipList({
  chips,
  chipsRef,
  client,
  threadId,
  clearIfUnchanged,
}: {
  chips: Chip[]
  chipsRef: RefObject<HTMLUListElement | null>
  client: TalosClient
  threadId: string
  clearIfUnchanged: (body: string) => void
}) {
  return (
    <ul ref={chipsRef} className="composer-chips m-0 mb-2 flex list-none flex-wrap gap-2 p-0">
      {chips.map((c) => (
        <li
          key={c.key}
          data-testid="chip"
          data-state={c.state}
          className="flex min-h-9 items-center gap-2 rounded-pill border border-line bg-surface px-3 text-sm"
        >
          {c.file?.type.startsWith('image/') && c.file.size <= THUMB_MAX_BYTES ? <ChipThumb file={c.file} /> : null}
          <span className="max-w-40 truncate">{c.name}</span>
          <span className="text-text-2" data-testid="chip-status">
            {c.state === 'uploading'
              ? c.progress && c.progress > 0
                ? `Uploading ${Math.round(c.progress * 100)}%`
                : 'Uploading…'
              : c.state === 'error'
                ? (c.note ?? "Couldn't upload")
                : ''}
          </span>
          {c.state === 'error' && c.file && !isTooBigNote(c.note) && (
            <button
              type="button"
              data-testid="chip-retry"
              aria-label={`Retry ${c.name}`}
              className="min-h-8 px-1 underline"
              onClick={async () => {
                const from = c.fromText
                if ((await uploadChip(client, threadId, c.file as File, c.key, from)) && from !== undefined)
                  clearIfUnchanged(from)
              }}
            >
              Retry
            </button>
          )}
          <button
            type="button"
            aria-label={c.state === 'uploading' ? `Cancel upload of ${c.name}` : `Remove ${c.name}`}
            className="grid size-8 place-items-center"
            onClick={() => removeChip(threadId, c.key)}
          >
            <IconClose width={16} height={16} />
          </button>
        </li>
      ))}
    </ul>
  )
}
