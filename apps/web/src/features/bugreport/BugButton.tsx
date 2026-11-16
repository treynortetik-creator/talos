// One tap to Report a bug, on every screen (the owner, 2026-11-14: "easy, pretty visible, and on every page"). Two
// placements: B (the default; below), and A, an icon in each screen's header beside its own controls. `?bugbtn=a` or `?bugbtn=b` switches this
// device and is kept, so the other one can be tried for a while. The button never appears in the report's picture
// (data-no-capture, capture.ts).

import { cn } from '../../ui/cn.ts'
import { IconBug } from '../../ui/icons.tsx'
import { openBugReport } from './store.ts'

export type BugPlacement = 'a' | 'b'

export const BUG_PLACEMENT_KEY = 'talos.bugbtn'

/** Which placement this device shows: `?bugbtn=a|b` switches it (and is kept across launches); B by default. */
export function bugPlacement(): BugPlacement {
  let q: string | null = null
  try {
    q = new URLSearchParams(location.search).get('bugbtn')
  } catch {}
  if (q === 'a' || q === 'b') {
    try {
      localStorage.setItem(BUG_PLACEMENT_KEY, q)
    } catch {} // storage refused: the address still decides this load
    return q
  }
  try {
    return localStorage.getItem(BUG_PLACEMENT_KEY) === 'a' ? 'a' : 'b'
  } catch {
    return 'b'
  }
}

/** A: the icon in a header row, the same size and ink as the header's other controls. */
export function BugHeaderButton({ onChrome = false, className }: { onChrome?: boolean; className?: string }) {
  if (bugPlacement() !== 'a') return null
  return (
    <button
      type="button"
      aria-label="Report a bug"
      title="Report a bug"
      data-testid="bug-button"
      data-no-capture=""
      onClick={() => void openBugReport()}
      className={cn(
        'grid size-11 shrink-0 place-items-center rounded-pill',
        onChrome ? 'text-on-chrome-2 hover:bg-chrome-hover hover:text-on-chrome' : 'text-text-2 hover:bg-surface-2',
        className,
      )}
    >
      <IconBug width={20} height={20} />
    </button>
  )
}

// B (Pantheon's pick, 2026-11-14): nothing floats over content. Off a thread it is a slot in the phone's bottom tab bar and
// a row in the desktop sidebar's footer (Nav.tsx); in a thread on a phone (no tab bar there) it sits in the timeline's own
// bottom-right corner, under jump-to-latest, with room kept below the last row (Timeline.tsx).

/** The B button's look in a tab bar or a sidebar row is the caller's; this is the one shared action and name. */
export const BUG_LABEL = 'Report a bug'

/** B in a thread on a phone: rendered by the timeline in its bottom-right stack, under jump-to-latest. */
export function BugThreadButton() {
  if (bugPlacement() !== 'b') return null
  return (
    <button
      type="button"
      aria-label={BUG_LABEL}
      title={BUG_LABEL}
      data-testid="bug-button"
      data-no-capture=""
      onClick={() => void openBugReport()}
      className="grid size-11 shrink-0 place-items-center rounded-pill border border-line bg-surface text-text-2 shadow-md hover:text-text md:hidden"
    >
      <IconBug width={20} height={20} />
    </button>
  )
}

/** B on a phone screen with no tab bar and no timeline (a past conversation from search, a card or thread still loading):
 *  the same corner button, pinned to the bottom right of that screen's own box, which holds no controls there. */
export function BugCornerButton() {
  if (bugPlacement() !== 'b') return null
  return (
    <div className="pointer-events-none absolute right-3 bottom-3 md:hidden [&>*]:pointer-events-auto">
      <BugThreadButton />
    </div>
  )
}
