// `/settings` (8.5): the sections list on phones, two columns on tablet and up. WP6 provides Account, Notifications,
// Connection and Appearance; Agent, Voice and Integrations come from the registry and are merged by `order`.

import { type ComponentType, Suspense, useMemo } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { useTalos } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import {
  IconBack,
  IconBell,
  IconBook,
  IconChat,
  IconChevron,
  IconLink,
  IconMic,
  IconPlug,
  IconSettings,
  IconSun,
  IconUser,
} from '../../ui/icons.tsx'
import { Meander } from '../../ui/Meander.tsx'
import { ScrollRegion } from '../../ui/ScrollRegion.tsx'
import { useAgentUnsaved } from '../agent-config/useAgentUnsaved.ts'
import type { SettingsSectionProps } from '../contracts.ts'
import { HELP_PATH } from '../help/path.ts'
import { settingsSections as external } from '../registry.ts'
import { Banners } from '../threads/Banners.tsx'
import { AccountSection, AppearanceSection, NotificationsSection } from './sections.tsx'
import { useMediaQuery } from './useMedia.ts'

const SECTION_ICON: Record<string, typeof IconSettings> = {
  account: IconUser,
  notifications: IconBell,
  agent: IconChat,
  voice: IconMic,
  integrations: IconPlug,
  health: IconLink,
  appearance: IconSun,
  help: IconBook,
}

type Def = { id: string; title: string; order: number; Component?: ComponentType<SettingsSectionProps>; href?: string }

/** Sections that write synced config through the Mac: read-only, and said so, while the Mac is offline (audit U11). */
export const WRITES_SYNCED_CONFIG = ['agent', 'notifications', 'voice', 'thread-sessions', 'session']

export function useSections(): Def[] {
  return useMemo(
    () =>
      [
        { id: 'account', title: 'Account', order: 1, Component: AccountSection },
        { id: 'notifications', title: 'Notifications', order: 2, Component: NotificationsSection },
        ...external,
        { id: 'appearance', title: 'Appearance', order: 7, Component: AppearanceSection },
        // The last row: Talos Help is its own page (one text, shared with the Mac app's Help menu).
        { id: 'help', title: 'Help', order: 99, href: HELP_PATH },
      ].sort((a, b) => a.order - b.order) as Def[],
    [],
  )
}

export function SettingsScreen({ children }: { children?: React.ReactNode }) {
  const { section } = useParams()
  const nav = useNavigate()
  const sections = useSections()
  const wide = useMediaQuery('(min-width: 768px)')
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const agentUnsaved = useAgentUnsaved()
  const active = sections.find((s) => s.id === section)

  // The old Connection page now lives in Health.
  if (section === 'connection') return <Navigate to="/settings/health" replace />
  if (section && !active && !children) return <Navigate to="/settings" replace />
  // A section that is its own screen (Integrations, Health) opens on its route
  if (active?.href && !children) return <Navigate to={active.href} replace />
  if (wide && !section && !children) return <Navigate to="/settings/account" replace />

  const list = (
    <nav
      aria-label="Settings sections"
      className={cn('flex flex-col', wide ? 'w-64 shrink-0 gap-0.5 border-r border-line p-2' : 'min-w-0 flex-1 p-4')}
    >
      <div
        className={cn(
          'flex flex-col',
          !wide && 'incised divide-y divide-line overflow-hidden rounded-card bg-surface p-1',
        )}
      >
        {sections.map((s) => {
          const Icon = SECTION_ICON[s.id] ?? IconSettings
          return (
            <Link
              key={s.id}
              to={s.href ?? `/settings/${s.id}`}
              aria-current={s.id === section ? 'page' : undefined}
              className={cn(
                'flex min-h-14 items-center gap-3 px-4 text-base transition-colors duration-[var(--dur-1)] ease-talos hover:bg-surface-2 md:min-h-11 md:rounded-button md:px-3 md:text-sm',
                s.id === section && wide ? 'bg-surface-2 font-semibold' : '',
              )}
            >
              <Icon width={20} height={20} className="shrink-0 text-text-2" />
              <span className="flex-1">{s.title}</span>
              {s.id === 'agent' && agentUnsaved ? (
                <span data-testid="agent-unsaved-marker" className="shrink-0 text-xs font-medium text-warn">
                  Unsaved changes
                </span>
              ) : null}
              <IconChevron width={18} height={18} className="text-text-2 md:hidden" />
            </Link>
          )
        })}
      </div>
    </nav>
  )

  const body = children ?? (
    <div className="mx-auto w-full max-w-2xl p-4">
      {active?.Component && (
        <Suspense fallback={<p className="text-text-2">Loading…</p>}>
          <active.Component readOnly={!macOnline && WRITES_SYNCED_CONFIG.includes(active.id)} />
        </Suspense>
      )}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="top-band">
        <header className="flex items-center gap-1 px-2 pt-[env(safe-area-inset-top)]">
          {(section || children) && (
            <button
              type="button"
              aria-label="Back to settings"
              onClick={() => nav(wide ? '/' : '/settings')}
              className="grid size-11 place-items-center md:hidden"
            >
              <IconBack />
            </button>
          )}
          <h1 className="m-0 py-3.5 pl-2 font-display text-2xl font-semibold">Settings</h1>
        </header>
        <Meander />
      </div>
      <Banners />
      <div className="flex min-h-0 flex-1">
        {wide || (!section && !children) ? list : null}
        {(wide || section || children) && (
          <ScrollRegion label="Settings content" className="min-h-0 flex-1 overflow-y-auto">
            {body}
          </ScrollRegion>
        )}
      </div>
    </div>
  )
}
