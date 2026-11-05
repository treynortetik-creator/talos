// The words of Talos Help. This file is the only copy: the Help page in the app (phone, browser and the Mac app's Talos
// window) renders it, and the Mac's Help menu items open that page. Plain words for a non-engineer.
//
// Two kinds of marker keep the text honest, and `test/help/help-truth.test.ts` checks every one against the code:
//   [[Name]]   a name on screen (a button, a switch, a menu item, a tab). It must exist in the app's own source.
//   {{talos-app logs}}   a Terminal command. Its first word after `talos-app` must be a command the CLI really has.
//   ((Settings → Agent → Timezone))   a path on screen. Its first part must be a real Settings section, Mac settings tab or
//                        menu, and each later part must be a label on that very section or tab. Any other arrow in the text fails.
// They work in prose, steps, row notes, limits and key text alike.
// A row's `where` is a path (Settings, then a section, then a label). The test checks the section is a row of the real
// Settings list and that each label is in that section's own source files.

export type Place = 'settings' | 'mac' | 'thread' | 'menubar' | 'topmenu' | 'terminal'

/** How each place reads on the page. Test: these names are the ones the rest of this file uses. */
export const PLACE_NAME: Record<Place, string> = {
  settings: 'Settings',
  mac: 'Mac settings',
  thread: 'Thread settings',
  menubar: 'Menu bar',
  topmenu: 'Top menu',
  terminal: 'Terminal',
}

export type Where = { place: Place; path: string[] }

export type QA = { q: string; where: Where[]; note?: string }
export type Key = { keys: string; what: string; when: string }
export type Fix = { id: string; q: string; steps: string[] }

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'steps'; items: string[] }
  | { kind: 'where'; rows: QA[] }
  | { kind: 'fix'; rows: Fix[] }
  | { kind: 'keys'; groups: Array<{ title: string; rows: Key[] }> }
  | { kind: 'limits'; rows: Array<{ q: string; a: string }> }

export type Section = { id: string; title: string; blocks: Block[] }

/** Where the long guide lives. Named once; the page holds no variable tables or server detail. */
export const SETUP_GUIDE = 'docs/SETUP.md'

const w = (place: Place, ...path: string[]): Where => ({ place, path })

export const HELP_SECTIONS: Section[] = [
  {
    id: 'which',
    title: 'Which settings is which',
    blocks: [
      {
        kind: 'p',
        text: 'Talos has three places to change things. [[Settings]] is the page inside the app. It looks the same on your phone, in a browser and in the Talos window on your Mac, and it holds everything shared by all your devices: names, notifications, voice, threads and connections. On a phone, tap Open menu, then Settings.',
      },
      {
        kind: 'p',
        text: '[[Mac settings]] is a separate window that only the Mac app has. It holds what belongs to this Mac: the agent folder and launch command, sign-in, macOS permissions, the quick-compose hotkey, the Companion and the Dock icon. Open it from the Talos menu at the top of the screen ([[Settings…]], or ⌘,) or from the Talos icon in the Mac menu bar.',
      },
      {
        kind: 'p',
        text: '[[Terminal]] is the Mac’s Terminal app. The {{talos-app}} command does a few jobs from there, such as adding a device or reading the log. Many Settings are saved on your Mac and copied to every device, so those pages are read-only while your Mac is offline.',
      },
    ],
  },
  {
    id: 'where',
    title: 'Where do I change…',
    blocks: [
      {
        kind: 'where',
        rows: [
          {
            q: 'See my devices, or end one',
            where: [w('settings', 'Account', 'Devices')],
            note: '[[Revoke]] ends that device’s access.',
          },
          { q: 'Sign out of this phone or browser', where: [w('settings', 'Account', 'Sign out of this device')] },
          { q: 'Sign out of every device', where: [w('settings', 'Account', 'Sign out everywhere')] },
          {
            q: 'Add a device',
            where: [w('terminal', 'talos-app enroll')],
            note: 'Run it on your Mac. On a phone or computer browser, open the link it prints on that device. For the iPhone app, copy the link and paste it into the app ([[Paste a setup link]], on its sign-in screen): opening the link on the iPhone opens Safari, which sets up a Home Screen copy instead. ((Settings → Account → Add a device)) gives the short version.',
          },
          {
            q: 'Stop chat notifications on every device',
            where: [w('settings', 'Notifications', 'Chat notifications')],
            note: 'Alarms about your Mac or the server still come through.',
          },
          {
            q: 'Quiet hours',
            where: [w('settings', 'Notifications', 'Quiet hours')],
            note: 'The timezone they use is set under ((Settings → Agent → Timezone)).',
          },
          {
            q: 'One thread’s notifications',
            where: [w('thread', 'Notifications'), w('settings', 'Notifications', 'Per thread')],
          },
          {
            q: 'Hide thread names in notifications',
            where: [w('settings', 'Notifications', 'Show thread names')],
            note: 'This changes browser notifications. iPhone notifications always show General and Inbox by name and call every other thread “a thread”, whatever it is set to.',
          },
          {
            q: 'Turn notifications on for this browser',
            where: [w('settings', 'Notifications', 'Push on this device')],
          },
          {
            q: 'Turn notifications on for this iPhone',
            where: [w('settings', 'Notifications', 'iPhone notifications')],
          },
          {
            q: 'Send a test notification',
            where: [w('settings', 'Notifications', 'Send a test notification')],
            note: 'The [[Send a test notification]] button is in a browser once its notifications are on, and in the iPhone app once iPhone notifications are on. The Mac app has no test button. In a browser, a test ignores the switch and the thread rules, so it can arrive while real notifications are off.',
          },
          { q: 'The agent’s name, or yours', where: [w('settings', 'Agent', 'Names')] },
          { q: 'Timezone', where: [w('settings', 'Agent', 'Timezone')] },
          { q: 'Which thread new things land in', where: [w('settings', 'Agent', 'Default thread')] },
          {
            q: 'Rename, reorder or archive threads',
            where: [w('settings', 'Agent', 'Manage threads')],
            note: 'On a phone, one thread’s own settings are under Open menu, then the pencil beside its name. On a computer they are the ⋯ button at the top of the thread.',
          },
          {
            q: 'Stop the agent’s turn, compact, or start a new conversation',
            where: [
              w('settings', 'Session', 'Stop'),
              w('settings', 'Session', 'Compact'),
              w('settings', 'Session', 'New conversation'),
            ],
            note: '[[Stop]] shows only while the agent is working.',
          },
          {
            q: 'The agent’s model or effort',
            where: [w('settings', 'Session', 'Model'), w('settings', 'Session', 'Effort')],
            note: 'Effort changes apply from the next message.',
          },
          {
            q: 'Let a thread have its own session',
            where: [
              w('settings', 'Thread sessions', 'Allow threads to have their own session'),
              w('thread', 'Own session'),
            ],
          },
          {
            q: 'Live-call voice',
            where: [w('settings', 'Voice', 'Live-call voice')],
            note: 'It applies from your next call.',
          },
          { q: 'Hands-free or hold to talk', where: [w('settings', 'Voice', 'Microphone')] },
          {
            q: 'When replies are spoken aloud',
            where: [w('settings', 'Voice', 'Voice-note replies')],
            note: 'Your Mac reads them with its speech command. That is a different voice from the live-call voice.',
          },
          { q: 'Driving mode', where: [w('settings', 'Voice', 'Driving mode')] },
          { q: 'Connect an app, such as Gmail or GitHub', where: [w('settings', 'Integrations')] },
          {
            q: 'Share into Talos from other apps',
            where: [
              w('settings', 'Share from other apps', 'Use the iPhone share sheet'),
              w('settings', 'Share from other apps', 'Create a share link'),
            ],
          },
          {
            q: 'Check what is wrong, or send a test alert',
            where: [w('settings', 'Health', 'Send test alert'), w('settings', 'Health', 'Copy diagnostics')],
          },
          {
            q: 'Light or dark theme, and text size',
            where: [w('settings', 'Appearance', 'Theme'), w('settings', 'Appearance', 'Text size')],
            note: 'Both are saved on this device only.',
          },
          {
            q: 'The agent folder and launch command',
            where: [w('mac', 'Session', 'Agent folder'), w('mac', 'Session', 'Launch command')],
          },
          {
            q: 'Restart the agent after a crash, or open the terminal when it needs you',
            where: [
              w('mac', 'Session', 'Restart the agent after a crash'),
              w('mac', 'Session', 'Open the terminal when the agent needs you'),
            ],
          },
          {
            q: 'The relay address, or sign this Mac in',
            where: [w('mac', 'Connection', 'Relay address'), w('mac', 'Connection', 'Sign in…')],
          },
          { q: 'End this Mac’s access to your account', where: [w('mac', 'Connection', 'Forget this Mac…')] },
          { q: 'macOS permissions, such as notifications', where: [w('mac', 'Permissions')] },
          { q: 'The quick-compose hotkey', where: [w('mac', 'Hotkeys', 'Quick compose hotkey')] },
          {
            q: 'The Companion, the little character on screen',
            where: [w('mac', 'Companion', 'Show Companion'), w('menubar', 'Show Companion')],
          },
          {
            q: 'Start Talos at login, or show a Dock icon',
            where: [w('mac', 'General', 'Start Talos when I log in'), w('mac', 'General', 'Show a Dock icon')],
          },
          {
            q: 'Start, stop or restart the agent',
            where: [w('menubar', 'Start session'), w('menubar', 'Stop session'), w('menubar', 'Restart session')],
          },
          {
            q: 'Quit Talos',
            where: [w('topmenu', 'Talos', 'Quit Talos')],
            note: 'With tmux the agent keeps running. Without it Talos stops the agent first, waiting at most 15 seconds. Logging out or shutting down never waits.',
          },
          {
            q: 'See the agent’s terminal',
            where: [w('menubar', 'Terminals…'), w('topmenu', 'Window', 'Terminals…')],
          },
        ],
      },
    ],
  },
  {
    id: 'setup',
    title: 'First setup, in order',
    blocks: [
      {
        kind: 'p',
        text: `The full guide for the server and the Mac is ${SETUP_GUIDE} in the Talos folder. This is the order on the Mac app once those are done.`,
      },
      {
        kind: 'steps',
        items: [
          'Open the Setup checklist: Window menu or Menu bar, then [[Setup checklist…]]. Its first row, Agent folder, is the step that makes your setup. Type or browse to a folder, then press Create (a new Talos agent in a new or empty folder), Adopt (a Claude Code folder you already use: a card shows what would change, and only its .mcp.json, plus the hooks of any MCP apps you have, changes) or Choose (a Talos agent folder you already have). Talos then starts the session itself, unless Claude is not signed in. Until you do this, nothing starts and no setup file exists. To use your own launch command instead, open [[Mac settings]], then Session, paste the whole command and press Import: it saves, starts the session and tells you so.',
          'Sign in: [[Sign in…]] in the Window menu, in the Menu bar, or in ((Mac settings → Connection)). Talos shows four words; type y in the small terminal pane when they match the Talos window. If the button cannot start it, the Set up Talos window shows the exact command with a Copy button. Run it in Terminal, paste the link it prints into the Talos window (not a browser), and type y in Terminal when the four words match.',
          'Allow the macOS permissions in ((Mac settings → Permissions)).',
          'Start the agent: ((Menu bar → Start session)). The first start of an agent folder shows a confirmation screen in the terminal that you answer yourself.',
          'Add your phone: run {{talos-app enroll}} in Terminal. For a phone browser, open the link it prints on the phone. For the iPhone app, copy the link and paste it into the app with [[Paste a setup link]] on its sign-in screen: opening the link on the iPhone opens Safari, which sets up a Home Screen copy instead.',
        ],
      },
      {
        kind: 'p',
        text: 'Anything you change in Mac settings before step 1 is kept, and joins your setup when you Create, Adopt, Choose or Import.',
      },
    ],
  },
  {
    id: 'fix',
    title: 'Fix it',
    blocks: [
      {
        kind: 'fix',
        rows: [
          {
            id: 'no-notifications',
            q: 'I get no notifications',
            steps: [
              'Open ((Settings → Notifications)). Check [[Chat notifications]] is on, and that [[Quiet hours]] are not holding things back right now.',
              'Under [[Per thread]], make sure the thread is not set to Off.',
              'On a browser, [[Push on this device]] must read On; press [[Turn on notifications]] if it does not. On the iPhone app, open [[iPhone notifications]]; if it says it is blocked, turn notifications back on for Talos in the iPhone Settings app. On the Mac app, [[Banners on this Mac]] shows what macOS allows; if it says Blocked, allow Talos under System Settings, then Notifications.',
              'To test, press [[Send a test notification]] in a browser that has notifications on, or in the iPhone app once [[iPhone notifications]] is on. The Mac app has no test button. In a browser, if the test arrives but real ones do not, a switch, quiet hours or a thread rule is holding them back.',
            ],
          },
          {
            id: 'mac-offline',
            q: 'The app says my Mac is offline',
            steps: [
              'Look at the Talos icon in the Mac menu bar. A head with a slash through it means the agent, the bridge or the server is down. Choose [[Start session]] if the agent is stopped.',
              'A Mac that has gone to sleep cannot answer. While it is plugged in, [[Keep this Mac awake while plugged in]] in ((Mac settings → General)) stops it sleeping on its own. A closed lid or Sleep from the Apple menu still puts it to sleep.',
              'In Terminal, {{talos-app status}} and {{talos-app doctor}} say what is wrong in plain lines, and {{talos-app logs}} shows the bridge log.',
              '((Settings → Health)) on your phone shows what the server can see, even while the Mac is off.',
            ],
          },
          {
            id: 'locked-out',
            q: 'I am locked out on my iPhone',
            steps: [
              'The iPhone app signs in with a setup link from your Mac, not a password. On the Mac, run {{talos-app enroll}} in Terminal.',
              'On the iPhone, press [[Paste a setup link]] on the sign-in screen and paste the link.',
              'Signing out of the iPhone app, or revoking it, always needs a new link. Nothing is deleted from your Mac.',
            ],
          },
          {
            id: 'dialog',
            q: 'The agent is stuck on a dialog',
            steps: [
              'A dot on the Talos icon in the Mac menu bar means something needs you. Choose [[Terminals…]] and answer the dialog in the pane yourself.',
              'To have Talos bring the terminal forward for you, turn on [[Open the terminal when the agent needs you]] in ((Mac settings → Session)).',
            ],
          },
          {
            id: 'no-replies',
            q: 'No replies after a restart',
            steps: [
              'The first lines of the Menu bar menu say Session, Bridge and Relay. If the Bridge says unknown, restart the agent once ([[Restart session]]) so it runs the current bridge.',
              'If Talos says another session holds the channels, the agent is still running in Terminal. Stop that one first.',
              'Run {{talos-app doctor}} in Terminal. It lists what does not match, and {{talos-app logs}} shows the end of the bridge log.',
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'keys',
    title: 'Keyboard shortcuts',
    blocks: [
      {
        kind: 'keys',
        groups: [
          {
            title: 'Mac app, top menu',
            rows: [
              {
                keys: '⌘,',
                what: 'Settings…',
                when: 'While Talos is the front app. The top menu appears when a Talos window is open or the Dock icon is on.',
              },
              { keys: '⌘T', what: 'Show Talos', when: 'Same as above.' },
              {
                keys: '⌘K',
                what: 'Terminals…',
                when: 'The key shown beside the item in the Window menu. To be sure of it, choose Window, then Terminals….',
              },
              { keys: '⌘N', what: 'Quick compose…', when: 'Same as above.' },
              { keys: '⌘W', what: 'Close', when: 'Same as above.' },
              { keys: '⌘M', what: 'Minimize', when: 'Same as above.' },
              { keys: '⌘H', what: 'Hide Talos', when: 'Same as above.' },
              { keys: '⌥⌘H', what: 'Hide Others', when: 'Same as above.' },
              { keys: '⌘Q', what: 'Quit Talos', when: 'Same as above.' },
            ],
          },
          {
            title: 'Mac app, from anywhere',
            rows: [
              {
                keys: '⌃⌥Space',
                what: 'Quick compose',
                when: 'From any app. This is the default; change it in ((Mac settings → Hotkeys)). In the box, ⌘↩ sends and Esc closes it.',
              },
            ],
          },
          {
            title: 'Mac app, Menu bar menu',
            rows: [
              { keys: '⌘T', what: 'Show Talos', when: 'Shown beside the item in the Talos icon’s menu.' },
              { keys: '⌘N', what: 'Quick compose…', when: 'Shown beside the item in the Talos icon’s menu.' },
              { keys: '⌘K', what: 'Terminals…', when: 'Shown beside the item in the Talos icon’s menu.' },
              { keys: '⌘,', what: 'Settings…', when: 'Shown beside the item in the Talos icon’s menu.' },
              { keys: '⌘Q', what: 'Quit Talos', when: 'The item’s name goes on to say what happens to the agent.' },
            ],
          },
          {
            title: 'In a web browser on a computer',
            rows: [
              {
                keys: '⌘1 to ⌘9, or Ctrl+1 to Ctrl+9',
                what: 'Open thread 1 to 9, in the order of the thread list',
                when: 'On the app’s main screens. Not on this Help page or the sign-in screen.',
              },
              {
                keys: '⌘K or Ctrl+K',
                what: 'Search',
                when: 'On the app’s main screens. Not on this Help page or the sign-in screen.',
              },
              {
                keys: '⌘\\ or Ctrl+\\',
                what: 'Fold or unfold the sidebar',
                when: 'On the main screens wide enough to show the sidebar, and not while a sheet is open.',
              },
              {
                keys: 'Esc',
                what: 'Close the side panel',
                when: 'On the app’s main screens. Not on this Help page or the sign-in screen.',
              },
              {
                keys: 'Enter',
                what: 'Send the message',
                when: 'In the message box on a computer. Shift+Enter starts a new line. On a touch screen Enter is always a new line.',
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'limits',
    title: 'What cannot be done',
    blocks: [
      {
        kind: 'limits',
        rows: [
          {
            q: 'Delete a thread',
            a: 'Threads can only be archived, and an archived thread can be restored.',
          },
          {
            q: 'Change the iPhone app’s relay address',
            a: 'The relay address (the server the app talks to) is fixed when the iPhone app is built.',
          },
          { q: 'Rename a device', a: 'The Devices list shows a device’s name and lets you end it. It has no rename.' },
          {
            q: 'Check for updates inside the app',
            a: 'There is no Check for updates button. See About below for how to update.',
          },
          {
            q: 'Make the spoken-reply voice the live-call voice',
            a: 'They are two voices. The live-call voice is a Settings choice; spoken replies use your Mac’s speech command.',
          },
        ],
      },
    ],
  },
  {
    id: 'about',
    title: 'About',
    blocks: [
      {
        kind: 'p',
        text: 'Logs. The Mac app writes its log to ~/Library/Logs/Talos/supervisor.log. ((Mac settings → General)) has [[Show the Mac app’s log]], which opens it in Finder, and [[Show desktop.json]] for your Mac settings file. The bridge writes bridge.log in ~/.config/talos/app (or the folder named by TALOS_APP_HOME). {{talos-app logs}} prints it, and {{talos-app report}} makes one file you can send with a bug report; it has keys, tokens and your home folder removed.',
      },
      {
        kind: 'p',
        text: 'Updating. Talos does not update itself. In Terminal, run {{talos-app update}} from your Talos folder, then restart the agent: it keeps running the old code until you do. The server redeploys from Railway when you push to your GitHub copy. For the Mac app, run apps/desktop/scripts/build-app.sh and then apps/desktop/scripts/install.sh from the Talos folder; with tmux the agent keeps running through it. The iPhone app updates through TestFlight.',
      },
      {
        kind: 'p',
        text: 'Uninstalling. Turn off [[Start Talos when I log in]] in ((Mac settings → General)), choose [[Forget this Mac…]] in ((Mac settings → Connection)), then quit Talos and delete Talos.app from the Applications folder inside your home folder. Your settings are in ~/Library/Application Support/Talos and your logs in ~/Library/Logs/Talos; delete them if you want them gone. To remove the rest, follow “Uninstalling” in docs/SETUP.md. It lists the talos-app entry in the agent folder’s .mcp.json, the ~/.config/talos/app folder (your message history is in there) and the Railway project.',
      },
    ],
  },
]

export { HELP_PATH } from './path.ts'

/** A message the Ask button puts in the box. The owner reads and sends it; Talos never sends it for them. */
export const ASK_DRAFT = 'I need help with Talos. '

/** Names this page says do not exist. A test checks none of them has appeared in the app, so these lines cannot go stale. */
export const ABSENT_LABELS = ['Check for updates', 'Delete thread', 'Uninstall Talos']

/** Every sentence as plain text, markers removed: for the search box, the tests, and any other reader of this page. */
export function stripMarkers(text: string): string {
  return text
    .replace(/\[\[(.+?)\]\]/g, '$1')
    .replace(/\{\{(.+?)\}\}/g, '$1')
    .replace(/\(\((.+?)\)\)/g, '$1')
}

export function whereText(x: Where): string {
  return [PLACE_NAME[x.place], ...x.path].join(' → ')
}

/** All the text of a block, for search. */
export function blockText(b: Block): string {
  switch (b.kind) {
    case 'p':
      return stripMarkers(b.text)
    case 'steps':
      return b.items.map(stripMarkers).join(' ')
    case 'where':
      return b.rows.map(rowText).join(' ')
    case 'fix':
      return b.rows.map((r) => `${r.q} ${r.steps.map(stripMarkers).join(' ')}`).join(' ')
    case 'keys':
      return b.groups
        .map((g) => `${g.title} ${g.rows.map((r) => `${r.keys} ${r.what} ${stripMarkers(r.when)}`).join(' ')}`)
        .join(' ')
    case 'limits':
      return b.rows.map((r) => `${r.q} ${stripMarkers(r.a)}`).join(' ')
  }
}

export function rowText(r: QA): string {
  return `${r.q} ${r.where.map(whereText).join(' ')} ${stripMarkers(r.note ?? '')}`
}

export function allText(): string {
  return HELP_SECTIONS.map((s) => `${s.title}\n${s.blocks.map(blockText).join('\n')}`).join('\n')
}
