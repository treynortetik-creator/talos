import type { AttachmentRefT, CardT, InboxItemT, MessageT } from '@talos-app/protocol'
import { ownValue } from '@talos-app/protocol'
import { Suspense, useEffect, useRef, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { useConnectionMeta } from '../../lib/connectionMeta.ts'
import { clockTime, formatDuration } from '../../lib/format.ts'
import { getPlatform } from '../../lib/platform.ts'
import type { SocketClient } from '../../lib/socketClient.ts'
import { cn } from '../../ui/cn.ts'
import { IconCheck, IconChecks, IconClock, IconCopy, IconMic } from '../../ui/icons.tsx'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../../ui/index.ts'
import { Mascot } from '../../ui/Mascot.tsx'
import { useComposerStore } from '../composer/composerStore.ts'
import { AppEchoRow, AppViewCard, CardView, EventRow } from '../registry.ts'
import { SharedContentBox } from '../share/SharedContentBox.tsx'
import { AttachmentView } from './Attachments.tsx'
import { Markdown } from './Markdown.tsx'
import { REVEAL } from './messageRow.ts'
import { runContextOf } from './runBlock.ts'
import { SpeakButton } from './SpeakButton.tsx'
import { useAgentName } from './useThreads.ts'

/** Delete and Edit for a message that did not go: Edit takes it back into the box (text and files), Delete drops it. */
function FailedActions({ m }: { m: MessageT }) {
  const client = useTalosClient()
  // The quoted message, so a failed reply can be edited and still be a reply.
  const parent = useTalos((s) =>
    m.reply_to ? ownValue(s.messages, m.thread_id)?.find((x) => x.id === m.reply_to) : undefined,
  )
  if (!('discardMessage' in client)) return null
  const discard = () => (client as SocketClient).discardMessage(m.id)
  const edit = async () => {
    await discard()
    const st = useComposerStore.getState()
    // The text joins whatever the owner has typed since; it never replaces it.
    st.prefillComposer(m.thread_id, m.text ?? '', 'append')
    if (m.reply_to)
      st.setReplyTo(m.thread_id, {
        id: m.reply_to,
        author: parent?.author === 'owner' ? 'owner' : parent?.author === 'agent' ? 'agent' : 'other',
        excerpt: parent?.text ? excerptOf(parent.text) : 'An earlier message',
      })
    // A message the relay gave up on waited out the whole buffer, and its files were deleted with it: those come back as
    // chips that say so, never as "ready" ones the relay would answer with a 410 and the agent would never get.
    const gone = m.receipt === 'not_delivered'
    st.setChips(m.thread_id, (cur) => [
      ...cur,
      ...(m.attachments ?? []).map((a) =>
        gone
          ? {
              key: `re-${a.media_id}`,
              name: a.name ?? 'file',
              state: 'error' as const,
              note: 'No longer stored. Attach it again.',
            }
          : { key: `re-${a.media_id}`, name: a.name ?? 'file', state: 'ready' as const, ref: a },
      ),
    ])
  }
  return (
    <span className="ml-auto flex justify-end gap-1">
      {/* A voice note has no words to take back: its recording is gone once it fails for good, so only Delete is honest. */}
      {m.kind !== 'voice_note' && (
        <button
          type="button"
          data-testid="send-failed-edit"
          onClick={() => void edit()}
          className="min-h-11 rounded-pill px-3 text-sm text-text underline"
        >
          Edit
        </button>
      )}
      <button
        type="button"
        data-testid="send-failed-delete"
        onClick={() => void discard()}
        className="min-h-11 rounded-pill px-3 text-sm text-danger underline"
      >
        Delete
      </button>
    </span>
  )
}

/** What a not-yet-confirmed owner message says about itself (visible text, not only an icon). */
function SendState({ m }: { m: MessageT }) {
  const client = useTalosClient()
  const failed = useConnectionMeta((s) => s.failed[m.id])
  const queued = useConnectionMeta((s) => s.queuedIds.includes(m.id))
  const waitingForPin = useTalos((s) => s.deviceId !== null && !s.devicePinned)
  if (failed === 'retry') {
    return (
      <div className="flex flex-wrap items-center justify-end">
        <button
          type="button"
          data-testid="send-failed"
          onClick={() => 'retryMessage' in client && (client as SocketClient).retryMessage(m.id)}
          className="block min-h-11 rounded-pill px-3 text-sm text-danger underline"
        >
          Failed, tap to retry
        </button>
        <FailedActions m={m} />
      </div>
    )
  }
  if (failed === 'final') {
    return (
      <div className="flex flex-wrap items-center justify-end">
        <p role="status" data-testid="send-failed" className="m-0 text-sm text-danger">
          {m.kind === 'voice_note' ? "Couldn't send this voice note." : "Couldn't send this message."}
        </p>
        <FailedActions m={m} />
      </div>
    )
  }
  if (m.receipt === 'not_delivered' && !failed && !queued) {
    return (
      <div className="flex flex-wrap items-center justify-end">
        <p role="status" data-testid="send-not-delivered" className="m-0 text-sm text-danger">
          {m.kind === 'voice_note'
            ? "This voice note did not reach your agent, and it's no longer waiting."
            : "This message did not reach your agent, and it's no longer waiting."}
        </p>
        <FailedActions m={m} />
      </div>
    )
  }
  if (queued && waitingForPin) {
    return (
      <p role="status" data-testid="send-held" className="m-0 text-sm text-text-2">
        Waiting for your Mac to confirm this device
      </p>
    )
  }
  return null
}

function Receipt({ m }: { m: MessageT }) {
  const queued = useConnectionMeta((s) => s.queuedIds.includes(m.id))
  const failed = useConnectionMeta((s) => Boolean(s.failed[m.id]))
  if (failed) return null
  if (queued)
    return (
      <span className="inline-flex items-center gap-1" role="img" aria-label="Waiting to send">
        <IconClock width={14} height={14} />
      </span>
    )
  if (m.receipt === 'not_delivered') return null // SendState says it in words
  if (m.receipt === 'seen')
    return (
      <span className="inline-flex items-center text-ok" role="img" aria-label="Seen">
        <IconChecks width={14} height={14} />
      </span>
    )
  if (m.receipt === 'delivered')
    return (
      <span className="inline-flex items-center" role="img" aria-label="Delivered">
        <IconChecks width={14} height={14} />
      </span>
    )
  if (m.receipt === 'sent')
    return (
      <span className="inline-flex items-center" role="img" aria-label="Sent">
        <IconCheck width={14} height={14} />
      </span>
    )
  return null
}

const excerptOf = (t: string) => {
  const one = t.replace(/\s+/g, ' ').trim()
  return one.length > 80 ? `${one.slice(0, 79)}…` : one
}

async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = t
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** How long "Copied" (or the failure) stays beside the time before the icon comes back. */
const COPY_NOTE_MS = 2000

/**
 * Copy in the row under a message. Same text and same helper as the menu's Copy. On touch the button is 44 tall: it makes the
 * row 44 tall, so it never covers what sits above or below.
 */
function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'ok' | 'fail' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  const copy = async () => {
    const ok = await copyText(text)
    setState(ok ? 'ok' : 'fail')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState(null), COPY_NOTE_MS)
  }
  return (
    <>
      <button
        type="button"
        data-testid="msg-copy-inline"
        aria-label="Copy message"
        onClick={copy}
        className={cn(
          '-my-1 inline-flex min-h-6 shrink-0 items-center gap-1.5 rounded-pill px-1.5 font-sans text-text-2 hover:text-text',
          // On touch the box is the height of the row (Listen is 44 tall in the same row on agent rows, and an owner row lets
          // the row use the bubble's bottom padding), so it never reaches up over text, a link or Run, nor down into the next
          // row, and it sits beside Time and Listen without overlapping them.
          'pointer-coarse:my-0 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center',
          REVEAL,
        )}
      >
        {state === 'ok' ? <IconCheck width={14} height={14} /> : <IconCopy width={14} height={14} />}
        <span>Copy</span>
      </button>
      <span role="status" data-testid="msg-copy-note" className={cn(state === null && 'sr-only')}>
        {state === 'ok' ? 'Copied' : state === 'fail' ? "Couldn't copy" : ''}
      </span>
    </>
  )
}

/** A finger that moves more than this many pixels is a scroll or a swipe, not a long-press. */
const PRESS_SLOP_PX = 10
/** How long a finger can rest on a message before the menu opens. */
const PRESS_MS = 500
/** After the finger lifts from a long-press, the taps the browser fakes (mouse, focus, click) are not a dismissal. */
const LIFT_GRACE_MS = 600

/**
 * Copy, Share and Reply for one message. The "..." button sits in the row under the message (`MessageMenuButton`), and the
 * same menu opens on a long press or right-click. Only for rows with text. The menu is anchored to the row itself.
 */
function MessageActions({ m, owner, children }: { m: MessageT; owner: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const press = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressFrom = useRef<{ x: number; y: number } | null>(null)
  const touching = useRef(false) // a finger is down on this row
  const armed = useRef(false) // the menu was opened by a finger that has not finished lifting
  const grace = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectedBefore = useRef(false) // text in this row was already selected when the mouse went down
  const replied = useRef(false) // Reply closed the menu: focus goes to the box, not back to the button
  const setReplyTo = useComposerStore((s) => s.setReplyTo)
  useEffect(
    () => () => {
      if (press.current) clearTimeout(press.current)
      if (grace.current) clearTimeout(grace.current)
    },
    [],
  )
  const text = m.text ?? ''
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current)
    press.current = null
    pressFrom.current = null
  }
  const openMenu = () => {
    armed.current = touching.current
    setOpen(true)
  }
  const lifted = () => {
    touching.current = false
    cancelPress()
    if (!armed.current) return
    if (grace.current) clearTimeout(grace.current)
    grace.current = setTimeout(() => {
      armed.current = false
      grace.current = null
    }, LIFT_GRACE_MS)
  }
  const focusBox = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus()
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setCopied(null)
      }}
    >
      <PopoverAnchor asChild>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: long-press and right-click are the touch and mouse routes to the menu; the keyboard route is the Message actions button inside */}
        <div
          className="group relative"
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('a, button, input, textarea')) return
            // Text was already selected in this message: the browser's own menu (with its Copy of just the selection) is what
            // they want. Read at mouse-down, because Safari selects the word under a right-click by itself.
            const had = selectedBefore.current
            selectedBefore.current = false
            if (had && !touching.current) return
            e.preventDefault()
            openMenu()
          }}
          onPointerDown={(e) => {
            // A finger on Copy, Listen or a link is a press on that control, not the start of a long-press on the row.
            if ((e.target as HTMLElement).closest('a, button, input, textarea')) return
            if (e.pointerType !== 'touch') {
              const sel = window.getSelection()
              selectedBefore.current = Boolean(
                sel && !sel.isCollapsed && sel.anchorNode && e.currentTarget.contains(sel.anchorNode),
              )
              return
            }
            touching.current = true
            cancelPress()
            pressFrom.current = { x: e.clientX, y: e.clientY }
            press.current = setTimeout(() => {
              press.current = null
              openMenu()
            }, PRESS_MS)
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'touch') lifted()
          }}
          onPointerMove={(e) => {
            const from = pressFrom.current
            if (!from) return
            if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > PRESS_SLOP_PX) cancelPress()
          }}
          onPointerCancel={(e) => {
            if (e.pointerType === 'touch') lifted()
          }}
        >
          {children}
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="flex w-44 flex-col gap-1 p-1"
        align={owner ? 'end' : 'start'}
        // The finger that opened the menu is still down, or has only just lifted: the focus and click events the browser
        // makes up from it land outside the menu and must not close it.
        onInteractOutside={(e) => {
          if (armed.current) e.preventDefault()
        }}
        onCloseAutoFocus={(e) => {
          if (!replied.current) return
          replied.current = false
          e.preventDefault() // Radix would hand focus back to the (hidden) button; the cursor belongs in the box
          focusBox()
        }}
      >
        <button
          type="button"
          data-testid="msg-copy"
          className="flex min-h-11 items-center rounded-button px-3 text-left hover:bg-surface-2"
          onClick={async () => setCopied((await copyText(text)) ? 'ok' : 'fail')}
        >
          {copied === 'ok' ? 'Copied' : copied === 'fail' ? "Couldn't copy" : 'Copy'}
        </button>
        <button
          type="button"
          data-testid="msg-share"
          className="flex min-h-11 items-center rounded-button px-3 text-left hover:bg-surface-2"
          onClick={async () => {
            try {
              const r = await getPlatform().share({ text })
              // 'unsupported' is also what a cancelled share sheet returns (platform.ts): close without a word.
              if (r === 'copied') setCopied('ok')
              else setOpen(false)
            } catch {
              setCopied('fail')
            }
          }}
        >
          Share
        </button>
        <button
          type="button"
          data-testid="msg-reply"
          className="flex min-h-11 items-center rounded-button px-3 text-left hover:bg-surface-2"
          onClick={() => {
            setReplyTo(m.thread_id, { id: m.id, author: owner ? 'owner' : 'agent', excerpt: excerptOf(text) })
            replied.current = true
            setOpen(false)
          }}
        >
          Reply
        </button>
      </PopoverContent>
    </Popover>
  )
}

/** The "..." that opens the message menu: last in the row under the message, never over its text. Only inside MessageActions. */
function MessageMenuButton() {
  return (
    <PopoverTrigger asChild>
      <button
        type="button"
        data-testid="msg-actions"
        aria-label="Message actions"
        className={cn(
          '-my-1 grid size-6 shrink-0 place-items-center rounded-pill font-sans text-sm text-text-2 hover:text-text',
          'pointer-coarse:my-0 pointer-coarse:size-11',
          REVEAL,
        )}
      >
        <span aria-hidden="true">⋯</span>
      </button>
    </PopoverTrigger>
  )
}

/** The line above a reply: what it answers. */
function QuotedParent({ m }: { m: MessageT }) {
  const parent = useTalos((s) =>
    m.reply_to ? ownValue(s.messages, m.thread_id)?.find((x) => x.id === m.reply_to) : undefined,
  )
  if (!m.reply_to) return null
  return (
    <p data-testid="msg-quote" className="m-0 mb-1 truncate border-l-2 border-line pl-2 text-sm text-text-2">
      {parent?.text ? excerptOf(parent.text) : 'An earlier message'}
    </p>
  )
}

function Body({ m, onOpenImage }: { m: MessageT; onOpenImage: (a: AttachmentRefT) => void }) {
  return (
    <>
      {m.text ? (
        m.format === 'markdown' ? (
          <Markdown text={m.text} run={runContextOf(m)} />
        ) : (
          <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{m.text}</p>
        )
      ) : null}
      {(m.attachments ?? []).length > 0 && (
        <div className={cn('flex flex-col gap-2', m.text && 'mt-2')}>
          {(m.attachments ?? []).map((a) => (
            <AttachmentView key={a.media_id} att={a} message={m} onOpenImage={onOpenImage} />
          ))}
        </div>
      )}
      {m.kind === 'voice_note' && (m.attachments ?? []).length === 0 && (
        <p className="m-0 text-sm text-text-2">Voice note (uploading…)</p>
      )}
    </>
  )
}

export function MessageView({
  message: m,
  cards,
  inbox,
  onOpenImage,
  onOpenItem,
}: {
  message: MessageT
  cards: CardT[]
  inbox: InboxItemT[]
  onOpenImage: (a: AttachmentRefT) => void
  onOpenItem: (i: InboxItemT) => void
}) {
  const agent = useAgentName()
  const threadName = useTalos((s) => s.threads.find((t) => t.id === m.thread_id)?.name ?? m.thread_id)

  // MCP Apps (bridge-minted only). A view row whose `app` did not parse degrades to a plain notice, never a crash.
  if (m.kind === 'app') return <AppRow m={m} />
  if (m.author === 'app') {
    return (
      <Suspense fallback={null}>
        <AppEchoRow message={m} />
      </Suspense>
    )
  }
  if (m.kind === 'card' && m.card_id) {
    const card = cards.find((c) => c.id === m.card_id)
    if (card) return <TimelineCard card={card} threadName={threadName} />
    // The card is not in this device's store (it expired while the device was away, or it was decided before this device
    // held it). The history row still has its heading, so show that, as a past item with no buttons, never an empty row.
    if (!m.text) return null
    const [title, ...rest] = m.text.split('\n')
    return (
      <div className="px-4 py-1" data-testid="msg-card-past" data-msg-id={m.id}>
        <div className="rounded-card border border-line px-3 py-2 text-sm">
          <p className="m-0 font-semibold">{title}</p>
          {rest.length > 0 && <p className="m-0 mt-1 whitespace-pre-wrap text-text-2">{rest.join('\n')}</p>}
          <p className="m-0 mt-1 text-xs text-text-2">This card is not open on this device.</p>
        </div>
      </div>
    )
  }
  if (m.kind === 'event' || m.author === 'hook') {
    const item = m.event_id ? inbox.find((i) => i.id === m.event_id) : undefined
    return (
      // the row swipes sideways itself (done / snooze), so the screen-edge swipe keeps out of it
      <div className="px-4 py-1" data-no-edge-swipe="">
        {item ? (
          <Suspense fallback={null}>
            <EventRow item={item} onOpen={onOpenItem} />
          </Suspense>
        ) : (
          <p className="m-0 rounded-card border border-line px-3 py-2 text-sm text-text-2">{m.text}</p>
        )}
      </div>
    )
  }
  if (m.kind === 'call_record') {
    return (
      <div className="px-4 py-2 text-center text-sm text-text-2">
        <IconMic width={14} height={14} className="mr-1 inline align-text-bottom" />
        Voice call · {m.call ? Math.max(1, Math.round(m.call.duration_s / 60)) : 0} min
        {m.call && m.call.delegations > 0 ? ` · ${m.call.delegations} handed to ${agent}` : ''}
      </div>
    )
  }
  if (m.author === 'system' && m.heartbeat) {
    // Text from outside (an issue title, a subject) is quoted under a label the app fixes itself, so it cannot pass as a Talos
    // notice, and a body that mentions a security check does not get the worried mascot. Newlines are kept.
    return (
      <div role="status" className="px-4 py-2 text-sm text-text-2" data-testid="msg-heartbeat" data-msg-id={m.id}>
        <p className="m-0 font-mono text-xs font-semibold" data-testid="heartbeat-label">
          Heartbeat
        </p>
        <blockquote className="m-0 mt-1 border-l-2 border-line pl-3 whitespace-pre-wrap" data-testid="heartbeat-body">
          {m.text}
        </blockquote>
      </div>
    )
  }
  if (m.author === 'system' && m.handoff) {
    // The label is data the bridge set, drawn apart from the body, so the body cannot pass itself off as a label or as a
    // bridge notice (and a body that mentions a security check does not get the worried mascot).
    return (
      <div role="status" className="px-4 py-2 text-sm text-text-2" data-testid="msg-handoff" data-msg-id={m.id}>
        <p className="m-0 font-mono text-xs font-semibold" data-testid="handoff-label">
          {m.handoff.label}
        </p>
        <blockquote className="m-0 mt-1 border-l-2 border-line pl-3 whitespace-pre-wrap" data-testid="handoff-body">
          {m.text}
        </blockquote>
      </div>
    )
  }
  if (m.author === 'system') {
    const failed = /security check/i.test(m.text ?? '')
    return (
      <div role="status" className="flex items-center justify-center gap-2 px-4 py-2 text-center text-sm text-text-2">
        {failed && <Mascot state="worried" size={24} name={agent} decorative animate={false} />}
        {m.text}
      </div>
    )
  }
  // A share through a token (an iOS Shortcut) is NOT the owner speaking: the sender cannot sign, so the note is data too.
  // It renders left, as "Shared via {label}", with the note inside the shared-content box (docs/V2-FEATURES.md V4.4, V4.7).
  if (m.via === 'share') {
    const source = `Shared via ${m.share_label ?? 'a share link'}`
    return (
      <article className="flex justify-start px-4 py-1" data-testid="msg-share" data-msg-id={m.id} aria-label={source}>
        <div className="w-full min-w-0 max-w-[85%] md:max-w-[75%]">
          <SharedContentBox content={m.share_content ?? {}} note={m.text} source={source} />
          {(m.attachments ?? []).length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              <Body m={{ ...m, text: undefined }} onOpenImage={onOpenImage} />
            </div>
          )}
          <time className="mt-1 block font-mono text-xs text-text-2" dateTime={m.created_at}>
            {clockTime(m.created_at)}
          </time>
        </div>
      </article>
    )
  }
  const owner = m.author === 'owner'
  // text a person can copy or reply to; a shared page or an app view has none of these
  const actionable = Boolean(m.text) && !m.share_content
  const hasVoice = (m.attachments ?? []).some((a) => a.kind === 'voice_note')
  const bubble = (
    <div
      className={cn(
        'min-w-0',
        owner
          ? 'figure-ground rounded-bubble rounded-br-md px-3.5 py-2.5 [@media(pointer:coarse)]:pb-0'
          : 'w-full text-text',
      )}
    >
      {m.kind === 'voice_turn' && (
        <IconMic width={14} height={14} className="mr-1 inline align-text-bottom text-text-2" />
      )}
      <QuotedParent m={m} />
      <Body m={m} onOpenImage={onOpenImage} />
      {m.share_content && Object.keys(m.share_content).length > 0 && (
        <div className={cn((m.text || (m.attachments ?? []).length > 0) && 'mt-2')}>
          <SharedContentBox content={m.share_content} source="Shared page" />
        </div>
      )}
      <div
        className={cn('mt-1 flex flex-wrap items-center gap-1 font-mono text-xs text-text-2', owner && 'justify-end')}
      >
        {hasVoice && m.attachments?.[0]?.duration_ms ? (
          <span className="sr-only">{formatDuration(m.attachments?.[0]?.duration_ms ?? 0)}</span>
        ) : null}
        <time dateTime={m.created_at}>{clockTime(m.created_at)}</time>
        {owner && <Receipt m={m} />}
        {actionable ? <CopyButton text={m.text ?? ''} /> : null}
        {/* The play button: an agent's own words only (never a shared page, an app view or a message the owner wrote). It
            shares the row so time, Copy, Listen and the menu are one 44 px row; its status text is full width and wraps below. */}
        {!owner && actionable ? <SpeakButton m={m} /> : null}
        {actionable ? <MessageMenuButton /> : null}
      </div>
      {owner && <SendState m={m} />}
    </div>
  )
  return (
    <article
      className={cn('flex px-4 py-1', owner ? 'justify-end' : 'justify-start')}
      data-testid={owner ? 'msg-owner' : 'msg-agent'}
      data-msg-id={m.id}
      aria-label={owner ? 'You' : agent}
    >
      <div className={cn('min-w-0', owner ? 'max-w-[85%] md:max-w-[75%]' : 'w-full')}>
        {actionable ? (
          <MessageActions m={m} owner={owner}>
            {bubble}
          </MessageActions>
        ) : (
          bubble
        )}
      </div>
    </article>
  )
}

/** The timeline row for an app view: the agent's caption (markdown) above the card. */
function AppRow({ m }: { m: MessageT }) {
  const view = m.app
  return (
    <article className="px-4 py-1" data-testid="msg-app" data-msg-id={m.id}>
      {m.text ? (
        <div className="mb-2">
          {m.format === 'markdown' ? (
            <Markdown text={m.text} />
          ) : (
            <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{m.text}</p>
          )}
        </div>
      ) : null}
      {view ? (
        <Suspense
          fallback={<div className="h-40 animate-pulse rounded-card bg-surface-2" data-testid="app-suspense" />}
        >
          <AppViewCard view={view} />
        </Suspense>
      ) : (
        <p data-testid="app-unreadable" className="m-0 rounded-card border border-line px-3 py-2 text-sm text-text-2">
          This app can't be shown here. Update Talos to see it.
        </p>
      )}
      <time className="mt-1 block font-mono text-xs text-text-2" dateTime={m.created_at}>
        {clockTime(m.created_at)}
      </time>
    </article>
  )
}

export function TimelineCard({
  card,
  threadName,
  highlighted,
}: {
  card: CardT
  threadName: string
  /** Opened from a push or /card/:id: a permission card opens its approval sheet by itself. */
  highlighted?: boolean
}) {
  return (
    <div id={`card-${card.id}`} className="enter-up px-4 py-2" data-testid="timeline-card">
      <Suspense fallback={<div className="h-24 animate-pulse rounded-card bg-surface-2" />}>
        <CardView card={card} threadName={threadName} inline {...(highlighted ? { highlighted } : {})} />
      </Suspense>
    </div>
  )
}
