import type { BugReportDestinationT } from '@talos-app/protocol'

// The words of the bug reporter. One copy: the dialog, the phone sheet, the palette item and the Help page read these.
export const BUG_TEXT = {
  title: 'Report a bug',
  paletteLabel: 'Report a bug',
  helpRow: 'Report a bug',
  helpRowNote: 'Take a picture of this screen, mark it up and send it with the details below.',
  screenshotTaken: (time: string, where: string) => `Screenshot taken ${time} · ${where}`,
  tools: { pen: 'Pen', arrow: 'Arrow', box: 'Box', text: 'Text', blur: 'Blur', undo: 'Undo' },
  inks: ['Amber ink', 'Blue ink', 'White ink'],
  toolsLabel: 'Annotation tools',
  inkLabel: 'Ink colour',
  canvasLabel: 'Screenshot. Draw on it to mark the problem.',
  /** Under the picture on a phone once it is there (the line that said "Getting the screen…" keeps its place). */
  drawHint: 'Draw on it to mark the problem.',
  textPrompt: 'Text to put on the screenshot',
  wentWrong: 'What went wrong?',
  wentWrongHint: 'Say what you did and what happened.',
  required: 'Tell us what went wrong first.',
  expected: 'What did you expect?',
  optional: '(optional)',
  attached: 'Attached automatically',
  versions: 'Versions: app, bridge, relay, Claude Code',
  threadScreen: 'This thread and screen',
  recentErrors: (n: number | null) => `Recent errors (${n ?? '…'})`,
  logs: 'Logs, last 200 lines, cleaned',
  messages: 'Last 5 messages in this thread',
  preview: 'Preview everything that will be sent',
  previewTitle: 'Everything that will be sent',
  previewClose: 'Close preview',
  privacy:
    'Keys, tokens and your home folder are removed. Blur anything else on the screenshot. Nothing leaves this Mac until you press Send.',
  /** Where the report goes, as the relay says (`null` while it has not said, or could not). */
  goesTo: (d: BugReportDestinationT | null): string => {
    if (d === null) return 'Goes to: your relay and your Mac. The relay has not said whether it passes reports on.'
    if (d.to === 'relay') return 'Goes to: your relay and your Mac, with the screenshot. It is not sent anywhere else.'
    if (d.to === 'team') return 'Goes to: your relay and your Mac, then the Talos team, with the screenshot.'
    return `Goes to: your relay and your Mac, then ${d.host} (the words and details, not the screenshot).`
  },
  close: 'Close',
  done: 'Done',
  cancel: 'Cancel',
  send: 'Send report',
  gathering: 'Gathering details…',
  sending: 'Sending…',
  sent: 'Sent. Thank you.',
  failed: 'Could not send the report. Nothing was lost; try again.',
  rateLimited: 'You have sent several reports lately. Try again in a little while.',
  unavailable: 'Not available from this Mac yet',
  captureFailed: "Couldn't take a picture of this screen. You can still send the report without one.",
  noPicture: 'No screenshot',
  capturing: 'Getting the screen…',
  /** WebKit (the iPhone app, Safari, the Mac app) cannot read back a drawn page, so no picture was attempted. */
  captureUnsupported:
    "This app can't take a picture of its own screen here. Add one if it helps, or send the report without one.",
  addPicture: 'Add a picture',
  replacePicture: 'Use another picture',
  pictureUnreadable: "That file isn't a picture this app can open.",
  phone: {
    cancel: 'Cancel',
    title: 'Report a bug',
    send: 'Send',
    previewRow: 'Versions, recent errors, cleaned logs',
    previewAction: 'Preview',
    privacy: 'Keys and tokens are removed. Nothing is sent until you tap Send.',
  },
} as const

/** What the Help page says about the picture, so nobody is surprised by what it cannot show. */
export const BUG_CAPTURE_LIMITS =
  'The picture is made from the page itself, so a picture from another website, a video or an embedded frame shows as a grey box, and a font may look slightly different.'
