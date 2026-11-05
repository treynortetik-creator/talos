// The attachment chips above the box, and the two effects that keep the list tidy.
import { type Dispatch, type MutableRefObject, type RefObject, type SetStateAction, useEffect } from 'react'
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
