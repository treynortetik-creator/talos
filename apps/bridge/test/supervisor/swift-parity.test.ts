// The thread-session numbers and the MCP allow list's fixed parts have one source, packages/protocol, and the Mac app's Swift
// must say the same (P3d3). These read the Swift sources and fail when either side drifts.
// gate-reads: apps/desktop/Tests/TalosDesktopCoreTests/WorkerHookTests.swift apps/desktop/Tests/TalosDesktopCoreTests/SpecHashTests.swift apps/desktop/Tests/TalosDesktopCoreTests/ThreadStateHookTests.swift
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_REQUEST_MIN_GAP_MS,
  AGENT_REQUEST_SIGNED_MAX,
  AgentRequestFile,
  AgentRequestProof,
  CAP_HOLD_MS,
  CLAIM_DEADLINE_COLD_MS,
  CLAIM_DEADLINE_MS,
  DIALOG_CARD_WAIT_MS,
  folderSame,
  MAIN_RESTART_CHECK_FILE,
  MAIN_RESTART_CHECK_MAX_BYTES,
  MAIN_RESTART_CHECK_STALE_MS,
  MAIN_RESTART_CHECK_WRITE_MS,
  MAIN_RESTART_DETAIL_MAX,
  MAIN_RESTART_OUTCOMES,
  MAIN_RESTART_REASONS,
  MCP_ALWAYS_DENIED,
  MCP_CHANNEL_PLUGINS,
  MCP_CONNECTOR_DENY,
  MCP_CONNECTOR_PREFIX,
  MCP_NEVER_OPEN,
  mcpToolPrefix,
  POINTER_CLIENT_QUIET_MS,
  THREAD_FOLDER_ALLOWED_ENV,
  THREAD_FOLDER_ALLOWED_KEYS,
  THREAD_FOLDER_ALLOWED_PERMISSION_KEYS,
  THREAD_FOLDER_REFUSED_FRONTMATTER_KEYS,
  USAGE_RECORDER_PY,
  updateRestartLine,
  usageRecorderCommand,
  WORKER_MCP_APP,
  WORKER_POINTER,
  WORKER_TIMING,
  workerMcpConfigPath,
  workerUsagePath,
} from '@talos-app/protocol'
import { LAUNCH_SPEC_EXCLUDED_ENV, STRIP_RULES_ENTRY } from '../../src/supervisor/launch-spec.ts'
import { seedThreadState, threadStateTemplate } from '../../src/supervisor/thread-state-seed.ts'
import { UPDATE_KEYS_QUIET_S, UPDATE_RELEASE_POLL_S } from '../../src/supervisor/update-restart.ts'
import {
  installWorkerHook,
  NO_PYTHON,
  STATE_FILES,
  STATE_HOOK,
  workerHookDir,
} from '../../src/supervisor/worker-hook.ts'
import { inOneFamily } from '../../src/supervisor/worker-launch.ts'
import { lines as noticeLines, TOOL_PROMPT_HOLD_MAX_S } from '../../src/supervisor/worker-notices.ts'
import { stateFileAllowRules, stateFileDenyRules } from '../../src/supervisor/worker-policy.ts'
import {
  HOOK_CLEAN_LINE,
  HOOK_LANG,
  HOOK_PASS_ENV,
  permissionHookCommand,
  STATE_HOOK_CLEAN_LINE,
  THREAD_STATE_ENV,
  threadStateHookCommand,
} from '../../src/supervisor/worker-spec.ts'
import { subLaunch } from '../../src/supervisor/worker-subthreads.ts'
import type { WorkerThread } from '../../src/supervisor/worker-types.ts'

const SRC = join(import.meta.dir, '../../../desktop/Sources')
const swift = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

// what the planner fixes for the hook's process (worker-spec.ts HookFixed)
const FIXED = { talosHome: '/home/alex/.talos', home: '/home/alex', thread: 'trip' }

/** `static let name: T = 5` or `public var name: Double = 15` in a Swift file, as a number. */
function swiftNumber(text: string, name: string): number {
  const m = new RegExp(`(?:let|var) ${name}(?:: [A-Za-z]+)? = ([0-9_.]+)`).exec(text)
  if (!m) throw new Error(`no ${name} in the Swift source`)
  return Number((m[1] as string).replace(/_/g, ''))
}

describe('the thread-session timings are the Mac’s', () => {
  const manager = swift('TalosSupervisor/WorkerManager.swift')
  const owed = swift('TalosSupervisor/WorkerOwedPointer.swift')
  const workers = swift('TalosDesktopCore/Workers.swift')
  it('the manager’s options', () => {
    expect(swiftNumber(manager, 'readyTimeout')).toBe(WORKER_TIMING.ready_s)
    expect(swiftNumber(manager, 'parkGrace')).toBe(WORKER_TIMING.park_grace_s)
    expect(swiftNumber(manager, 'stopLimit')).toBe(WORKER_TIMING.owner_stop_s)
    expect(swiftNumber(manager, 'dialogLimit')).toBe(WORKER_TIMING.start_dialog_s)
    expect(swiftNumber(manager, 'capHold')).toBe(CAP_HOLD_MS / 1000)
    expect(swiftNumber(manager, 'busyWindow')).toBe(WORKER_TIMING.busy_window_s)
    expect(swiftNumber(manager, 'dialogSettle')).toBe(WORKER_TIMING.dialog_settle_s)
    expect(swiftNumber(manager, 'clientQuiet')).toBe(WORKER_TIMING.dialog_client_quiet_s)
    expect(swiftNumber(manager, 'draftNoticeAfter')).toBe(WORKER_TIMING.draft_notice_after_s)
    expect(swiftNumber(manager, 'cardAckWait')).toBe(DIALOG_CARD_WAIT_MS / 1000)
    expect(swiftNumber(manager, 'cardLifetime')).toBe(WORKER_TIMING.card_lifetime_s)
    expect(swiftNumber(manager, 'noticeDebounce')).toBe(WORKER_TIMING.notice_debounce_s)
    expect(swiftNumber(manager, 'promptDebounce')).toBe(WORKER_TIMING.prompt_debounce_s)
    expect(swiftNumber(manager, 'noticeRetry')).toBe(WORKER_TIMING.notice_retry_s)
    expect(swiftNumber(manager, 'launchChangeSettle')).toBe(WORKER_TIMING.launch_change_settle_s)
  })
  it('the pointer: its guard, its deadlines, the looks after typing, the late clears', () => {
    expect(swiftNumber(workers, 'quietSeconds')).toBe(POINTER_CLIENT_QUIET_MS / 1000)
    expect(swiftNumber(workers, 'claimDeadline')).toBe(CLAIM_DEADLINE_MS / 1000)
    expect(swiftNumber(workers, 'claimDeadlineCold')).toBe(CLAIM_DEADLINE_COLD_MS / 1000)
    expect(swiftNumber(workers, 'longestClaim')).toBe(WORKER_POINTER.longest_claim_s)
    expect(swiftNumber(owed, 'screenLag')).toBe(WORKER_POINTER.screen_lag_s)
    expect(swiftNumber(owed, 'looksAfterTyping')).toBe(WORKER_POINTER.looks_after_typing)
    expect(owed).toContain(`usleep(${WORKER_POINTER.look_pause_ms}_000)`)
    expect(owed).toContain(`r.owed.clears < ${WORKER_POINTER.late_clears}`)
  })
})

describe('the MCP allow list’s fixed parts are WorkerMcp.swift’s', () => {
  const mcp = swift('TalosDesktopCore/WorkerMcp.swift')
  const list = (name: string) => {
    const m = new RegExp(`static let ${name} = \\[([^\\]]*)\\]`).exec(mcp)
    if (!m) throw new Error(`no ${name} in WorkerMcp.swift`)
    return [...(m[1] as string).matchAll(/"([^"]+)"/g)].map((x) => x[1])
  }
  it('the app server, the servers no list opens, the connector prefix, the channel plugins, the connector deny rule', () => {
    expect(mcp).toContain(`static let appName = "${WORKER_MCP_APP}"`)
    expect(list('neverOpen')).toEqual([...MCP_NEVER_OPEN])
    expect(list('alwaysDenied')).toEqual([...MCP_ALWAYS_DENIED])
    expect(mcp).toContain(`name.lowercased().hasPrefix("${MCP_CONNECTOR_PREFIX}")`)
    expect(mcp).toContain(`[${MCP_CHANNEL_PLUGINS.map((p) => `"${p}"`).join(', ')}].contains(`)
    expect(mcp).toContain(`"${MCP_CONNECTOR_DENY}"`)
    expect(mcp).toContain('"\\(talosHome)/workers/\\(threadId)/mcp/mcp.json"')
    expect(workerMcpConfigPath('/h/.talos', 'trip')).toBe('/h/.talos/workers/trip/mcp/mcp.json')
  })
  // Claude Code's own function (2.1.322): `t.replace(/[^a-zA-Z0-9_-]/g,"_")`, then for `claude.ai ` names `_` runs made one and
  // the ends trimmed. Per UTF-16 code unit: a character outside the BMP is two `_`. The Mac's prefix() is the same function
  // (WorkerMcp.swift) and its tests hold these cases too (LeadFenceCoreTests.swift, theToolPrefixIsClaudeCodesOwnFunction).
  it('the Mac’s prefix() is the same function: per UTF-16 code unit, the same set, the claude.ai collapse', () => {
    const at = mcp.indexOf('public static func prefix(')
    expect(at).toBeGreaterThan(-1)
    const body = mcp.slice(at, mcp.indexOf('\n  }\n', at))
    expect(body).toContain('name.utf16.map')
    expect(body).toContain('case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x5F, 0x2D: return UInt8(u)')
    expect(body).toContain('name.utf16.starts(with: "claude.ai ".utf16)')
    expect(body).toContain('if one.first == under { one.removeFirst() }')
    expect(body).toContain('if one.last == under { one.removeLast() }')
  })
  it('a server’s tool prefix, as Claude Code itself names it', () => {
    expect(mcpToolPrefix('talos-app')).toBe('talos-app')
    expect(mcpToolPrefix('claude.ai Gmail')).toBe('claude_ai_Gmail')
    expect(mcpToolPrefix('claude.ai  Google  Drive!')).toBe('claude_ai_Google_Drive')
    expect(mcpToolPrefix('plugin:figma:desktop')).toBe('plugin_figma_desktop')
    expect(mcpToolPrefix('ünïcode srv')).toBe('_n_code_srv')
    expect(mcpToolPrefix('mail\u{1F4E7}')).toBe('mail__')
    expect(mcpToolPrefix('x\uD800y')).toBe('x_y')
    expect(mcpToolPrefix('')).toBe('')
  })
})

describe('the thread session’s permission hook is WorkerHook.swift’s', () => {
  // the hook's rules, and where it comes from on the Mac (the app bundle's own copy, checked by its code signature)
  const hookSwift =
    swift('TalosDesktopCore/WorkerHook.swift') +
    swift('TalosDesktopCore/WorkerHookSource.swift') +
    swift('TalosDesktopCore/WorkerHookPython.swift')
  const hookTs = readFileSync(join(import.meta.dir, '../../src/supervisor/worker-hook.ts'), 'utf8')
  /** Swift's `\(name)` written as the template's `${name}`. */
  const asTemplate = (s: string) => s.replace(/\\\((\w+)\)/g, '${$1}')
  it('every reason a start is refused, word for word', () => {
    const reasons = [
      'the permission hook ${script} is not an absolute path',
      'the permission hook ${script} is not a file',
      'the permission hook ${script} is missing or cannot be read',
      "python3 is not on the thread session's PATH (outside its own folders), so its permission hook cannot run",
      ', a folder a thread session works in',
      '${d} cannot be read',
      '${d} is not a plain folder',
      '${d} belongs to another account',
      '${d} can be written by other accounts',
      '${dir} is not inside the Talos home',
      "the permission hook's folder ${unsafe}",
      'the permission hook could not be copied into ${dir}: ',
    ]
    for (const r of reasons) {
      expect(hookTs).toContain(r)
      expect(asTemplate(hookSwift)).toContain(r)
    }
    expect(installWorkerHook('/h/.talos', 'kit/x.py', { PATH: '/usr/bin' })).toEqual({
      problem: 'the permission hook kit/x.py is not an absolute path',
    })
  })
  // R1-1: the source is sealed on both and never the checkout. On Linux it is the kit release, checked against the hash it
  // records; on the Mac the app bundle's own copy, checked by the bundle's code signature. The same rule in each one's words.
  it('the sealed source’s reasons, each in its own words where the source differs', () => {
    const twins: [linux: string, mac: string][] = [
      ['this install has no sealed kit release (', 'this Talos app has no permission hook inside it'],
      ['does not point at one of ', 'is not inside the Talos app ('],
      [' is a link, not part of a sealed release; ', ' is a link, not part of the signed app'],
      [' can be written, so the release is not sealed; ', " can be written, so the app's copy is not sealed"],
      [' belongs to another account; ', ' belongs to another account'],
      [
        'does not match its own record (it was changed after it was built); remove it, then ',
        "the Talos app's code signature does not check out (",
      ],
      [' changed after its release was checked', " changed after the app's signature was checked"],
    ]
    for (const [linux, mac] of twins) {
      expect(hookTs).toContain(linux)
      expect(hookSwift).toContain(mac)
    }
    expect(NO_PYTHON).toBe(
      "python3 is not on the thread session's PATH (outside its own folders), so its permission hook cannot run",
    )
    // R1-7 on both: python3 is the real interpreter file, never a `#!` shim or a link whose real file is not named python3
    expect(hookTs).toContain("b.toString('latin1') === '#!'")
    expect(hookSwift).toContain('head == Data("#!".utf8)')
    expect(hookTs).toContain('/^python3(\\.\\d+)*$/')
    expect(hookSwift).toContain('static func isPython3Name(')
    // the copy is made only of the bytes the check verified
    expect(hookTs).toContain('writeFileAtomic(script, hookBytes, 0o600)')
    expect(hookSwift).toContain('try AtomicFile.write(checked.script, to: script, mode: 0o600)')
    // the Mac never names the checkout for the hook
    expect(hookSwift).not.toContain('kit/hooks')
    expect(swift('TalosDesktop/SupervisorController.swift')).toContain('o.permissionHook = WorkerHook.appSource')
  })
  // Linux only: a release is installed by a command the refusal names. The Mac's app carries its hook, so its line says to reinstall.
  it('the reason only Linux has', () => {
    expect(hookTs).toContain('install a sealed release with: ')
  })
  it('the copy’s folder and the command the settings run', () => {
    expect(workerHookDir('/h/.talos')).toBe('/h/.talos/workers/_hook')
    expect(hookSwift).toContain('talosHome + "/workers/_hook"')
    // ONE command on both (the Linux twin's review, then the Mac's R1-1): the session's own shell only assigns and calls `exec`;
    // `env -i` starts a second, clean /bin/sh with only the fixed values and the named pass-through, which tests for the copy and
    // runs the interpreter isolated (-I -S). The Mac's own test holds WorkerHook.command to this text (WorkerHookTests.swift); the
    // Linux command is that text with its locale (a Linux box may have no en_US.UTF-8; C.UTF-8 is always there).
    const macTest = readFileSync(join(SRC, '../Tests/TalosDesktopCoreTests/WorkerHookTests.swift'), 'utf8')
    const macLiteral = /cmd == "(f='\/home\/alex\/\.talos\/workers\/_hook\/permission-relay\.py'; exec [^\n]*)"\)/.exec(
      macTest,
    )?.[1]
    if (!macLiteral) throw new Error('control: the Mac test holds the command to a literal')
    const macCommand = macLiteral.replaceAll('\\"', '"')
    const macPython = /"\$f" '([^']+)'$/.exec(macCommand)?.[1] as string
    expect(
      permissionHookCommand('/home/alex/.talos/workers/_hook/permission-relay.py', macPython, {
        talosHome: '/home/alex/.talos',
        home: '/home/alex',
        thread: 'trip',
      }),
    ).toBe(macCommand.replace('LANG=en_US.UTF-8', `LANG=${HOOK_LANG}`))
    expect(hookSwift).toContain(`static let cleanLine = "${HOOK_CLEAN_LINE.replaceAll('"', '\\"')}"`)
    expect(hookSwift).toContain(
      `static let passedThrough = [\n    ${HOOK_PASS_ENV.slice(0, 5)
        .map((k) => `"${k}"`)
        .join(', ')},`,
    )
    // and the folder the hook reads again at every prompt, named the same way on both
    const withFolder = permissionHookCommand('/s.py', '/p', { ...FIXED, folder: '/w/trip', folderHooksCount: false })
    expect(withFolder).toContain(
      " TALOS_APP_PERM_HOOK_SOURCE=worker TALOS_APP_HOOK_CHECK_DIR='/w/trip' TALOS_APP_HOOK_CHECK_HOOKS=0 ",
    )
    expect(hookSwift).toContain(
      '"TALOS_APP_HOOK_CHECK_DIR=\\(quote($0))", "TALOS_APP_HOOK_CHECK_HOOKS=\\(s.folderHooksCount ? "1" : "0")"',
    )
  })
  // The folder settings a thread session's start allows, on Linux and the Mac, are the ones its hook allows at every prompt: ONE
  // table (packages/protocol/tables/thread-folder-settings.json), which the Swift app and kit/hooks/permission-relay.py are held to.
  it('the folder settings allow-lists: the shared table, the Mac’s and the hook script’s', () => {
    const folder = swift('TalosDesktopCore/WorkerHookFolder.swift')
    const relay = readFileSync(join(import.meta.dir, '../../../../kit/hooks/permission-relay.py'), 'utf8')
    const list = (text: string, re: RegExp) =>
      [...(re.exec(text)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort()
    const tableEnv = [...THREAD_FOLDER_ALLOWED_ENV].sort()
    const tableKeys = [...THREAD_FOLDER_ALLOWED_KEYS].sort()
    const tablePerms = [...THREAD_FOLDER_ALLOWED_PERMISSION_KEYS].sort()
    expect(tableEnv.length).toBe(18)
    expect(tableEnv).toContain('MAX_THINKING_TOKENS')
    expect(tableEnv).not.toContain('CLAUDE_CODE_SHELL_PREFIX')
    expect(tableKeys).toEqual([
      '$schema',
      'alwaysThinkingEnabled',
      'claudeMdExcludes',
      'env',
      'includeCoAuthoredBy',
      'model',
      'outputStyle',
      'permissions',
      'skillOverrides',
    ])
    expect(tablePerms).toEqual(['ask', 'defaultMode', 'deny'])
    expect(list(folder, /allowedEnv: Set<String> = \[([^\]]*)\]/)).toEqual(tableEnv)
    expect(list(folder, /allowedKeys: Set<String> = \[([^\]]*)\]/)).toEqual(tableKeys)
    expect(list(folder, /allowedPermissionKeys: Set<String> = \[([^\]]*)\]/)).toEqual(tablePerms)
    expect(list(relay, /ALLOWED_ENV = frozenset\(\(([^)]*)\)\)/)).toEqual(tableEnv)
    expect(list(relay, /ALLOWED_KEYS = frozenset\(\(([^)]*)\)\)/)).toEqual(tableKeys)
    expect(list(relay, /ALLOWED_PERMISSION_KEYS = frozenset\(\(([^)]*)\)\)/)).toEqual(tablePerms)
    // the subagent, skill and command frontmatter keys that refuse a start (WorkerFolderTree.swift), the hook's the same
    const tree = swift('TalosDesktopCore/WorkerFolderTree.swift')
    const swiftRefused = list(tree, /refusedFrontmatterKeys: Set<String> = \[([^\]]*)\]/)
    expect(swiftRefused).toEqual(['allowed-tools', 'hooks', 'mcpServers', 'permissionMode'])
    expect(list(relay, /REFUSED_FRONTMATTER_KEYS = frozenset\(\(([^)]*)\)\)/)).toEqual(swiftRefused)
    expect([...THREAD_FOLDER_REFUSED_FRONTMATTER_KEYS].sort()).toEqual(swiftRefused)
    // both commands name the folder, so the hook reads it again at every prompt on both
    expect(swift('TalosDesktopCore/WorkerHook.swift')).toContain('"TALOS_APP_HOOK_CHECK_DIR=')
    expect(readFileSync(join(import.meta.dir, '../../src/supervisor/worker-spec.ts'), 'utf8')).toContain(
      'TALOS_APP_HOOK_CHECK_DIR',
    )
  })
  it('the thread’s line, up to where each platform says how to restart, and the audit events', () => {
    const where = { attach: '', restart: '', machine: 'the Mac' }
    const line = noticeLines.hookMissing('WHY', 'trip', where)
    const shared = line.slice(0, line.indexOf('then ') + 'then '.length)
    expect(shared).toBe(
      "This thread's session doesn't start: WHY, and without it the session's approval prompts would wait at the terminal on the Mac and never reach your phone. Reinstall Talos on the Mac (or fix the hook), then ",
    )
    expect(asTemplate(hookSwift)).toContain(shared.replace('WHY', '${why}'))
    const start = swift('TalosSupervisor/WorkerHookStart.swift')
    expect(start).toContain('audit("worker_hook_missing thread=\\(id) why=')
    const notices = swift('TalosSupervisor/WorkerNotices.swift')
    expect(notices).toContain('audit("worker_needs_you thread=\\(id) prompt=')
    expect(notices).toContain('audit("worker_notice thread=\\(id) kind=')
  })
  it('a tool prompt’s typing hold has the same cap', () => {
    expect(swiftNumber(swift('TalosSupervisor/WorkerManager.swift'), 'toolPromptHoldMax')).toBe(TOOL_PROMPT_HOLD_MAX_S)
  })
})

describe('the usage recorder a thread session’s status line runs is the Mac’s', () => {
  const usageSwift = swift('TalosDesktopCore/WorkerUsage.swift')
  it('the program, character for character', () => {
    const m = /recorderSource = """\n([\s\S]*?)\n {4}"""/.exec(usageSwift)
    if (!m) throw new Error('no recorderSource in WorkerUsage.swift')
    // a Swift multi-line literal drops the closing delimiter's indent (four spaces) from every line
    const text = (m[1] as string)
      .split('\n')
      .map((l) => l.replace(/^ {4}/, ''))
      .join('\n')
    expect(text).toBe(USAGE_RECORDER_PY)
  })
  it('the command and the file’s place', () => {
    expect(usageSwift).toContain(
      '"exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=en_US.UTF-8 \\(WorkerHook.quote(python)) -I -c \\(WorkerHook.quote(recorderSource)) \\(WorkerHook.quote(usageFile))"',
    )
    expect(usageRecorderCommand('/p', '/f')).toBe(
      `exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=en_US.UTF-8 '/p' -I -c '${USAGE_RECORDER_PY}' '/f'`,
    )
    expect(usageSwift).toContain('talosHome + "/workers/" + threadId + "/usage.json"')
    expect(workerUsagePath('/h', 't')).toBe('/h/workers/t/usage.json')
    expect(usageSwift).toContain('["type": "command", "command": command(')
    expect(usageSwift).toContain('"padding": 0]')
  })
})

describe('main-restart-check.json is MainRestartCheck.swift’s', () => {
  const check = swift('TalosDesktopCore/MainRestartCheck.swift')
  it('the file name, the 5 s write, the 15 s stale limit, the size, the detail cap and the gap', () => {
    expect(check).toContain(`static let fileName = "${MAIN_RESTART_CHECK_FILE}"`)
    expect(swiftNumber(check, 'writeEvery')).toBe(MAIN_RESTART_CHECK_WRITE_MS / 1000)
    expect(swiftNumber(check, 'staleAfter')).toBe(MAIN_RESTART_CHECK_STALE_MS / 1000)
    expect(swiftNumber(check, 'maxBytes')).toBe(MAIN_RESTART_CHECK_MAX_BYTES)
    expect(swiftNumber(check, 'detailMax')).toBe(MAIN_RESTART_DETAIL_MAX)
    expect(swiftNumber(swift('TalosDesktopCore/AgentRecovery.swift'), 'requestMinGap')).toBe(
      AGENT_REQUEST_MIN_GAP_MS / 1000,
    )
  })
  it('the reasons and the outcomes, same names, same order', () => {
    const cases = (enumName: string) => {
      const m = new RegExp(`enum ${enumName}: String[^{]*\\{([\\s\\S]*?)\\n  \\}`).exec(check)
      if (!m) throw new Error(`no enum ${enumName} in MainRestartCheck.swift`)
      return [...(m[1] as string).matchAll(/case (\w+)(?: = "([^"]+)")?/g)].map((x) => x[2] ?? x[1])
    }
    expect(cases('Reason')).toEqual([...MAIN_RESTART_REASONS])
    expect(cases('Outcome')).toEqual([...MAIN_RESTART_OUTCOMES])
  })
})

describe('agent-request.json’s fields are AgentRequest.swift’s', () => {
  const req = swift('TalosDesktopCore/AgentRequest.swift')
  it('every field the schema has, the Swift reads (asked_by only as the old field it no longer reads)', () => {
    // the transform's input shape: the fields a file may carry
    const fields = Object.keys((AgentRequestFile.in as unknown as { shape: Record<string, unknown> }).shape).sort()
    expect(fields).toEqual(['action', 'asked_by', 'by_thread', 'control_id', 'proof', 'ts', 'v', 'why'])
    for (const f of fields.filter((x) => x !== 'asked_by')) expect(req, f).toContain(`o["${f}"]`)
    expect(req).not.toContain('o["asked_by"]')
  })
  it('the proof: the same three keys and the same cap on the signed text', () => {
    const keys = Object.keys(AgentRequestProof.shape).sort()
    expect(keys).toEqual(['device_id', 'osig', 'signed_b64url'])
    expect(req).toContain(`proofKeys: Set<String> = [${keys.map((k) => `"${k}"`).join(', ')}]`)
    expect(swiftNumber(req, 'signedMax')).toBe(AGENT_REQUEST_SIGNED_MAX)
  })
})

describe('restart on update: the Mac’s queue and launch spec say what the Linux ones say', () => {
  const lineSwift = swift('TalosDesktopCore/UpdateRestartLine.swift')
  const queue = swift('TalosSupervisor/WorkerUpdateRestart.swift')
  const spec = swift('TalosDesktopCore/LaunchSpecHash.swift')
  it('the owner’s line: every shared case is what updateRestartLine gives, and the Swift has the same words', () => {
    const fixture = JSON.parse(readFileSync(join(SRC, '../Tests/Fixtures/update-restart-line.json'), 'utf8')) as {
      cases: Array<{
        name: string
        restarted: string[]
        waiting: string[]
        failed: string[]
        notRestarted?: string[]
        line: string | null
      }>
    }
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8)
    for (const c of fixture.cases) expect(updateRestartLine(c), c.name).toBe(c.line)
    for (const words of [
      'Updated or instructions changed: ',
      'restarts when its turn ends',
      'restart when their turns end',
      ' failed',
      'restarted ',
      'was not restarted (it did not start again)',
      'were not restarted (they did not start again)',
    ])
      expect(lineSwift).toContain(words)
  })
  it('the release poll, the owner’s keys, the nonce left out and the strip rule’s name', () => {
    expect(swiftNumber(queue, 'releasePoll')).toBe(UPDATE_RELEASE_POLL_S)
    expect(swiftNumber(queue, 'keysQuiet')).toBe(UPDATE_KEYS_QUIET_S)
    expect(spec).toContain(`excludedEnv: Set<String> = [${LAUNCH_SPEC_EXCLUDED_ENV.map((k) => `"${k}"`).join(', ')}]`)
    expect(spec).toContain(`stripRulesEntry = "${STRIP_RULES_ENTRY}"`)
    for (const f of ['--resume', '-r', '--session-id']) expect(spec).toContain(`"${f}"`)
    // the Swift suite reads the very vectors file the TypeScript one does
    expect(swift('../Tests/TalosDesktopCoreTests/SpecHashTests.swift')).toContain(
      'packages/protocol/fixtures/spec-hash/vectors.json',
    )
    expect(existsSync(join(SRC, '../../../packages/protocol/fixtures/spec-hash/vectors.json'))).toBe(true)
  })
})

describe('a sub-thread in its parent’s folder is SubThreads.swift’s', () => {
  const text = swift('TalosDesktopCore/SubThreads.swift')
  const thread = (id: string, o: Record<string, unknown> = {}) => ({ id, kind: 'fixed', session: 'dedicated', ...o })

  it('the same-folder rule: both absolute, no . or .. in the child, trailing slashes ignored', () => {
    // the cases the Swift test (SubThreadsTests) runs too
    const table: Array<[string, string, boolean]> = [
      ['/home/alex/p', '/home/alex/p', true],
      ['/home/alex/p/', '/home/alex/p', true],
      ['/home/alex/p', '/home/alex/p/', true],
      ['/home/alex/p/../p', '/home/alex/p', false],
      ['/home/alex/./p', '/home/alex/p', false],
      ['/home/alex/p2', '/home/alex/p', false],
      ['/home/alex/P', '/home/alex/p', false],
      ['p', 'p', false],
      ['/home/alex/p', 'home/alex/p', false],
    ]
    for (const [child, parent, same] of table)
      expect([child, parent, folderSame(child, parent)]).toEqual([child, parent, same])
    expect(text).toContain(
      'guard child.hasPrefix("/"), parent.hasPrefix("/"), !child.split(separator: "/").contains(where: { $0 == "." || $0 == ".." })',
    )
    expect(text).toContain('while t.count > 1, t.hasSuffix("/") { t.removeLast() }')
  })

  it('the refusals a sub-thread meets are the same words', () => {
    const all = [
      thread('bad', { session_opts: { cwd: 42 } }),
      thread('s', { parent_id: 'bad' }),
      thread('none'),
      thread('t', { parent_id: 'none', session_opts: { cwd: '/home/alex/x' } }),
      thread('o', { parent_id: 'gone' }),
    ]
    const said = (i: number) => subLaunch(all[i] as Record<string, unknown>, all)?.refusal as string
    expect(text).toContain(said(1).replace('(42)', '(\\(bad))'))
    // a folder of its own under a parent with none starts on both sides (subthreads_folderless_parent): no refusal left
    expect(said(3)).toBeNull()
    expect(text).not.toContain('give the parent a folder first')
    expect(text).toContain(said(4).replace('the parent thread is not there any more', '\\(why)'))
  })

  it('the family: a parent and a folder-sharing child, two such siblings; nobody else', () => {
    const kid = (id: string, parentId: string, shares = true): WorkerThread =>
      ({
        id,
        cwd: '/home/alex/p',
        model: 'inherit',
        effort: null,
        parentCwd: null,
        sub: { parentId, ownCwd: !shares, shares, refusal: null, unreadable: {} },
      }) as WorkerThread
    const plain = (id: string): WorkerThread => ({
      id,
      cwd: '/home/alex/p',
      model: 'inherit',
      effort: null,
      parentCwd: null,
    })
    const known = [
      plain('p'),
      kid('a', 'p'),
      kid('b', 'p'),
      kid('sub', 'p', false),
      kid('sub2', 'p', false),
      plain('q'),
      kid('c', 'q'),
      plain('x'),
    ]
    const fam = (a: string, b: string) => inOneFamily(known.find((t) => t.id === a) as WorkerThread, known, b)
    expect([fam('a', 'p'), fam('p', 'a'), fam('a', 'b'), fam('b', 'a')]).toEqual([true, true, true, true])
    expect([
      fam('sub', 'sub2'),
      fam('sub', 'p'),
      fam('p', 'sub'),
      fam('c', 'a'),
      fam('a', 'c'),
      fam('x', 'p'),
      fam('x', 'a'),
      fam('a', 'a'),
    ]).toEqual(Array(8).fill(false))
    // the Swift family test reads the same table; both ignore a child that is refused
    expect(text).toContain('$0.shares && $0.refusal == nil ? $0.parentId : nil')
  })
})

// The thread's own live state file: the Mac's supervisor (WorkerHookState.swift, ThreadStateSeed.swift, WorkerSpec.swift) gives a
// dedicated thread worker the same hook, command, allow rules, flag and seed text as the bridge's (thread-state-seed.ts,
// worker-hook.ts, worker-spec.ts, worker-policy.ts). The Mac's own tests hold the Swift side to literals (ThreadStateHookTests.swift);
// these read that literal and the Swift sources and hold them to the TypeScript.
describe('the thread-state hook is the Mac’s', () => {
  const state = swift('TalosDesktopCore/WorkerHookState.swift')
  const seed = swift('TalosDesktopCore/ThreadStateSeed.swift')
  const spec = swift('TalosDesktopCore/WorkerSpec.swift')
  const macTest = readFileSync(join(SRC, '../Tests/TalosDesktopCoreTests/ThreadStateHookTests.swift'), 'utf8')
  const specTs = readFileSync(join(import.meta.dir, '../../src/supervisor/worker-spec.ts'), 'utf8')

  it('the files, the flag and the line the clean shell runs', () => {
    expect(STATE_FILES).toEqual(['thread-state.py', 'compaction-guard.py'])
    expect(state).toContain(`static let stateScriptName = "${STATE_HOOK}"`)
    expect(state).toContain(`static let stateFileNames = [stateScriptName, "${STATE_FILES[1]}"]`)
    expect(state).toContain(`static let threadStateEnv = "${THREAD_STATE_ENV}"`)
    expect(state).toContain(`static let stateCleanLine = "${STATE_HOOK_CLEAN_LINE.replaceAll('"', '\\"')}"`)
    expect(state).toContain('static let stateBytecodeDir = "/nonexistent"')
    // the bundle's two files are the ones the build copies (build-app.sh, guards-test.sh)
    const build = readFileSync(join(SRC, '../scripts/build-app.sh'), 'utf8')
    expect(build).toContain(`for f in permission-relay.py _talos_common.py ${STATE_FILES.join(' ')}; do`)
  })
  it('the command: the Mac’s literal is the TypeScript text, less the locale', () => {
    const lit = /cmd == "(f='\/home\/alex\/\.talos\/workers\/_hook\/thread-state\.py'; exec [^\n]*)"\)/.exec(
      macTest,
    )?.[1]
    if (!lit) throw new Error('control: the Mac test holds the command to a literal')
    const mac = lit.replaceAll('\\"', '"')
    const python = /"\$f" '([^']+)' inject/.exec(mac)?.[1] as string
    expect(
      threadStateHookCommand(
        '/home/alex/.talos/workers/_hook/thread-state.py',
        python,
        'inject',
        { talosHome: '/home/alex/.talos', home: '/home/alex', thread: 'trip' },
        '/home/alex/agent',
      ),
    ).toBe(mac.replace('LANG=en_US.UTF-8', `LANG=${HOOK_LANG}`))
  })
  it('the settings: the same events, matcher, timeout and both modes', () => {
    for (const text of [specTs, state]) {
      expect(text).toContain('startup|resume|clear|compact|fork')
      expect(text).toContain('SessionStart')
      expect(text).toContain('PreCompact')
      expect(text).toContain('timeout')
    }
    expect(specTs).toContain("add('SessionStart', 'inject', 'startup|resume|clear|compact|fork')")
    expect(specTs).toContain("add('PreCompact', 'save')")
    expect(state).toContain('add("SessionStart", mode: "inject", matcher: "startup|resume|clear|compact|fork")')
    expect(state).toContain('add("PreCompact", mode: "save", matcher: nil)')
    expect(state).toContain('"timeout": 5')
    expect(specTs).toContain('timeout: 5')
    // the flag only with the hook, never inherited, and held by validate on both sides
    expect(spec).toContain('k != WorkerHook.threadStateEnv')
    expect(spec).toContain('if i.permissionHook.stateBytes != nil { env[WorkerHook.threadStateEnv] = "1" }')
    expect(spec).toContain('WorkerHook.stateRegistered(settings: settings')
    expect(specTs).toContain("if ((stateVar === '1') !== stateRegistered)")
  })
  it('the allow and deny rules: the same spelling, the same refusals', () => {
    const allow = stateFileAllowRules('/home/alex/agent', 'trip')
    expect(allow).toEqual([
      'Edit(//home/alex/agent/threads/trip.state.md)',
      'Write(//home/alex/agent/threads/trip.state.md)',
    ])
    expect(stateFileDenyRules('/home/alex/agent', 'trip')).toEqual(allow.map((r) => r.replace(/\)$/, '/**)')))
    // the Mac's test holds its output to the same two strings (with a trailing slash given, as TS trims it)
    expect(macTest).toContain(
      '["Edit(//home/alex/agent/threads/trip.state.md)", "Write(//home/alex/agent/threads/trip.state.md)"]',
    )
    expect(stateFileAllowRules('/home/alex/agent/', 'trip')).toEqual(allow)
    // the same bad folders and bad ids get none
    for (const bad of [
      '/home/al*ex/agent',
      '/home/alex/a[1]/agent',
      '/home/alex/a(b)',
      '/home/alex/a b"c',
      '/home/alex/a\nb',
      'relative/agent',
    ])
      expect(stateFileAllowRules(bad, 'trip'), bad).toEqual([])
    for (const bad of ['../x', 'Trip'] as const) expect(stateFileAllowRules('/home/alex/agent', bad)).toEqual([])
    expect(state).toContain('CharacterSet(charactersIn: "*?[]{}()!\\\\\\"\'`")')
    expect(state).toContain('stateRules(agentDir: agentDir, threadId: threadId, tail: "/**")')
    // nothing lower-cased on the allow side, on either
    expect(state).not.toContain('lowercased()')
  })
  it('the staged files are in the launch spec’s files under the same names', () => {
    const plan = swift('TalosSupervisor/WorkerLaunchPlan.swift')
    expect(state).toContain('"thread-state-hook": hook.stateBytes?[stateFileNames[0]]')
    expect(state).toContain('"thread-state-compaction": hook.stateBytes?[stateFileNames[1]]')
    expect(plan).toContain('WorkerHook.stateLaunchFiles(hook)')
    const wiring = readFileSync(join(import.meta.dir, '../../src/supervisor/workers-wiring.ts'), 'utf8')
    expect(wiring).toContain("'thread-state-hook': o.hook.state?.[STATE_HOOK] ?? null")
    expect(wiring).toContain("'thread-state-compaction': o.hook.state?.[STATE_FILES[1]] ?? null")
  })
  it('the seed: the template text, and the problems it names', () => {
    const ts = threadStateTemplate('ID', 'NAME')
    for (const line of ts.split('\n').filter((l) => l !== '' && !l.startsWith('# NAME')))
      expect(seed, line).toContain(line)
    expect(seed).toContain('# \\(shown) live state (thread \\(id))')
    expect(ts.startsWith('# NAME live state (thread ID)\n')).toBe(true)
    // a name is flattened the same way, and cut at 80
    expect(seed).toContain('.prefix(80)')
    expect(threadStateTemplate('trip', 'A\nB## x').split('\n')[0]).toBe('# A B## x live state (thread trip)')
    for (const why of [
      'is not a plain folder',
      'is a link',
      "is not the agent folder's own threads folder",
      'could not be made',
    ]) {
      expect(seed, why).toContain(why)
    }
    const dir = mkdtempSync(join(tmpdir(), 'seed-parity-'))
    try {
      expect(seedThreadState(dir, 'trip', 'Trip')).toEqual({ ok: 'created' })
      expect(seed).toContain('O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW')
      expect(seed).toContain('mkdir(dir, 0o700)')
      expect(seed).toContain('open(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // and the Mac's start calls it at a real start only (never the dry plan), and audits a problem under the bridge's event name
    const manager = swift('TalosSupervisor/WorkerManager.swift')
    const start = swift('TalosSupervisor/WorkerHookStart.swift')
    expect(manager).toContain('seedThreadState(id, name: s.name)')
    expect(start).toContain('worker_state_seed_failed thread=')
    expect(swift('TalosSupervisor/WorkerLaunchPlan.swift')).not.toContain('seedThreadState')
  })
})
