// The wizard's and the connection page's words for a Slack connection made for an agent's bot (identity 'bot'). The
// wording itself lives in the catalog (packages/integrations/src/slack/setup.ts) next to the owner's.
import { slackBot } from '@talos-app/integrations/catalog'
import type { Conn, Spec } from './data.ts'

export type SlackIdentity = 'owner' | 'bot'
export { slackBot }

/** Whose Slack a connection listens to; undefined for every other integration. */
export const identityOf = (c: Pick<Conn, 'integration'> & { identity?: SlackIdentity }): SlackIdentity | undefined =>
  c.integration === 'slack' ? (c.identity ?? 'owner') : undefined

/** A switch's label, in the bot's words on a bot connection. */
export const filterLabel = (key: string, label: string, identity: SlackIdentity | undefined): string =>
  identity === 'bot' ? (slackBot.filterLabels[key] ?? label) : label

/** The connection's name as the wizard makes it. */
export const connName = (spec: Spec, identity: SlackIdentity): string =>
  identity === 'bot' ? `${spec.name} (agent's bot)` : spec.name

/** One line for the list and the connection page, so both kinds can be told apart. */
export const IDENTITY_LINE: Record<SlackIdentity, string> = { owner: 'Your messages', bot: "An agent's bot" }
