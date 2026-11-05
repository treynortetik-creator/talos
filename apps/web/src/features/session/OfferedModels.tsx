// Settings -> Session -> Models offered: the list the model picker may switch to (`session_models`, 1 to 12 entries; the
// Mac refuses a `/model` value outside it). Add and remove save at once. The list is read from the store at the click, so
// two quick edits never write over each other from a stale copy.
import { MAX_SESSION_MODELS, ModelValue } from '@talos-app/protocol'
import { useId, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { Button, Input } from '../../ui/index.ts'
import { friendlyPatchError } from '../threads/manage/useThreadPatch.ts'

export function OfferedModels({ readOnly }: { readOnly: boolean }) {
  const client = useTalosClient()
  const models = useTalos((s) => s.config?.session_models ?? [])
  const ready = useTalos((s) => s.config !== null)
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()

  const save = async (change: (latest: string[]) => string[] | string) => {
    setErr(null)
    const latest = client.store.getState().config?.session_models ?? []
    const next = change(latest)
    if (typeof next === 'string') return setErr(next)
    setBusy(true)
    try {
      await client.patchConfig({ session_models: next })
      return true
    } catch (e) {
      setErr(friendlyPatchError(e))
    } finally {
      setBusy(false)
    }
  }
  const add = async () => {
    const v = text.trim()
    if (!v) return
    const ok = await save((latest) => {
      if (!ModelValue.safeParse(v).success)
        return 'Use a model name like opus, sonnet[1m] or claude-sonnet-5-5: letters, numbers, . _ - [ ] only.'
      if (latest.includes(v)) return `${v} is already offered.`
      if (latest.length >= MAX_SESSION_MODELS) return `You can offer at most ${MAX_SESSION_MODELS} models.`
      return [...latest, v]
    })
    if (ok) setText('')
  }
  return (
    <div className="flex flex-col gap-2" data-testid="offered-models">
      <h3 className="m-0 text-base font-medium">Models offered</h3>
      <p className="m-0 text-sm text-text-2">
        The model picker only switches to these. Your Mac refuses any other model name.
      </p>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {models.map((m) => (
          <li key={m} className="flex items-center gap-1 rounded-pill border border-line bg-surface pl-3">
            <span className="text-sm">{m}</span>
            <button
              type="button"
              aria-label={`Remove ${m}`}
              disabled={readOnly || busy || !ready || models.length <= 1}
              title={models.length <= 1 ? 'Keep at least one model' : undefined}
              onClick={() => void save((latest) => latest.filter((x) => x !== m))}
              className="grid size-11 place-items-center rounded-pill text-text-2 hover:bg-surface-2 disabled:opacity-40"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <label htmlFor={id} className="sr-only">
          Add a model
        </label>
        <Input
          id={id}
          value={text}
          placeholder="Add a model, like opus[1m]"
          disabled={readOnly || !ready}
          autoCapitalize="off"
          spellCheck={false}
          maxLength={80}
          onChange={(e) => {
            setErr(null)
            setText(e.target.value)
          }}
        />
        <Button type="submit" variant="outline" disabled={readOnly || busy || !ready || text.trim() === ''}>
          Add
        </Button>
      </form>
      {err && (
        <p role="alert" className="m-0 text-sm text-danger">
          {err}
        </p>
      )}
    </div>
  )
}
