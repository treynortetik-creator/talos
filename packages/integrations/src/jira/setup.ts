import type { SetupSpecT } from '@talos-app/protocol'

export const jiraSetup: SetupSpecT = {
  id: 'jira',
  name: 'Jira',
  category: 'work',
  icon: 'ticket',
  blurb:
    'Issues assigned to you and comments on issues you watch. Off until you turn it on. Ask your IT team before connecting these.',
  default_thread: 'work',
  filters: [
    { key: 'assigned', label: 'Issues assigned to you', default: true },
    { key: 'comments', label: 'Comments on issues you watch', default: true },
    { key: 'status', label: 'Status changes', default: false },
  ],
  connect: [
    {
      type: 'text',
      md: '**Ask your IT team before connecting these.** This uses your own Jira API token and reads only what you can already see. No admin is needed for it, but your workplace may have rules about API tokens.',
    },
    {
      type: 'text',
      md: '**1.** Open your Atlassian API tokens page, choose **Create API token with scopes**, name it "Talos", pick **Jira**, tick **read:jira-work** and **read:jira-user**, expiry 365 days. **2.** Paste your site, email and token. {agent} checks every 3 minutes for issues assigned to you or that you watch.',
    },
    {
      type: 'link',
      label: 'Open API tokens',
      href_template: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    },
    {
      type: 'field',
      key: 'site',
      label: 'Jira site',
      secret: false,
      pattern: '^(https://)?[a-zA-Z0-9][a-zA-Z0-9-]*\\.atlassian\\.net/?$',
      help: 'For example yourteam.atlassian.net',
    },
    { type: 'field', key: 'email', label: 'Atlassian email', secret: false, pattern: '^[^\\s@]+@[^\\s@]+$' },
    { type: 'field', key: 'token', label: 'API token', secret: true },
    {
      type: 'text',
      md: '_Optional, for real-time updates:_ create an Automation rule with a **Send web request** action. Use the URL and secret below, header `Authorization: Bearer <secret>`, and the JSON body in the Jira guide.',
    },
    { type: 'copy', label: 'Automation rule URL', value_template: '{{HOOK_URL}}', secret: false },
  ],
  test_hint: 'Assign an issue to yourself from another account, or ask someone to.',
  poll: { every_s: 180 },
}
