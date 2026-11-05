// Props contracts between feature areas. Seam: frozen after WP0 (WP8 may edit). WP6 renders these components through
// `registry.ts`; WP4 and WP7 implement them. Components read state with `useTalos` and act through `useTalosClient`;
// they never receive a client as a prop.
import type { AppViewT, CardT, InboxItemT, MessageT } from '@talos-app/protocol'
import type { ComponentType } from 'react'

export type CardViewProps = {
  card: CardT
  /** Display name of the card's thread (`Email · General`). */
  threadName: string
  /** Pulse the card for 1.2 s (deep link from a push). */
  highlighted?: boolean
  /**
   * Opened from a push's Approve button (armed in memory by the native shell). Never approves by itself: a live high-risk card starts its normal
   * primary flow, which still needs the Face ID confirmation before anything is sent; any other card only gets focus on
   * its primary button. Expired, altered or already decided cards ignore it.
   */
  armPrimary?: boolean
  /** Inline in a timeline (true) or in the right-hand detail panel (false). */
  inline?: boolean
}

export type EventRowProps = {
  item: InboxItemT
  /** Row tapped: WP6 opens the item sheet. */
  onOpen?: (item: InboxItemT) => void
}

export type LiveCallButtonProps = {
  threadId: string
  /** No server voice key, Mac offline, or already on a call. */
  disabled?: boolean
}

export type CallBarProps = {
  threadId: string
  onEnd: () => void
}

export type CallScreenProps = {
  threadId: string
  onEnd: () => void
}

export type SettingsSectionProps = {
  /** The Mac is offline, so config edits are read-only. */
  readOnly: boolean
}

export type SettingsSectionDef = {
  id: string
  title: string
  /** Position in the settings list (spec 8.5 numbering: Account 1, Notifications 2, Agent 3, Voice 4, Integrations 5, Health 6.5 (with Connection), Appearance 7). */
  order: number
  /** Absent for a section that is a full screen on its own route (`href`): Integrations and Health. */
  Component?: ComponentType<SettingsSectionProps>
  /** The route the list row opens, when the section is its own screen. */
  href?: string
}

export type HomeScreenProps = Record<string, never>
export type InboxScreenProps = Record<string, never>
export type IntegrationsScreenProps = { readOnly?: boolean }
export type IntegrationWizardProps = {
  /** Preselected integration id, if the route carries one. */
  integrationId?: string
  onDone: () => void
}
export type ConnectionDetailProps = { connectionId: string }

// v2 features (WP-V0 placeholders; each builder keeps these props)
export type SearchScreenProps = Record<string, never>
export type ContextViewProps = { threadId: string; messageId: string }
export type HitRowProps = { title: string; snippet: string; onOpen?: () => void }
export type MemoryScreenProps = Record<string, never>
export type DriveScreenProps = Record<string, never>
export type ShareScreenProps = Record<string, never>
export type HealthScreenProps = Record<string, never>

/** MCP Apps (AP3): one app view in the timeline, and the quiet row for what a view said to the agent. */
export type AppViewCardProps = { view: AppViewT }
export type AppEchoRowProps = { message: MessageT }
