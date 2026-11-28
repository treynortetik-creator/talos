// "Add plugin to agent" from the phone: the owner names a plugin and its marketplace; the bridge answers with ONE card (or why not) in a
// `plugin.add.result` under the same `control_id`. Nothing is installed until the owner taps that card (apps/bridge/src/plugins/agent-plugins.ts).
// Signed and strict, like every owner frame. Only a relay that lists PLUGIN_ADD_FEATURE passes the frames, and the app offers the form only with it.
import { z } from 'zod'
import { frame, ownerFrame } from './frame-base.ts'
import { CardId, IsoTs, Ulid } from './ids.ts'

export const PLUGIN_ADD_FEATURE = 'plugin-add/1'

/** A plugin or marketplace name as it may be typed: plain characters only, so it can never be anything but a name in a command. */
export const PluginName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)

export const PluginAddRequestFrame = ownerFrame('plugin.add.request', {
  control_id: Ulid,
  plugin: PluginName,
  marketplace: PluginName,
})
export const PluginAddResultFrame = frame('plugin.add.result', {
  control_id: Ulid,
  ok: z.boolean(),
  /** Plain words, written by the bridge: why not, or that the owner was asked. */
  text: z.string().max(400),
  card_id: CardId.optional(),
  at: IsoTs,
})
export const PLUGIN_ADD_OWNER_FRAME_TYPES = ['plugin.add.request'] as const
export const PLUGIN_ADD_BRIDGE_FRAME_TYPES = ['plugin.add.result'] as const
