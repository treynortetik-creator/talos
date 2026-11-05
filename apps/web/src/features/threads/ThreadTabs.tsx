import { ownValue } from '@talos-app/protocol'
import { useEffect, useRef } from 'react'
import { NavLink, useLocation } from 'react-router'
import { useTalos } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { ThreadIcon } from '../../ui/ThreadIcon.tsx'
import { useVisibleThreads } from './useThreads.ts'

/** Slim tab bar of all threads under the thread header, with unread counts. */
export function ThreadTabs() {
  const threads = useVisibleThreads()
  const unread = useTalos((s) => s.unread)
  const strip = useRef<HTMLElement | null>(null)
  const { pathname } = useLocation()
  // The selected tab is never left cut off at the strip's edge.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the route or the tab list changes
  useEffect(() => {
    const active = strip.current?.querySelector<HTMLElement>('[aria-current="page"]')
    if (active && typeof active.scrollIntoView === 'function')
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [pathname, threads.length])
  return (
    <nav
      ref={strip}
      aria-label="Threads"
      className="fade-end flex gap-1 overflow-x-auto border-b border-line px-2 pr-8 [scrollbar-width:none] md:[mask-image:none]"
      data-testid="thread-tabs"
    >
      {threads.map((t) => (
        <NavLink
          key={t.id}
          to={`/t/${t.id}`}
          className={({ isActive }) =>
            cn(
              '-mb-px flex min-h-12 shrink-0 items-center gap-2 border-b-[3px] px-3 text-sm transition-colors duration-[var(--dur-1)] ease-talos',
              isActive ? 'border-accent font-semibold text-text' : 'border-transparent text-text-2 hover:text-text',
            )
          }
        >
          <ThreadIcon id={t.id} icon={t.icon} color={t.color} size={22} framed />
          {t.name}
          {(ownValue(unread, t.id) ?? 0) > 0 && (
            <span
              className="min-w-5 rounded-pill bg-accent px-1.5 text-center font-mono text-xs leading-5 text-on-accent"
              role="img"
              aria-label={`${ownValue(unread, t.id)} unread`}
            >
              {ownValue(unread, t.id)}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  )
}
