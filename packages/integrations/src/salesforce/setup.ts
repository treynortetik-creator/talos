import type { SetupSpecT } from '@talos-app/protocol'

export const salesforceSetup: SetupSpecT = {
  id: 'salesforce',
  name: 'Salesforce',
  category: 'work',
  icon: 'cloud',
  blurb: 'Notes from a Flow outbound message. Off until you turn it on. Ask your IT team before connecting these.',
  default_thread: 'work',
  filters: [{ key: 'notifications', label: 'Outbound message notifications', default: true }],
  connect: [
    {
      type: 'text',
      md: '**Ask your IT team before connecting these.** An admin has to build a Flow with an outbound message and add this address as its endpoint. Nothing here works until they have.',
    },
    { type: 'copy', label: 'Endpoint URL for the outbound message', value_template: '{{HOOK_URL}}', secret: false },
    {
      type: 'field',
      key: 'org_id',
      label: 'Organization Id',
      secret: false,
      pattern: '^00D[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$',
      help: 'Starts with 00D. Messages from any other org are refused.',
    },
  ],
  test_hint: 'Ask the admin to trigger the Flow once.',
}
