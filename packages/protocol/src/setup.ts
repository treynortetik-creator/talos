import { z } from 'zod'
import { IntegrationId } from './ids.ts'

// Data that drives the "add integration" wizard (7.7). Defined here so the relay (catalog endpoint),
// packages/integrations (specs) and the web app (wizard) share one schema.

export const FilterOption = z.object({ key: z.string(), label: z.string(), default: z.boolean() })

export const CredentialField = z.object({
  type: z.literal('field'),
  key: z.string(),
  label: z.string(),
  secret: z.boolean(),
  pattern: z.string().optional(),
  help: z.string().optional(),
})

export const SetupStep = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), md: z.string() }),
  z.object({ type: z.literal('link'), label: z.string(), href_template: z.string() }), // {{HOOK_URL}}, {{MANIFEST_URL}}
  z.object({ type: z.literal('copy'), label: z.string(), value_template: z.string(), secret: z.boolean() }),
  CredentialField,
  z.object({ type: z.literal('script'), template_id: z.string() }),
  z.object({ type: z.literal('repo_picker') }),
])

export const SetupSpec = z.object({
  id: IntegrationId,
  name: z.string(),
  category: z.enum(['personal', 'work']),
  icon: z.string(),
  blurb: z.string().max(140), // screen 1 tile subtitle
  default_thread: z.enum(['inbox', 'work']), // 'work' = config.work.thread ?? 'inbox' (7.1 routing)
  filters: z.array(FilterOption),
  connect: z.array(SetupStep),
  test_hint: z.string(),
  poll: z.object({ every_s: z.number() }).optional(),
})

export type SetupSpecT = z.infer<typeof SetupSpec>
export type SetupStepT = z.infer<typeof SetupStep>
