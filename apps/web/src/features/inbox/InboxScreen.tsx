// `/t/inbox`: Priority / Other tabs, swipe Done / Snooze, item sheet, composer. Hook text is plain text throughout.
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import type { NavigateFunction } from 'react-router'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { getPlatform } from '../../lib/platform.ts'
import {
  Button,
  Input,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../ui/index.ts'
import { CardView } from '../cards/CardView.tsx'
import { NavScope } from '../cards/nav.tsx'
import { prefillComposer } from '../composer/composerStore.ts'
import type { InboxScreenProps } from '../contracts.ts'
import { DoneList } from './DoneList.tsx'
import { EventRow, sourceLabel } from './EventRow.tsx'
import {
  type InboxTab,
  safeHref,
  snoozeUntil,
  TRUNCATED_NOTICE,
  tabCounts,
  tabItems,
  unreadableNotice,
} from './logic.ts'
import { offerUndo, UndoStrip } from './undo.tsx'

export function InboxScreen(_props: InboxScreenProps) {
  return <NavScope>{(navigate) => <InboxScreenInner navigate={navigate} />}</NavScope>
}

function InboxScreenInner({ navigate }: { navigate: NavigateFunction }) {
  const client = useTalosClient()
  const items = useTalos((s) => s.inbox)
  const truncated = useTalos((s) => s.inboxTruncated)
  const cards = useTalos((s) => s.cards)
  const threads = useTalos((s) => s.threads)
  const config = useTalos((s) => s.config)
  const agent = config?.agent.name ?? 'Talos'
  const tz = config?.timezone ?? 'UTC'
  const quiet = config?.quiet_window ?? null
  const [tab, setTab] = useState<InboxTab | 'done'>('priority')
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [unreadable, setUnreadable] = useState(0)

  useEffect(() => {
    if (tab === 'done') return // the Done view loads itself
    // Refreshes ClientState.inbox / inboxTruncated in the real client; the fake answers from memory.
    void client.api
      .inbox(tab)
      .then((r) => setUnreadable(r.unreadable ?? 0))
      .catch(() => {})
  }, [client, tab])

  const counts = useMemo(() => tabCounts(items), [items])
  const open = items.find((i) => i.id === openId) ?? null
  const related = open?.card_id ? cards.find((c) => c.id === open.card_id) : undefined
  const href = safeHref(open?.url)

  const choose = (id: string) => {
    setOpenId(id)
    const it = items.find((i) => i.id === id)
    if (it?.state === 'new') void client.updateInbox(id, { state: 'read' })
  }

  const [askError, setAskError] = useState<string | null>(null)
  const send = async (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    setAskError(null)
    // Cleared only once the message is taken: one the app refuses (too long) keeps its words and says why.
    try {
      await client.sendMessage({ threadId: 'inbox', text })
      setDraft((cur) => (cur.trim() === text ? '' : cur))
    } catch (err) {
      setAskError(err instanceof Error && err.message ? err.message : "Couldn't send. Your message is still here.")
    }
  }

  const list = (t: InboxTab) => {
    const rows = tabItems(items, t)
    if (rows.length === 0)
      return (
        <p className="py-12 text-center text-text-2" data-testid="inbox-empty">
          Inbox zero. Nobody wants anything from you.
        </p>
      )
    return (
      <ul
        className="incised mt-3 overflow-hidden rounded-card bg-surface p-1"
        aria-label={t === 'priority' ? 'Priority' : 'Other'}
      >
        {rows.map((it) => (
          <EventRow key={it.id} item={it} onOpen={(i) => choose(i.id)} />
        ))}
      </ul>
    )
  }

  return (
    <>
      <section aria-label="Inbox" className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
        {truncated ? (
          <p role="status" className="rounded-card border border-warn p-3 text-sm text-warn">
            {TRUNCATED_NOTICE}
          </p>
        ) : null}
        {unreadable > 0 && tab !== 'done' ? (
          <p
            role="status"
            data-testid="inbox-unreadable"
            className="rounded-card border border-warn p-3 text-sm text-warn"
          >
            {unreadableNotice(unreadable)}
          </p>
        ) : null}
        <UndoStrip />
        <Tabs value={tab} onValueChange={(v) => setTab(v as InboxTab | 'done')}>
          <TabsList aria-label="Inbox">
            <TabsTrigger value="priority">Priority ({counts.priority})</TabsTrigger>
            <TabsTrigger value="other">Other ({counts.other})</TabsTrigger>
            <TabsTrigger value="done">Done</TabsTrigger>
          </TabsList>
          <TabsContent value="priority">{list('priority')}</TabsContent>
          <TabsContent value="other">{list('other')}</TabsContent>
          <TabsContent value="done">
            <DoneList />
          </TabsContent>
        </Tabs>

        <form
          onSubmit={(e) => void send(e)}
          data-inbox-ask=""
          className="sticky bottom-0 flex flex-wrap gap-2 bg-bg py-2"
        >
          <Input
            aria-label={`Ask ${agent} about your inbox`}
            placeholder={`Ask ${agent} about your inbox`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setAskError(null)
            }}
          />
          <Button type="submit" disabled={draft.trim() === ''}>
            Send
          </Button>
          {askError ? (
            <p role="alert" data-testid="inbox-ask-error" className="m-0 basis-full text-sm text-danger">
              {askError}
            </p>
          ) : null}
        </form>

        <Sheet open={open !== null} onOpenChange={(o) => !o && setOpenId(null)}>
          {open ? (
            <SheetContent aria-describedby={undefined}>
              <SheetTitle className="text-lg font-medium text-text">{open.title}</SheetTitle>
              <SheetDescription className="mt-1 text-sm text-text-2">
                {sourceLabel(open)} · {open.actor.name ?? open.actor.email ?? 'unknown sender'}
              </SheetDescription>
              <p className="mt-3 whitespace-pre-wrap break-words text-text" data-testid="item-summary">
                {open.agent_summary ?? open.summary}
              </p>
              {href ? (
                <a
                  className="mt-2 inline-block min-h-11 text-accent-text underline"
                  href={href}
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    e.preventDefault()
                    getPlatform().openExternal(href)
                  }}
                >
                  Open source ↗
                </a>
              ) : null}
              {related ? (
                <div className="mt-3">
                  <CardView
                    card={related}
                    threadName={threads.find((t) => t.id === related.thread_id)?.name ?? related.thread_id}
                  />
                </div>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-2">
                <SheetClose asChild>
                  <Button
                    onClick={() => {
                      void client.updateInbox(open.id, { state: 'done' })
                      offerUndo(open, 'done')
                    }}
                  >
                    Done
                  </Button>
                </SheetClose>
                <SheetClose asChild>
                  <Button
                    variant="outline"
                    onClick={() => {
                      void client.updateInbox(open.id, {
                        state: 'snoozed',
                        snoozeUntil: snoozeUntil(new Date(), tz, quiet).toISOString(),
                      })
                      offerUndo(open, 'snoozed')
                    }}
                  >
                    Snooze
                  </Button>
                </SheetClose>
                <SheetClose asChild>
                  <Button
                    variant="outline"
                    onClick={() => {
                      const target = config?.default_thread ?? 'general'
                      prefillComposer(target, `re: ${open.title}`)
                      navigate(`/t/${target}`)
                    }}
                  >
                    Ask {agent}
                  </Button>
                </SheetClose>
              </div>
            </SheetContent>
          ) : null}
        </Sheet>
      </section>
    </>
  )
}
