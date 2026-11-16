// The commands list as data (docs/HOOKS-AND-COMMANDS.md A): the JSON `talos commands --json` prints, version 1. Additive: a new
// optional field does not bump `schema`; renaming or removing one does. Readers ignore keys they do not know.
import { z } from 'zod'

export const COMMAND_EFFECTS = ['read', 'writes_home', 'writes_agent_dir', 'network', 'changes_app'] as const
export type CommandEffect = (typeof COMMAND_EFFECTS)[number]
/** `ask` means behind an approval card. */
export const COMMAND_RISKS = ['low', 'ask', 'high'] as const
export type CommandRisk = (typeof COMMAND_RISKS)[number]
/**
 * `agent`: a person may run it, or ask the agent to. `internal`: run by Talos itself (nothing enforces that). `owner_terminal`:
 * refused unless stdin and stdout are a terminal. ('owner', advice nobody enforced, was retired on 2026-11-14.)
 */
export const COMMAND_WHO = ['agent', 'internal', 'owner_terminal'] as const
export type CommandWho = (typeof COMMAND_WHO)[number]

/** Who runs it, from a row of the table (`who` absent means `agent`). */
export function commandWho(c: { who?: string | undefined; needs_terminal?: true | boolean | undefined }): CommandWho {
  return c.needs_terminal ? 'owner_terminal' : c.who === 'internal' ? 'internal' : 'agent'
}

export const CommandInfo = z.object({
  name: z.string().min(1),
  summary: z.string().min(1),
  /** who === 'agent', kept for readers of schema 1. */
  agent_may_run: z.boolean(),
  needs_terminal: z.literal(true).optional(),
  args: z.string().optional(),
  who: z.enum(COMMAND_WHO).optional(),
  effects: z.array(z.enum(COMMAND_EFFECTS)).optional(),
  risk: z.enum(COMMAND_RISKS).optional(),
})
export type CommandInfoT = z.infer<typeof CommandInfo>

export const CommandsList = z.object({
  schema: z.literal(1),
  app_version: z.string(),
  enforced: z.string(),
  note: z.string(),
  commands: z.array(CommandInfo),
})
export type CommandsListT = z.infer<typeof CommandsList>
