// The thread settings sheet (docs/THREADS.md): create or edit one thread. Name, icon, color, "what goes here" (the
// topic the agent routes by), notifications, default thread, archive. One owner-signed config.patch per Save.
import { THREAD_COLORS, THREAD_TOPIC_MAX, type ThreadT } from '@talos-app/protocol'
import { useId, useState } from 'react'
import { useTalos } from '../../../lib/client.ts'
import { cn } from '../../../ui/cn.ts'
import { IconCheck, IconSearch } from '../../../ui/icons.tsx'
import {
  Button,
  Input,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Switch,
  Textarea,
} from '../../../ui/index.ts'
import { ThreadIcon } from '../../../ui/ThreadIcon.tsx'
import { ART_ICONS, ART_LABEL, INK, searchIcons, THREAD_COLOR } from '../../../ui/threadIcons.ts'
import { newThread } from '../../agent-config/patch.ts'
import { useMediaQuery } from '../../settings/useMedia.ts'
import { OwnSession } from '../../thread-sessions/OwnSession.tsx'
import { NOTIFY_LABEL, setDescription, useDescription } from '../threadMeta.ts'
import { useAgentName } from '../useThreads.ts'
import { useThreadPatch } from './useThreadPatch.ts'

const MAX_THREADS = 40
type Notify = ThreadT['notify']

export function ThreadEditor({
  open,
  onOpenChange,
  thread,
  onCreated,
  onCloseAutoFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Absent = create a new thread. */
  thread?: ThreadT | undefined
  onCreated?: (id: string) => void
  /** Where focus goes on close when the opener is gone (the phone menu closes as this opens). */
  onCloseAutoFocus?: (e: Event) => void
}) {
  const wide = useMediaQuery('(min-width: 768px)')
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={wide ? 'right' : 'bottom'}
        data-testid="thread-settings"
        {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
        // editing: don't pop the phone keyboard by focusing the name; creating: the name field takes focus (autoFocus)
        onOpenAutoFocus={(e) => {
          if (thread) {
            e.preventDefault()
            ;(e.currentTarget as HTMLElement | null)?.focus()
          }
        }}
        className={cn('flex flex-col gap-4', wide && 'w-[min(100vw,28rem)]')}
      >
        {open && (
          <EditorBody
            key={thread?.id ?? 'new'}
            thread={thread}
            close={() => onOpenChange(false)}
            {...(onCreated ? { onCreated } : {})}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function EditorBody({
  thread,
  close,
  onCreated,
}: {
  thread?: ThreadT | undefined
  close: () => void
  onCreated?: (id: string) => void
}) {
  const agent = useAgentName()
  const { threads, defaultThread, macOnline, rich, err, busy, apply } = useThreadPatch()
  const localNote = useDescription(thread?.id ?? '')
  const creating = !thread
  const system = thread?.kind === 'system'
  const [name, setName] = useState(thread?.name ?? '')
  const [icon, setIcon] = useState(thread?.icon ?? '')
  const [color, setColor] = useState(thread?.color ?? '')
  const [topic, setTopic] = useState(thread?.topic ?? localNote)
  const [notify, setNotify] = useState<Notify>(thread?.notify ?? 'all')
  const [notifyErr, setNotifyErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const live = threads.find((t) => t.id === thread?.id) ?? thread
  const isDefault = !!thread && defaultThread === thread.id
  const trimmed = name.trim()
  const nameOk = trimmed.length >= 1 && trimmed.length <= 40
  const full = creating && threads.length >= MAX_THREADS
  const previewId = thread?.id ?? 'general'

  const fields = (t: ThreadT): ThreadT => {
    const out: ThreadT = { ...t, name: system ? t.name : trimmed, notify }
    if (rich) {
      delete out.icon
      delete out.color
      if (icon) out.icon = icon
      if (color) out.color = color
      if (!system) {
        delete out.topic
        if (topic.trim()) out.topic = topic.trim().slice(0, THREAD_TOPIC_MAX)
      }
    }
    return out
  }

  const save = async () => {
    if (!nameOk && !system) return
    let id = thread?.id
    const ok = await apply((latest) => {
      if (thread) return latest.map((t) => (t.id === thread.id ? fields(t) : t))
      const t = fields(newThread(trimmed, latest, new Date().toISOString()))
      id = t.id
      return [...latest, { ...t, order: latest.length }]
    })
    if (ok) {
      if (rich && id) setDescription(id, '') // the note now lives in config, where the agent can read it
      if (!thread && id) onCreated?.(id)
      close()
    }
  }

  // Notifications apply at once (no Save needed). If the Mac does not take the change, the pill goes back to the saved
  // value and the reason shows: it must never keep reading as the new value (audit U11).
  const pickNotify = async (n: Notify) => {
    if (!thread) return setNotify(n) // a thread being created sends it with Create
    const before = notify
    setNotify(n)
    setNotifyErr(null)
    const ok = await apply((latest) => latest.map((t) => (t.id === thread.id ? { ...t, notify: n } : t)))
    if (!ok) {
      setNotify(before)
      setNotifyErr('Not changed. Your Mac did not take it.')
    }
  }
  // Rows that save at once, from the latest list. They read the live thread, so a refusal leaves the saved value on screen.
  const setRow = (change: Partial<ThreadT>) =>
    thread
      ? apply((latest) => latest.map((t) => (t.id === thread.id ? { ...t, ...change } : t)))
      : Promise.resolve(false)

  const toggleArchive = async () => {
    if (!live) return
    await apply((latest) => latest.map((t) => (t.id === live.id ? { ...t, archived: !t.archived } : t)))
  }
  const pendingCards = useTalos(
    (s) => s.cards.filter((c) => c.thread_id === thread?.id && c.state === 'pending').length,
  )
  const activeCount = threads.filter((t) => !t.archived && t.id !== 'inbox').length
  const archiveBlocked = !live?.archived && (isDefault || activeCount <= 1)

  const glyphs = searchIcons(q)
  const arts = ART_ICONS.filter((a) => !q.trim() || ART_LABEL[a].toLowerCase().includes(q.trim().toLowerCase()))
  const tile = (selected: boolean) =>
    cn(
      'grid size-11 place-items-center rounded-button border text-text transition-colors duration-[var(--dur-1)]',
      selected
        ? 'border-text bg-surface-2 shadow-[inset_0_0_0_1px_var(--text)]'
        : 'border-transparent hover:bg-surface-2',
    )

  return (
    <>
      <div className="flex items-center gap-3">
        <ThreadIcon id={previewId} icon={icon || undefined} color={color || undefined} size={48} framed />
        <div className="min-w-0 flex-1">
          <SheetTitle className="m-0 truncate font-display text-xl font-semibold">
            {creating ? 'New thread' : 'Thread settings'}
          </SheetTitle>
          <SheetDescription className="m-0 truncate text-sm text-text-2" data-testid="thread-preview-name">
            {trimmed || 'Untitled'}
          </SheetDescription>
        </div>
      </div>

      {!system && (
        <div>
          <label className="block text-sm font-medium" htmlFor="thread-name">
            Name
          </label>
          <Input
            id="thread-name"
            value={name}
            maxLength={40}
            autoFocus={creating}
            placeholder="Short topic name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
            }}
            className="mt-1"
          />
        </div>
      )}

      {rich ? (
        <>
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-1 text-sm font-medium">
              Color{' '}
              <span className="font-normal text-text-2">
                {color && Object.hasOwn(THREAD_COLOR, color)
                  ? THREAD_COLOR[color as keyof typeof THREAD_COLOR].label
                  : 'Default'}
              </span>
            </legend>
            <div className="flex flex-wrap gap-1.5" data-testid="color-swatches">
              <Swatch label="Default" selected={!color} onClick={() => setColor('')} />
              {THREAD_COLORS.map((c) => (
                <Swatch
                  key={c}
                  label={THREAD_COLOR[c].label}
                  hex={THREAD_COLOR[c].hex}
                  selected={color === c}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </fieldset>

          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-1 text-sm font-medium">Icon</legend>
            <div className="relative">
              <IconSearch
                width={16}
                height={16}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-2"
              />
              <Input
                aria-label="Search icons"
                placeholder="Search icons"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-9"
              />
            </div>
            <div
              data-testid="icon-grid"
              className="mt-2 grid max-h-52 grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1 overflow-y-auto rounded-button border border-line p-1"
            >
              {!q.trim() && (
                <button
                  type="button"
                  aria-label="Automatic icon"
                  title="Automatic"
                  aria-pressed={!icon}
                  onClick={() => setIcon('')}
                  className={tile(!icon)}
                >
                  <ThreadIcon id={previewId} size={32} framed />
                </button>
              )}
              {glyphs.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  aria-label={`${g.label} icon`}
                  title={g.label}
                  aria-pressed={icon === g.key}
                  onClick={() => setIcon(g.key)}
                  className={tile(icon === g.key)}
                >
                  <g.C width={22} height={22} strokeWidth={2} aria-hidden="true" />
                </button>
              ))}
              {arts.map((a) => (
                <button
                  key={a}
                  type="button"
                  aria-label={`${ART_LABEL[a]} icon`}
                  title={ART_LABEL[a]}
                  aria-pressed={icon === `art-${a}`}
                  onClick={() => setIcon(`art-${a}`)}
                  className={tile(icon === `art-${a}`)}
                >
                  <ThreadIcon id={a} icon={`art-${a}`} size={30} framed />
                </button>
              ))}
              {glyphs.length === 0 && arts.length === 0 && (
                <p className="col-span-full m-0 p-2 text-sm text-text-2">No icon matches “{q.trim()}”.</p>
              )}
            </div>
          </fieldset>

          {!system && (
            <div>
              <label className="block text-sm font-medium" htmlFor="thread-topic">
                What goes here
              </label>
              <Textarea
                id="thread-topic"
                value={topic}
                rows={2}
                maxLength={THREAD_TOPIC_MAX}
                placeholder="One line on this thread's topic"
                onChange={(e) => setTopic(e.target.value)}
                className="mt-1 min-h-0 resize-none text-sm"
              />
              <p className="m-0 pt-1 text-xs text-text-2">{agent} reads this to decide what to post here.</p>
            </div>
          )}
        </>
      ) : (
        <p className="m-0 rounded-button border border-line p-2 text-xs text-text-2" data-testid="threads-update-mac">
          Update Talos on your Mac to pick icons, colors and topics.
        </p>
      )}

      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">Notifications</legend>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(NOTIFY_LABEL) as Notify[]).map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={notify === n}
              onClick={() => void pickNotify(n)}
              className={cn(
                'inline-flex min-h-11 items-center gap-1.5 rounded-pill border px-3 text-sm',
                notify === n ? 'border-text bg-surface-2 font-semibold' : 'border-line hover:bg-surface-2',
              )}
            >
              {notify === n && <IconCheck width={16} height={16} />}
              {NOTIFY_LABEL[n]}
            </button>
          ))}
        </div>
        <p className="m-0 pt-1 text-xs text-text-2">
          Events from your integrations count as replies, so Needs you only does not push for them.
        </p>
        {notifyErr && (
          <p role="alert" className="m-0 pt-1 text-xs text-danger" data-testid="notify-error">
            {notifyErr}
          </p>
        )}
      </fieldset>

      {!creating && live && live.id !== 'inbox' && (
        <ThreadSwitches thread={live} locked={!macOnline || busy} setRow={setRow} />
      )}

      {/* Option C (docs/OPTION-C.md 9.2): hidden unless the owner allowed thread sessions and this thread may have one */}
      {!creating && live && <OwnSession thread={live} />}

      {!macOnline && <p className="m-0 text-xs text-text-2">Changes need your Mac online.</p>}
      {full && <p className="m-0 text-xs text-text-2">You have the maximum of {MAX_THREADS} threads.</p>}
      {!creating && !live?.archived && pendingCards > 0 && (
        <p className="m-0 text-xs text-warn" data-testid="archive-cards-note">
          {pendingCards === 1 ? '1 card here still needs you.' : `${pendingCards} cards here still need you.`} They stay
          in Needs you if you archive this thread.
        </p>
      )}
      {!creating && isDefault && !live?.archived && (
        <p className="m-0 text-xs text-text-2">To archive the default thread, make another thread the default.</p>
      )}
      {err && (
        <p role="alert" className="m-0 text-sm text-danger">
          {err}
        </p>
      )}

      <div className="sticky -bottom-4 z-10 -mx-4 mt-auto -mb-4 flex flex-wrap items-center gap-2 border-t border-line bg-surface px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {!creating && !system && live && (
          <div className="flex flex-col items-start gap-0.5">
            <Button
              variant="danger"
              disabled={!macOnline || busy || archiveBlocked}
              onClick={() => void toggleArchive()}
              title={archiveBlocked && isDefault ? 'Pick another default thread first' : undefined}
            >
              {live.archived ? 'Restore thread' : 'Archive thread'}
            </Button>
            <span className="text-xs text-text-2" data-testid="archive-only-note">
              Archive only: a thread can't be deleted. Restore it any time.
            </span>
          </div>
        )}
        <span className="flex-1" />
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button disabled={!macOnline || busy || full || (!system && !nameOk)} onClick={() => void save()}>
          {creating ? 'Create thread' : 'Save'}
        </Button>
      </div>
    </>
  )
}

/**
 * Live-call context: one thread's own switch (it used to sit in Settings -> Agent). It saves
 * at once through the thread patch. The editor does not render this block on the Inbox, where it has no effect.
 */
function ThreadSwitches({
  thread,
  locked,
  setRow,
}: {
  thread: ThreadT
  locked: boolean
  setRow: (change: Partial<ThreadT>) => Promise<boolean>
}) {
  const ctxId = useId()
  return (
    <div className="flex flex-col gap-1" data-testid="thread-switches">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <label htmlFor={ctxId} className="text-sm">
          Live-call context
          <span className="block text-xs text-text-2">Lets a live call see this thread's recent messages.</span>
        </label>
        <Switch
          id={ctxId}
          checked={thread.voice_context === 'recent'}
          disabled={locked}
          onCheckedChange={(on) => void setRow({ voice_context: on ? 'recent' : 'none' })}
        />
      </div>
    </div>
  )
}

function Swatch({
  label,
  hex,
  selected,
  onClick,
}: {
  label: string
  hex?: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={`${label} color`}
      title={label}
      aria-pressed={selected}
      onClick={onClick}
      data-swatch={hex ? label : 'default'}
      className={cn(
        'grid size-11 place-items-center rounded-pill',
        selected ? 'shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--text)]' : '',
      )}
    >
      <span
        className="grid size-9 place-items-center rounded-pill shadow-[inset_0_0_0_1.5px_var(--talos-black)]"
        style={{ background: hex ?? 'var(--talos-cream)' }}
      >
        {selected ? (
          <IconCheck width={18} height={18} color={INK} strokeWidth={2.6} />
        ) : hex ? null : (
          <span className="block h-0.5 w-5 rotate-[-45deg] bg-[var(--talos-black)]" />
        )}
      </span>
    </button>
  )
}
