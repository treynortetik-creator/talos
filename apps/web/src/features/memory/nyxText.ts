// Every word on the Nyx screen, in one place. Plain words: the owner reads these on a phone.
export const NYX_TEXT = {
  title: 'Nyx',
  intro: "Your team's memory lives in Nyx. Connect it here.",
  addressLabel: 'Nyx address',
  addressHint: 'The https address of your Nyx, for example https://nyx.example.com',
  connect: 'Connect',
  saving: 'Connecting…',
  cancel: 'Cancel',
  connectedTo: (host: string) => `Connected to ${host}`,
  open: 'Open Nyx',
  change: 'Change address',
  // Never "opened": a browser that blocks the new tab (a phone, after the save's round trip) still reports it as opened.
  saved: 'Saved. Next:',
  signIn: 'Sign in to Nyx',
  loading: 'Loading…',
  macOffline: "Your Mac is offline, so Nyx can't be connected now.",
  notConnected: 'Not connected yet. You can connect Nyx once you are.',
  agentsTitle: 'Add Nyx to agents',
  agentsSoon: "Coming soon: this adds Nyx to each agent's own Claude setup.",
  mainAgent: 'Main agent',
} as const
