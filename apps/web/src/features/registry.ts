// Lazy entry points for features owned by other work packages. Seam: frozen after WP0 (WP8 may edit).
// WP6 imports from here only, so WP4 and WP7 can replace their placeholder components without touching the shell.
import { type ComponentType, lazy } from 'react'
import type {
  AppEchoRowProps,
  AppViewCardProps,
  CallBarProps,
  CallScreenProps,
  CardViewProps,
  ContextViewProps,
  DriveScreenProps,
  EventRowProps,
  HealthScreenProps,
  HitRowProps,
  HomeScreenProps,
  InboxScreenProps,
  IntegrationsScreenProps,
  LiveCallButtonProps,
  MemoryScreenProps,
  SearchScreenProps,
  SettingsSectionDef,
  SettingsSectionProps,
  ShareScreenProps,
} from './contracts.ts'

function lazyNamed<P extends object, M extends Record<string, unknown>>(
  load: () => Promise<M>,
  name: keyof M,
): React.LazyExoticComponent<ComponentType<P>> {
  return lazy(async () => ({ default: (await load())[name] as ComponentType<P> }))
}

// WP7
export const CardView = lazyNamed<CardViewProps, typeof import('./cards/index.tsx')>(
  () => import('./cards/index.tsx'),
  'CardView',
)
export const HomeScreen = lazyNamed<HomeScreenProps, typeof import('./home/index.tsx')>(
  () => import('./home/index.tsx'),
  'HomeScreen',
)
export const InboxScreen = lazyNamed<InboxScreenProps, typeof import('./inbox/index.tsx')>(
  () => import('./inbox/index.tsx'),
  'InboxScreen',
)
export const EventRow = lazyNamed<EventRowProps, typeof import('./inbox/index.tsx')>(
  () => import('./inbox/index.tsx'),
  'EventRow',
)
export const IntegrationsScreen = lazyNamed<IntegrationsScreenProps, typeof import('./integrations/index.tsx')>(
  () => import('./integrations/index.tsx'),
  'IntegrationsScreen',
)

// WP4
export const LiveCallButton = lazyNamed<LiveCallButtonProps, typeof import('./voice/index.tsx')>(
  () => import('./voice/index.tsx'),
  'LiveCallButton',
)
export const CallBar = lazyNamed<CallBarProps, typeof import('./voice/index.tsx')>(
  () => import('./voice/index.tsx'),
  'CallBar',
)
export const CallScreen = lazyNamed<CallScreenProps, typeof import('./voice/index.tsx')>(
  () => import('./voice/index.tsx'),
  'CallScreen',
)

// v2 features (WP-V0 placeholders; WP-V3/V4/V5/V6 replace the screens)
export const SearchScreen = lazyNamed<SearchScreenProps, typeof import('./search/index.tsx')>(
  () => import('./search/index.tsx'),
  'SearchScreen',
)
export const ContextView = lazyNamed<ContextViewProps, typeof import('./search/index.tsx')>(
  () => import('./search/index.tsx'),
  'ContextView',
)
export const HitRow = lazyNamed<HitRowProps, typeof import('./search/index.tsx')>(
  () => import('./search/index.tsx'),
  'HitRow',
)
export const MemoryScreen = lazyNamed<MemoryScreenProps, typeof import('./memory/index.tsx')>(
  () => import('./memory/index.tsx'),
  'MemoryScreen',
)
export const DriveScreen = lazyNamed<DriveScreenProps, typeof import('./drive/index.tsx')>(
  () => import('./drive/index.tsx'),
  'DriveScreen',
)
export const ShareScreen = lazyNamed<ShareScreenProps, typeof import('./share/index.tsx')>(
  () => import('./share/index.tsx'),
  'ShareScreen',
)
export const HealthScreen = lazyNamed<HealthScreenProps, typeof import('./health/index.tsx')>(
  () => import('./health/index.tsx'),
  'HealthScreen',
)

/** Settings sections owned outside WP6 (Agent, Voice, Integrations). WP6 merges them with its own by `order`. */
export const settingsSections: SettingsSectionDef[] = [
  {
    id: 'agent',
    title: 'Agent',
    order: 3,
    Component: lazyNamed<SettingsSectionProps, typeof import('./agent-config/index.tsx')>(
      () => import('./agent-config/index.tsx'),
      'AgentSettingsSection',
    ),
  },
  {
    // CC-C3: Claude Code session (model, effort, usage, commands). Order 3.5 = right after Agent.
    id: 'session',
    title: 'Session',
    order: 3.5,
    Component: lazyNamed<SettingsSectionProps, typeof import('./session/index.tsx')>(
      () => import('./session/index.tsx'),
      'SessionSettingsSection',
    ),
  },
  {
    // Option C (docs/OPTION-C.md): the master switch for a thread's own session, and the thread-session rows
    id: 'thread-sessions',
    title: 'Thread sessions',
    order: 3.6,
    Component: lazyNamed<SettingsSectionProps, typeof import('./thread-sessions/index.tsx')>(
      () => import('./thread-sessions/index.tsx'),
      'ThreadSessionsSection',
    ),
  },
  {
    id: 'voice',
    title: 'Voice',
    order: 4,
    Component: lazyNamed<SettingsSectionProps, typeof import('./voice/index.tsx')>(
      () => import('./voice/index.tsx'),
      'VoiceSettingsSection',
    ),
  },
  {
    // A full screen on its own route (/settings/integrations): the list row links there, so no inline Component.
    id: 'integrations',
    title: 'Integrations',
    order: 5,
    href: '/settings/integrations',
  },
  {
    // WP-V4: share tokens (docs/V2-FEATURES.md V4.4). A relay feature: it works with the Mac offline.
    id: 'share',
    title: 'Share from other apps',
    order: 5.5,
    Component: lazyNamed<SettingsSectionProps, typeof import('./share/index.tsx')>(
      () => import('./share/index.tsx'),
      'ShareSettingsSection',
    ),
  },
  {
    // V2 WP-V1: Settings -> Health, with the Mac / server connection lines that used to be Settings -> Connection. A relay
    // feature that works with the Mac offline; its own route (/settings/health).
    id: 'health',
    title: 'Health',
    order: 6.5,
    href: '/settings/health',
  },
]

// MCP Apps (AP3)
export const AppViewCard = lazyNamed<AppViewCardProps, typeof import('./apps/index.tsx')>(
  () => import('./apps/index.tsx'),
  'AppViewCard',
)
export const AppEchoRow = lazyNamed<AppEchoRowProps, typeof import('./apps/index.tsx')>(
  () => import('./apps/index.tsx'),
  'AppEchoRow',
)
