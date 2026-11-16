// The accordion button on a parent thread's row: opens and closes its sub-threads (subThreads.ts keeps the choice). It sits at
// the right end of the row, just left of the "..." (ThreadRowWithSettings `controls`), so rows without sub-threads keep their
// place. The touch is 44 x 44 px everywhere; the parent's link leaves room for it on the right (SUB_TOGGLE_PAD).
import type { ThreadT } from '@talos-app/protocol'
import { cn } from '../../ui/cn.ts'
import { IconChevron } from '../../ui/icons.tsx'
import { setSubThreadsOpen } from './subThreads.ts'

/** The right padding of a parent's link: the "..." (up to 44 px at right 4 px) and this 44 px chevron beside it. */
export const SUB_TOGGLE_PAD = 'pr-24'

export function SubThreadToggle({
  parent,
  subs,
  open,
  tone = 'chrome',
}: {
  parent: Pick<ThreadT, 'id' | 'name'>
  subs: readonly unknown[]
  open: boolean
  tone?: 'chrome' | 'surface'
}) {
  const label = `${open ? 'Hide' : 'Show'} ${subs.length} sub-thread${subs.length === 1 ? '' : 's'} of ${parent.name}`
  return (
    <button
      type="button"
      data-testid={`subthreads-toggle-${parent.id}`}
      aria-expanded={open}
      aria-controls={`subthreads-${parent.id}`}
      aria-label={label}
      title={label}
      onClick={() => setSubThreadsOpen(parent.id, !open)}
      className={cn(
        // left of the "...": it is 36 px wide on a mouse and 44 px on touch, from 4 px off the right edge
        'absolute top-1/2 right-10 grid size-11 -translate-y-1/2 place-items-center rounded-button pointer-coarse:right-12',
        tone === 'chrome'
          ? 'text-on-chrome-2 hover:bg-chrome-hover hover:text-on-chrome'
          : 'text-text-2 hover:bg-surface-2 hover:text-text',
      )}
    >
      <IconChevron
        width={16}
        height={16}
        className={cn('transition-transform duration-[var(--dur-1)] ease-talos', open ? '-rotate-90' : 'rotate-90')}
      />
    </button>
  )
}
