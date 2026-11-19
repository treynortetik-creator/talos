// The count of cards waiting on the owner in this thread, as a small chip in the thread's header. It takes no row of its own;
// tapping it scrolls to the first such card. The negative margin lets its 44 px tap area overlap the header's padding, so
// the header never grows.

import { cn } from '../../ui/cn.ts'
import { StatusDot } from '../../ui/StatusDot.tsx'
import { useAwaitingOwner } from '../cards/useAwaitingOwner.ts'

/**
 * Brings a card of the thread timeline into view, its top just under the top of the conversation (its scroll margin). Not the middle: until its code has
 * loaded a card is a short placeholder, and a tap then (a slow phone, the first card of a session) centred the placeholder;
 * the card then grew downward out of view. From the top it grows into the space below it.
 * Instant, not smooth (like the timeline's own jumps): the timeline follows the bottom until a scroll event says the view
 * has left the end, and the first steps of a smooth scroll are still near the end. Content that grew then (the cards' code
 * arriving) was followed, and the view went back to the bottom with the card out of sight.
 */
export function scrollToCard(cardId: string | undefined) {
  if (!cardId) return
  document.getElementById(`card-${cardId}`)?.scrollIntoView({ block: 'start' })
}

export function NeedsYouChip({ threadId, onChrome }: { threadId: string; onChrome?: boolean }) {
  const pending = useAwaitingOwner(threadId)
  // the Inbox shows its cards above the conversation, so it has nothing to scroll to
  if (pending.length === 0 || threadId === 'inbox') return null
  const n = pending.length
  return (
    <button
      type="button"
      data-testid="needs-you-chip"
      aria-label={`${n} ${n === 1 ? 'needs' : 'need'} you, show the first`}
      onClick={() => scrollToCard(pending[0]?.id)}
      className="-my-2 grid min-h-11 min-w-11 shrink-0 place-items-center rounded-pill"
    >
      <span
        data-chip-face
        className={cn(
          'inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-xs font-medium leading-tight',
          onChrome ? 'border-on-chrome-2 text-on-chrome' : 'border-line bg-surface text-text',
        )}
      >
        <StatusDot shape="solid" size={8} className="text-warn" />
        {n}
      </span>
    </button>
  )
}
