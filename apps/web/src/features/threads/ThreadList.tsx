import type { MessageT, ThreadT } from '@talos-app/protocol'
import { ownValue } from '@talos-app/protocol'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { shortAge } from '../../lib/format.ts'
import { useThreadStatus } from '../../lib/threadStatus.ts'
import { cn } from '../../ui/cn.ts'
import { IconBell, IconClose } from '../../ui/icons.tsx'
import { Meander } from '../../ui/Meander.tsx'
import { ScrollRegion } from '../../ui/ScrollRegion.tsx'
import { StatusDot } from '../../ui/StatusDot.tsx'
import { ThreadIcon } from '../../ui/ThreadIcon.tsx'
import { BugHeaderButton } from '../bugreport/BugButton.tsx'
import { useAwaitingOwner } from '../cards/useAwaitingOwner.ts'
import { SessionLine } from '../thread-sessions/SessionStatus.tsx'
import { rowShowsSession, useSessionWords } from '../thread-sessions/useSessionWords.ts'
import { Banners } from './Banners.tsx'
import { ThreadManageList } from './manage/ThreadManageList.tsx'
import { readUpTo } from './readSeq.ts'
import { StatusWord } from './StatusPill.tsx'
import { inDrawnOrder } from './subThreads.ts'
import { ThreadRowWithSettings } from './ThreadMoreButton.tsx'
import { ThreadRowMenu } from './ThreadRowMenu.tsx'
import { NewThread } from './ThreadSettings.tsx'
import { NOTIFY_SHORT, useExplainerDismissed } from './threadMeta.ts'
import { useAgentName } from './useThreads.ts'

export function lastLine(m: MessageT | undefined): string {
  if (!m) return 'No messages yet'
  if (m.kind === 'voice_note') return 'Voice note'
  if (m.kind === 'card') return 'Card'
  if ((m.attachments ?? []).length > 0 && !m.text) return m.attachments?.[0]?.name ?? 'Attachment'
  // Plain-text preview: drop markdown punctuation (`*_#>` and link/code brackets) so `*Title*` has no asterisks.
  // a heartbeat digest carries outside text: the preview says what it is first
  return `${m.heartbeat ? 'Heartbeat: ' : ''}${m.text ?? ''}`
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/**
 * A thread with its own session: the session's line when it has something to say (waiting on the owner, working, stopped...),
 * else the last message (the owner's call on the mock, 2026-11-13). Only such threads run the session hooks.
 */
function SessionOrPreview({ threadId, preview }: { threadId: string; preview: string }) {
  const session = useSessionWords(threadId)
  return rowShowsSession(session) ? (
    <SessionLine words={session} />
  ) : (
    <span className="block truncate text-sm text-text-2">{preview}</span>
  )
}

function Row({ t, by, sub = false }: { t: ThreadT; by?: string | undefined; sub?: boolean }) {
  const unread = useTalos((s) => ownValue(s.unread, t.id) ?? 0)
  const status = useThreadStatus(t.id)
  const last = useTalos((s) => ownValue(s.messages, t.id)?.at(-1))
  // the one "Needs you" rule (pending, not expired, hash checks): the dot agrees with the tab badge and Home
  const attention = useAwaitingOwner(t.id).length > 0
  return (
    <li>
      <ThreadRowWithSettings
        thread={t}
        wrap={(inner) => (
          <ThreadRowMenu thread={t} swipe>
            {inner}
          </ThreadRowMenu>
        )}
      >
        <Link
          to={`/t/${t.id}`}
          draggable={false}
          className={cn(
            'flex min-h-[4.5rem] items-center gap-3.5 py-2.5 pr-14 transition-colors duration-[var(--dur-1)] ease-talos hover:bg-surface-2',
            // a sub-thread sits under its parent, indented
            sub ? 'pl-12' : 'pl-4',
          )}
          data-testid={`thread-row-${t.id}`}
        >
          <ThreadIcon id={t.id} icon={t.icon} color={t.color} size={sub ? 36 : 44} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className={cn('truncate text-[1.0625rem]', unread > 0 ? 'font-semibold' : 'font-medium')}>
                {t.name}
              </span>
              {by && <span className="shrink-0 text-xs text-text-2">by {by}</span>}
              {attention && (
                <span className="inline-flex text-warn" role="img" aria-label="Needs you">
                  <StatusDot shape="solid" />
                </span>
              )}
              {status && status.state !== 'idle' ? <StatusWord state={status.state} /> : null}
            </span>
            {t.session === 'dedicated' ? (
              <SessionOrPreview threadId={t.id} preview={lastLine(last)} />
            ) : (
              <span className="block truncate text-sm text-text-2">{lastLine(last)}</span>
            )}
          </span>
          <span className="flex shrink-0 flex-col items-end gap-1">
            <span className="font-mono text-xs tabular-nums text-text-2">{shortAge(last?.created_at)}</span>
            <span
              className="inline-flex items-center gap-1 text-xs text-text-2"
              data-testid={`notify-${t.id}`}
              title={`Notifications: ${NOTIFY_SHORT[t.notify]}`}
            >
              <IconBell width={12} height={12} aria-hidden="true" />
              <span>{NOTIFY_SHORT[t.notify]}</span>
            </span>
            {unread > 0 && (
              <span
                className="min-w-5 rounded-pill bg-accent px-1.5 text-center font-mono text-xs leading-5 text-on-accent"
                role="img"
                aria-label={`${unread} unread`}
              >
                {unread}
              </span>
            )}
          </span>
        </Link>
      </ThreadRowWithSettings>
    </li>
  )
}

/** The threads a list shows (not archived) that have unread. */
function listedUnread(s: { unread: Record<string, number>; threads: readonly ThreadT[] }): string[] {
  const listed = new Set(s.threads.filter((t) => !t.archived).map((t) => t.id))
  return Object.entries(s.unread)
    .filter(([id, n]) => n > 0 && listed.has(id))
    .map(([id]) => id)
}

/** Every thread that shows unread is read up to the newest frame this device has seen; one `thread.read` each. */
function MarkAllRead({ onResult }: { onResult: (ok: boolean) => void }) {
  const client = useTalosClient()
  // only threads a list shows: an archived thread's unread is never on screen, so it must not enable the button
  const any = useTalos((s) => listedUnread(s).length > 0)
  return (
    <button
      type="button"
      data-testid="mark-all-read"
      aria-label="Mark all read"
      disabled={!any}
      onClick={() => {
        const st = client.store.getState()
        // Nothing is cleared that the relay did not get: offline, every badge stays and the header says why.
        let ok = true
        for (const id of listedUnread(st))
          if (!client.markThreadRead(id, readUpTo(st), { needConnection: true })) ok = false
        onResult(ok)
      }}
      className="min-h-11 rounded-button px-3 text-sm font-semibold hover:bg-surface-2 disabled:opacity-40"
    >
      Mark all read
    </button>
  )
}

export function ThreadList() {
  const agent = useAgentName()
  const all = useTalos((s) => s.threads)
  const [showArchived, setShowArchived] = useState(false)
  // Settings -> Agent links here with ?manage=1: open straight in the reorder / rename mode
  const [params] = useSearchParams()
  const [editing, setEditing] = useState(() => params.get('manage') === '1')
  const [markFailed, setMarkFailed] = useState(false)
  const [dismissed, dismiss] = useExplainerDismissed()
  // one list in the owner's order (the same order as the sidebar); agent-made threads carry a small "by" tag
  const { active, archived } = useMemo(() => {
    const sorted = all.slice().sort((a, b) => a.order - b.order)
    // each parent with its sub-threads right under it (subThreads.ts)
    return { active: inDrawnOrder(sorted.filter((t) => !t.archived)), archived: sorted.filter((t) => t.archived) }
  }, [all])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="top-band">
        {/* The buttons sit beside the title while both fit; at a larger text size they drop to a row of their own. */}
        <header className="flex flex-wrap items-center gap-1 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-3">
          <h1 className="m-0 flex-1 font-display text-2xl font-semibold">Threads</h1>
          <div className="flex min-w-0 flex-[1_1_11rem] items-center justify-end gap-1">
            <NewThread compact />
            <MarkAllRead onResult={(ok) => setMarkFailed(!ok)} />
            <button
              type="button"
              aria-pressed={editing}
              data-testid="edit-threads"
              onClick={() => setEditing((v) => !v)}
              className={cn(
                'min-h-11 rounded-button px-3 text-sm font-semibold hover:bg-surface-2',
                editing ? 'text-accent-text' : 'text-text',
              )}
            >
              {editing ? 'Done' : 'Edit'}
            </button>
            <BugHeaderButton />
          </div>
        </header>
        <Meander />
      </div>
      {markFailed && (
        <p role="status" data-testid="mark-all-read-note" className="m-0 px-4 pt-2 text-sm text-text-2">
          Not connected, so nothing was marked read. Try again when you are back online.
        </p>
      )}
      <Banners />
      {!dismissed && (
        <div
          data-testid="threads-explainer"
          className="mx-4 mt-3 flex items-start gap-2 rounded-button border border-line bg-surface p-3 text-sm text-text-2"
        >
          <p className="m-0 flex-1">
            Threads keep topics apart. {agent} replies where you ask and files its own updates by topic.
          </p>
          <button
            type="button"
            aria-label="Dismiss explanation"
            onClick={dismiss}
            className="grid size-11 shrink-0 place-items-center"
          >
            <IconClose width={16} height={16} />
          </button>
        </div>
      )}
      <ScrollRegion label="Thread list" className="min-h-0 flex-1 overflow-y-auto">
        {editing ? (
          <div className="px-2 py-2">
            <p className="m-0 px-2 pb-2 text-sm text-text-2">
              Drag the handle or use the arrows to reorder. The gear opens a thread's name, icon and color.
            </p>
            <ThreadManageList moveButtons />
          </div>
        ) : (
          <>
            <ul className="m-0 list-none divide-y divide-line/60 p-0 pt-1">
              {active.map((t) => (
                <Row
                  key={t.id}
                  t={t}
                  by={t.kind === 'agent' ? agent : undefined}
                  sub={!!t.parent_id && active.some((p) => p.id === t.parent_id && !p.parent_id)}
                />
              ))}
            </ul>
            <div className="px-4 py-3">
              <NewThread />
            </div>
            {archived.length > 0 && (
              <div className="px-4 py-3">
                <button
                  type="button"
                  aria-expanded={showArchived}
                  onClick={() => setShowArchived((v) => !v)}
                  className="min-h-11 text-sm text-text-2 underline"
                >
                  {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
                </button>
                {showArchived && (
                  <ul className="m-0 list-none p-0">
                    {archived.map((t) => (
                      <Row key={t.id} t={t} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </ScrollRegion>
    </div>
  )
}
