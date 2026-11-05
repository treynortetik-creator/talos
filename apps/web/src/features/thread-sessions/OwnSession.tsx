// The "Own session" switch for one thread (docs/OPTION-C.md 9.2). Shown only when the master switch is on, the Mac can
// host thread sessions, and the thread may have one (never the default thread, General or Inbox). No card, no step-up:
// it is a config.patch like any thread setting. Off by default.
import {
  AbsolutePath,
  DEFAULT_IDLE_PARK_MIN,
  DOCUMENTED_EFFORTS,
  type ThreadSessionActionT,
  type ThreadT,
  WorkerModel,
} from '@talos-app/protocol'
import { useId, useState } from 'react'
import { useTalos } from '../../lib/client.ts'
import { Button, Input, Switch } from '../../ui/index.ts'
import { useThreadPatch } from '../threads/manage/useThreadPatch.ts'
import { type ControlOutcome, useThreadSessionsController, useThreadSessionView, workerLine } from './store.ts'

export function costNote(idleMin: number): string {
  return `Its own memory and context. Uses your plan limits on each start; parks after ${idleMin} min idle.`
}

export function OwnSession({ thread }: { thread: ThreadT }) {
  const { macOnline, err, busy: saving, apply } = useThreadPatch()
  const view = useThreadSessionView(thread.id)
  const ctl = useThreadSessionsController()
  const [outcome, setOutcome] = useState<ControlOutcome | null>(null)
  const [busy, setBusy] = useState(false)
  if (!view.offered && !view.dedicated) return null
  const on = thread.session === 'dedicated'
  const idle = thread.session_opts?.idle_park_min ?? 30

  // the same save path as every other thread edit: the latest list, one owner-signed patch, errors in words
  const toggle = (next: boolean) =>
    apply((latest) => latest.map((t) => (t.id === thread.id ? { ...t, session: next ? 'dedicated' : 'shared' } : t)))
  const run = async (action: ThreadSessionActionT) => {
    setBusy(true)
    setOutcome(null)
    setOutcome(await ctl.control(thread.id, action))
    setBusy(false)
  }
  const w = view.worker
  const live = w?.state === 'live' || w?.state === 'busy'
  return (
    <div className="mt-2 border-t border-line px-2 pt-2" data-testid="own-session">
      <div className="flex min-h-11 items-center justify-between gap-2">
        <label htmlFor={`own-${thread.id}`} className="text-sm font-medium">
          Own session
        </label>
        <Switch
          id={`own-${thread.id}`}
          checked={on}
          disabled={!macOnline || saving || (!view.offered && !on)}
          onCheckedChange={(v) => void toggle(v)}
          data-testid="own-session-switch"
        />
      </div>
      <p className="m-0 text-xs text-text-2">{costNote(idle)}</p>
      {view.dedicated && (
        <>
          <p className="m-0 pt-1 text-xs" data-testid="own-session-state">
            {view.unsupported ? "Your Mac isn't running thread sessions right now, so main answers." : workerLine(w)}
          </p>
          {!view.unsupported && (
            <div className="flex flex-wrap gap-1 pt-2">
              {live && (
                <Button variant="outline" disabled={busy || !macOnline} onClick={() => void run('park')}>
                  Park now
                </Button>
              )}
              {(live || w?.state === 'parked' || (w?.state === 'failed' && w.error === 'needs_mac')) && (
                <Button variant="outline" disabled={busy || !macOnline} onClick={() => void run('restart')}>
                  Restart
                </Button>
              )}
              {(w?.state === 'failed' || w?.state === 'parked') && (
                <Button variant="outline" disabled={busy || !macOnline} onClick={() => void run('fresh')}>
                  Start fresh
                </Button>
              )}
            </div>
          )}
          <SessionOptions thread={thread} locked={!macOnline || saving} apply={apply} />
        </>
      )}
      {outcome && (
        <p role="status" className="m-0 pt-1 text-xs">
          {outcome.text}
        </p>
      )}
      {err && (
        <p role="alert" className="m-0 pt-1 text-xs text-danger">
          {err}
        </p>
      )}
    </div>
  )
}

type Apply = ReturnType<typeof useThreadPatch>['apply']

/**
 * Model, effort, folder and idle time of one thread's own session (`threads[].session_opts`). Each saves at once through
 * the same owner-signed thread patch as the switch above: the latest list, never a stale copy. A change applies when the
 * thread's session next starts, so the row says so. A refusal from the Mac (a folder that is not there, a value out of
 * range) shows under the controls in the Mac's own words and the control goes back to the saved value.
 */
function SessionOptions({ thread, locked, apply }: { thread: ThreadT; locked: boolean; apply: Apply }) {
  const models = useTalos((s) => s.config?.session_models ?? [])
  const opts = thread.session_opts
  const model = opts?.model ?? 'inherit'
  const effort = opts?.effort ?? ''
  const cwd = opts?.cwd ?? ''
  const idle = opts?.idle_park_min ?? DEFAULT_IDLE_PARK_MIN
  const ids = { model: useId(), effort: useId(), cwd: useId(), idle: useId() }
  const [folder, setFolder] = useState<string | null>(null)
  const [idleText, setIdleText] = useState<string | null>(null)
  const [local, setLocal] = useState<string | null>(null)

  const save = async (change: Partial<NonNullable<ThreadT['session_opts']>>, drop?: 'cwd' | 'effort') => {
    setLocal(null)
    return apply((latest) =>
      latest.map((t) => {
        if (t.id !== thread.id) return t
        const next: Record<string, unknown> = { ...(t.session_opts ?? {}), ...change }
        if (drop) delete next[drop]
        return { ...t, session_opts: next as ThreadT['session_opts'] }
      }),
    )
  }
  const modelOptions = ['inherit', ...models.filter((m) => m !== 'inherit')]
  if (!modelOptions.includes(model)) modelOptions.push(model)
  const efforts: string[] = [...DOCUMENTED_EFFORTS]
  if (effort && !efforts.includes(effort)) efforts.push(effort)

  const commitFolder = async () => {
    const v = (folder ?? cwd).trim()
    if (v === cwd) return setFolder(null)
    // saved or refused, the box goes back to the saved value (the Mac's words for a refusal show under the controls)
    if (v === '') {
      await save({}, 'cwd')
      return setFolder(null)
    }
    if (!AbsolutePath.safeParse(v).success)
      return setLocal('Use a full folder path that starts with /, like /Users/you/project.')
    await save({ cwd: v })
    setFolder(null)
  }
  const commitIdle = async () => {
    const n = Number(idleText ?? idle)
    if (idleText === null || n === idle) return setIdleText(null)
    if (!Number.isInteger(n) || n < 5 || n > 720)
      return setLocal('Idle time is a whole number of minutes from 5 to 720.')
    await save({ idle_park_min: n })
    setIdleText(null)
  }
  const field = 'flex flex-col gap-1 text-xs text-text-2'
  const selectCls = 'min-h-11 rounded-button border border-line bg-surface px-2 text-sm text-text disabled:opacity-50'
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="own-session-options">
      <div className={field}>
        <label htmlFor={ids.model}>Model</label>
        <select
          id={ids.model}
          className={selectCls}
          disabled={locked}
          value={model}
          onChange={(e) => {
            if (WorkerModel.safeParse(e.target.value).success) void save({ model: e.target.value })
          }}
        >
          {modelOptions.map((m) => (
            <option key={m} value={m}>
              {m === 'inherit' ? 'Same as the main session' : m}
            </option>
          ))}
        </select>
      </div>
      <div className={field}>
        <label htmlFor={ids.effort}>Effort</label>
        <select
          id={ids.effort}
          className={selectCls}
          disabled={locked}
          value={effort}
          onChange={(e) => void (e.target.value ? save({ effort: e.target.value }) : save({}, 'effort'))}
        >
          <option value="">Default</option>
          {efforts.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <div className={field}>
        <label htmlFor={ids.cwd}>Folder</label>
        <Input
          id={ids.cwd}
          value={folder ?? cwd}
          disabled={locked}
          placeholder="The agent folder"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => {
            setLocal(null)
            setFolder(e.target.value)
          }}
          onBlur={() => void commitFolder()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitFolder()
          }}
        />
        <span>Leave empty to use the agent folder. Your Mac checks that it exists.</span>
      </div>
      <div className={field}>
        <label htmlFor={ids.idle}>Park after idle (minutes)</label>
        <Input
          id={ids.idle}
          type="number"
          inputMode="numeric"
          min={5}
          max={720}
          value={idleText ?? String(idle)}
          disabled={locked}
          onChange={(e) => {
            setLocal(null)
            setIdleText(e.target.value)
          }}
          onBlur={() => void commitIdle()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitIdle()
          }}
        />
      </div>
      <p className="m-0 text-xs text-text-2">These apply the next time this thread's session starts.</p>
      {local && (
        <p role="alert" className="m-0 text-xs text-danger">
          {local}
        </p>
      )}
    </div>
  )
}
