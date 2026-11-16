// The Developer page (owner ruling 2026-11-15: "a full dev settings panel where you can toggle on and off all the specific settings
// you may or may not want"). One row per guard, each its own switch with one line on what it does; the page is drawn from this
// table, and each row's value lives in config.json `dev.<key>` (config.ts, settings-table.ts). A fresh install has every row at its
// default: the guards on. First slices: the thread fence, and the notes lookup for thread sessions (turning it off opens nothing). Later rows (thread command allow-list, privilege ceiling, hook-source seal,
// launch seal, key guard, restart limits, live-session cap, guards, screen tools' system areas, the personal-vault fence) are added
// here as they are built, each with its own row in the settings table.

export type DevRow = {
  /** The key under `dev` in config.json, and the settings path `dev.<key>`. */
  readonly key: 'thread_fence' | 'note_lookup'
  /** The switch's name on the page. */
  readonly title: string
  /** What it does when on, in one line. */
  readonly on: string
  /** What turning it off means, in one line. */
  readonly off: string
  /** A fresh install's value. */
  readonly default: boolean
  /** The row's value in Developer mode: the open setting. A row whose off opens nothing stays on. */
  readonly open: boolean
  /** When a change takes effect. */
  readonly when: string
}

export const DEV_ROWS: readonly DevRow[] = [
  {
    key: 'thread_fence',
    title: 'Thread fence',
    on: "A thread's own session and its sub-agents can't read or write the Talos home (your messages, keys, settings).",
    off: 'They get the same access the main session has, the Talos home included, and no more.',
    default: true,
    open: false,
    when: "at each thread session's next start",
  },
  {
    key: 'note_lookup',
    title: 'Notes that may matter',
    on: "When your message names someone or something you have a note about, a thread's own session is pointed at that note and can read it.",
    off: 'A thread session gets no such pointers; it can still read a note it is asked to open.',
    default: true,
    open: true, // turning it off opens nothing, so Developer mode leaves it on
    when: 'at the next message',
  },
]

/** The settings path of a developer row. */
export const devPath = (key: DevRow['key']): `dev.${DevRow['key']}` => `dev.${key}`
