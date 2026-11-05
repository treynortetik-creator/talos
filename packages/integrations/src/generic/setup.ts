import type { IntegrationIdT, SetupSpecT } from '@talos-app/protocol'
import { SetupSpec } from '@talos-app/protocol'

const POINTER = '^(/([^/~]|~[01])*)*$'

/** Setup spec shared by `generic` and the three tool-specific copies. Only the copy differs. */
export function genericSetup(args: {
  id: IntegrationIdT
  name: string
  icon: string
  blurb: string
  steps: string
}): SetupSpecT {
  return {
    id: args.id,
    name: args.name,
    category: 'personal',
    icon: args.icon,
    blurb: args.blurb,
    default_thread: 'inbox',
    filters: [],
    connect: [
      { type: 'text', md: args.steps },
      { type: 'copy', label: 'URL', value_template: '{{HOOK_URL}}', secret: false },
      { type: 'copy', label: 'Authorization header', value_template: 'Bearer {{SECRET}}', secret: true },
      {
        type: 'text',
        md: 'Body: any JSON. Include `title`, `summary` and `url` and {agent} uses them as-is. Otherwise, tell us where to find them (JSON pointers like `/issue/title`).',
      },
      {
        type: 'field',
        key: 'map_title',
        label: 'Title field (optional)',
        secret: false,
        pattern: POINTER,
        help: 'Optional. JSON pointer, for example /issue/title.',
      },
      {
        type: 'field',
        key: 'map_summary',
        label: 'Summary field (optional)',
        secret: false,
        pattern: POINTER,
        help: 'Optional. JSON pointer, for example /issue/body.',
      },
      {
        type: 'field',
        key: 'map_url',
        label: 'Link field (optional)',
        secret: false,
        pattern: POINTER,
        help: 'Optional. JSON pointer, for example /issue/html_url.',
      },
    ],
    test_hint: 'Send a test request from the app, or tap Test here.',
  }
}

export const genericAppSetup: SetupSpecT = SetupSpec.parse(
  genericSetup({
    id: 'generic',
    name: 'Any app',
    icon: 'webhook',
    blurb: 'Anything that can send a webhook, in Zapier, Make, n8n or your own code.',
    steps:
      'Add a **Webhook / HTTP request** step in the app you want to hear from. Method **POST**. Use the URL and header below, and send any JSON as the body.',
  }),
)
