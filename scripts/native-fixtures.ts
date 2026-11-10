// Fixtures for the native-shell JS bridge (packages/protocol/src/native.ts): one valid sample and the JSON Schema of every
// message, in packages/protocol/fixtures/native/messages.json. The native apps are built against this file, so a schema
// change must show up as a diff someone reads.
//
//   node scripts/native-fixtures.ts [--dir <fixtures dir>]            write the fixtures
//   node scripts/native-fixtures.ts --check [--dir <fixtures dir>]    exit 1 if the file differs from the schemas
//
// Also refuses (exit 1) when a sample does not pass its own schema, or a message that must be rejected is accepted.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NATIVE_TO_WEB, nativeJsonSchema, WEB_TO_NATIVE } from '../packages/protocol/src/native.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DIR = join(root, 'packages/protocol/fixtures/native')

const SAMPLES: Record<string, Record<string, unknown>> = {
  ready: { type: 'ready', shell_api: 1, features: ['notify', 'badge', 'haptic'], signed_in: false },
  notify: { type: 'notify', title: 'Talos', body: 'Your build finished.', navigate: '/t/general', tag: 'general' },
  badge: { type: 'badge', count: 3 },
  open_external: { type: 'open_external', url: 'https://example.com/page' },
  haptic: { type: 'haptic', kind: 'success' },
  threads: { type: 'threads', items: [{ id: 'general', name: 'General' }] },
  pair_status: { type: 'pair_status', state: 'waiting_pin' },
  terminal_view: { type: 'terminal_view', rect: { x: 240, y: 0, width: 880, height: 780 }, session: 'general' },
  terminal_resume: { type: 'terminal_resume', thread_id: 'general' },
  terminal_leave: { type: 'terminal_leave' },
  pick_folder: { type: 'pick_folder', req: 'r12', start: '/Users/alex/Projects' },
  navigate: { type: 'navigate', path: '/t/general' },
  compose: { type: 'compose', thread_id: 'general', text: 'Hello from the shell.' },
  voice_note: { type: 'voice_note', thread_id: 'general', mime: 'audio/mp4', duration_ms: 1200, bytes_b64: 'AAAA' },
  enroll_code: { type: 'enroll_code', code: '0123456789ABCDEFGHJKMNPQRS' },
  companion_state: {
    type: 'companion_state',
    link: 'online',
    mac_online: true,
    busy: false,
    needs: 1,
    working: 2,
    queued: 0,
    on_call: 0,
    unread: 3,
    failed: 0,
    rows: [
      { thread_id: 'general', state: 'needs_you' },
      { thread_id: 'daily', state: 'working' },
    ],
    last_reply: { thread_id: 'general', seq: 48123 },
    viewing: 'general',
    held: [{ thread_id: 'daily', seq: 7 }],
    replies_epoch: 2,
  },
  companion_reply: {
    type: 'companion_reply',
    req: 'r12',
    thread_id: 'general',
    text: 'Plain text here.',
    truncated: true,
  },
  companion_reply_request: { type: 'companion_reply_request', req: 'r12', thread_id: 'general' },
  companion_replies: { type: 'companion_replies', on: true, shown: [{ thread_id: 'general', seq: 7 }], epoch: 2 },
  notify_permission: { type: 'notify_permission', state: 'granted' },
  terminal_sessions: {
    type: 'terminal_sessions',
    items: [
      {
        id: 'main',
        name: 'Main',
        state: 'live',
        key: '1',
        panel: 'terminal',
        action: null,
        detail: 'Main is running.',
      },
      {
        id: 'general',
        name: 'General',
        state: 'parked',
        key: '2',
        panel: 'resume',
        action: 'resume',
        detail: 'Parked to save memory.',
      },
    ],
  },
  terminal_resume_result: { type: 'terminal_resume_result', thread_id: 'general', outcome: 'asked' },
  terminal_select: { type: 'terminal_select', session: 'general' },
  folder_picked: { type: 'folder_picked', req: 'r12', path: '/Users/alex/Projects' },
}

/** Messages that must NEVER validate, whichever direction they are tried in. */
const MUST_REJECT: Array<[string, unknown]> = [
  ['open_external javascript:', { type: 'open_external', url: 'javascript:alert(1)' }],
  ['open_external file:', { type: 'open_external', url: 'file:///etc/passwd' }],
  ['notify absolute navigate', { ...SAMPLES.notify, navigate: 'https://evil.example.net' }],
  ['notify backslash navigate', { ...SAMPLES.notify, navigate: '/\\evil.example' }],
  ['notify tab navigate', { ...SAMPLES.notify, navigate: '/\t/evil.example' }],
  ['navigate to media', { type: 'navigate', path: '/media/x' }],
  ['unknown field', { ...SAMPLES.badge, extra: true }],
  ['unknown type', { type: 'eval', js: '1' }],
  // The feed is counts and ids only. The Mac app answers both with `.companionInvalid` (it clears the feed), not nil.
  ['companion_state carries text', { ...SAMPLES.companion_state, text: 'a thread name or a reply' }],
  ['companion_state negative count', { ...SAMPLES.companion_state, needs: -1 }],
  ['terminal_view carries text', { ...SAMPLES.terminal_view, text: 'ls' }],
  ['terminal_view negative size', { type: 'terminal_view', rect: { x: 0, y: 0, width: -1, height: 1 } }],
  ['terminal_view hostile session', { ...SAMPLES.terminal_view, session: '=agent' }],
  ['terminal_view session is a tmux target', { ...SAMPLES.terminal_view, session: 't-general' }],
  ['terminal_resume hostile thread', { type: 'terminal_resume', thread_id: '../x' }],
  ['terminal_resume main', { type: 'terminal_resume', thread_id: 'all' }],
  ['terminal_select hostile session', { type: 'terminal_select', session: '=agent' }],
  ['terminal_leave carries a rect', { type: 'terminal_leave', rect: null }],
  ['pick_folder relative start', { type: 'pick_folder', req: 'r12', start: 'Projects' }],
  ['pick_folder tells the panel what to allow', { type: 'pick_folder', req: 'r12', canChooseFiles: true }],
  ['folder_picked relative path', { type: 'folder_picked', req: 'r12', path: 'Projects' }],
  ['folder_picked control character', { type: 'folder_picked', req: 'r12', path: '/a\u0000b' }],
  ['notify_permission unknown state', { type: 'notify_permission', state: 'maybe' }],
]

function build(): string {
  const dirs = { web_to_native: WEB_TO_NATIVE, native_to_web: NATIVE_TO_WEB } as const
  const out: Record<string, Record<string, { sample: unknown; json_schema: unknown }>> = {}
  for (const [dir, table] of Object.entries(dirs)) {
    out[dir] = {}
    for (const [type, schema] of Object.entries(table)) {
      const sample = SAMPLES[type]
      if (!sample) throw new Error(`no sample for ${dir}/${type}`)
      const r = schema.safeParse(sample)
      if (!r.success) throw new Error(`sample for ${dir}/${type} fails its own schema: ${r.error.message}`)
      ;(out[dir] as Record<string, unknown>)[type] = {
        sample,
        json_schema: nativeJsonSchema(schema),
      }
    }
  }
  const all = [...Object.values(WEB_TO_NATIVE), ...Object.values(NATIVE_TO_WEB)]
  for (const [name, bad] of MUST_REJECT)
    if (all.some((s) => s.safeParse(bad).success))
      throw new Error(`"${name}" must be rejected but one schema accepts it`)
  return `${JSON.stringify({ shell_api: 1, ...out }, null, 2)}\n`
}

function main(argv: string[]): number {
  const check = argv.includes('--check')
  const i = argv.indexOf('--dir')
  const dir = i >= 0 ? (argv[i + 1] ?? '') : DEFAULT_DIR
  if (!dir) {
    console.error('usage: node scripts/native-fixtures.ts [--check] [--dir <dir>]')
    return 64
  }
  const file = join(dir, 'messages.json')
  let next: string
  try {
    next = build()
  } catch (e) {
    console.error(`native-fixtures: ${(e as Error).message}`)
    return 1
  }
  if (check) {
    if (!existsSync(file)) {
      console.error(`native fixtures are out of date: ${file} is missing (run: node scripts/native-fixtures.ts)`)
      return 1
    }
    if (readFileSync(file, 'utf8') !== next) {
      console.error(
        `native fixtures are out of date: ${file} differs from packages/protocol/src/native.ts.\n` +
          'If the schema change is intended, run `node scripts/native-fixtures.ts` and commit the diff (the native apps build against it).',
      )
      return 1
    }
    console.log('native fixtures: up to date')
    return 0
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, next)
  console.log(`native fixtures: wrote ${file}`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
