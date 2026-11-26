// Why a permission card asked (Wave 0, item 0.9). The bridge sets `asked_why: 'your_rule'` ONLY when it can prove it: the prompt came
// through the PermissionRequest hook of the main session, the hook said the session is in bypassPermissions, and the call matches an
// ask rule in the agent's settings files. Claude Code does not say when its own safety check asked, so every other case is unset
// (no line on the card): not a mode we were told, a thread session, a relay card, no matching rule, a rule we cannot match.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { CardT } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { askRuleMatches } from '../src/permission/ask-why.ts'
import { eventually, type Harness, startHarness } from './helpers.ts'

setDefaultTimeout(t(30_000))

describe('askRuleMatches: a rule is matched only where it is certain', () => {
  const bash = (command: string) => ({ command })
  test('a bare tool rule matches that tool and a whole MCP server', () => {
    expect(askRuleMatches(['Write'], 'Write', { file_path: '/x' })).toBe(true)
    expect(askRuleMatches(['Write'], 'Edit', {})).toBe(false)
    expect(askRuleMatches(['mcp__github'], 'mcp__github__create_issue', {})).toBe(true)
    expect(askRuleMatches(['mcp__github'], 'mcp__githubx__create_issue', {})).toBe(false)
    expect(askRuleMatches(['mcp__github__create_issue'], 'mcp__github__create_issue', {})).toBe(true)
  })
  test('Bash(...) globs match the whole command, and the older ":*" suffix reads as " *"', () => {
    expect(askRuleMatches(['Bash(git push *)'], 'Bash', bash('git push origin main'))).toBe(true)
    expect(askRuleMatches(['Bash(git push:*)'], 'Bash', bash('git push origin main'))).toBe(true)
    expect(askRuleMatches(['Bash(git push *)'], 'Bash', bash('git status'))).toBe(false)
    expect(askRuleMatches(['Bash(* deploy *)'], 'Bash', bash('pnpm deploy --prod'))).toBe(true)
    expect(askRuleMatches(['Bash(rm -rf *)'], 'Bash', bash('rm -rf /home/alex/b'))).toBe(true)
    expect(askRuleMatches(['Bash(git push)'], 'Bash', bash('git push origin'))).toBe(false) // exact rule, longer command
    expect(askRuleMatches(['Bash(git push)'], 'Bash', bash('git push'))).toBe(true)
  })
  test('a rule is a glob, never a regex: dots and brackets are plain characters', () => {
    expect(askRuleMatches(['Bash(a.c *)'], 'Bash', bash('abc x'))).toBe(false)
    expect(askRuleMatches(['Bash(a[bc] *)'], 'Bash', bash('ab x'))).toBe(false)
    expect(askRuleMatches(['Bash(a[bc] *)'], 'Bash', bash('a[bc] x'))).toBe(true)
  })
  test('the parts of a plain && / ; / | chain count, as Claude Code reads them', () => {
    expect(askRuleMatches(['Bash(git clean *)'], 'Bash', bash('cd /tmp && git clean -f'))).toBe(true)
    expect(askRuleMatches(['Bash(git push *)'], 'Bash', bash('echo hi; git push origin'))).toBe(true)
  })
  test('a leading VAR=value is NOT stripped: nobody has shown Claude Code does, and a miss only hides the line', () => {
    expect(askRuleMatches(['Bash(git push *)'], 'Bash', bash('GIT_SSH=x git push origin'))).toBe(false)
    expect(askRuleMatches(['Bash(GIT_SSH=x git push *)'], 'Bash', bash('GIT_SSH=x git push origin'))).toBe(true)
  })
  test('a bare & is matched whole only; a here-document or a # comment gives no line (see below)', () => {
    const rule = ['Bash(git push *)']
    expect(askRuleMatches(rule, 'Bash', bash('cat <<EOF > notes.txt\ngit push origin main\nEOF'))).toBe(false)
    expect(askRuleMatches(rule, 'Bash', bash('echo ok # ; git push x'))).toBe(false)
    expect(askRuleMatches(rule, 'Bash', bash('cat <<EOF > .git/hooks/pre-push\ngit push origin main\nEOF'))).toBe(false)
    expect(askRuleMatches(rule, 'Bash', bash('cat <<< x; git push y'))).toBe(false)
    expect(askRuleMatches(rule, 'Bash', bash('sleep 1 & git push x'))).toBe(false)
    expect(askRuleMatches(['Bash(cat *)'], 'Bash', bash('cat <<EOF > .git/hooks/pre-push\nx\nEOF'))).toBe(false) // no line at all: see the next test
    expect(askRuleMatches(['Bash(echo *)'], 'Bash', bash('echo ok # ; git push x'))).toBe(false)
    expect(askRuleMatches(rule, 'Bash', bash('a && git push x'))).toBe(true) // && is not a bare &
  })
  test('a dollar-brace expansion is never split: its ; or newline is not a command separator', () => {
    const rule = ['Bash(git push *)']
    expect(askRuleMatches(rule, 'Bash', bash('echo $' + '{X:-a;git push y}'))).toBe(false)
    expect(askRuleMatches(rule, 'Bash', bash('echo $' + '{X:-a\ngit push y}'))).toBe(false)
  })
  test('a command with a here-document, a # or a newline gets no line at all, even from a rule that starts with *', () => {
    // the kit's own default rules start with *: they would match straight through a heredoc body or a comment
    const deploy = ['Bash(* deploy *)']
    const rollback = ['Bash(*talos rollback*)']
    expect(askRuleMatches(deploy, 'Bash', bash('cat <<EOF > .git/hooks/pre-push\npnpm deploy x\nEOF'))).toBe(false)
    expect(askRuleMatches(deploy, 'Bash', bash('touch .git/hooks/x # deploy later'))).toBe(false)
    expect(askRuleMatches(rollback, 'Bash', bash('cat <<EOF > .claude/settings.json\ntalos rollback\nEOF'))).toBe(false)
    expect(askRuleMatches(deploy, 'Bash', bash('echo a\npnpm deploy x'))).toBe(false)
    expect(askRuleMatches(['Bash(git push *)'], 'Bash', bash('echo hi\ngit push origin'))).toBe(false)
    // the same rules still match an ordinary one-line command
    expect(askRuleMatches(deploy, 'Bash', bash('pnpm deploy --prod'))).toBe(true)
    expect(askRuleMatches(rollback, 'Bash', bash('talos rollback'))).toBe(true)
  })
  test('whitespace in a rule is matched as written (no folding)', () => {
    expect(askRuleMatches(['Bash(git  push *)'], 'Bash', bash('git push x'))).toBe(false)
    expect(askRuleMatches(['Bash(git  push *)'], 'Bash', bash('git  push x'))).toBe(true)
  })
  test('a command with quotes or substitutions is matched whole only: no guessing where a chain really splits', () => {
    expect(askRuleMatches(['Bash(git push *)'], 'Bash', bash('echo "a && git push x"'))).toBe(false)
    expect(askRuleMatches(['Bash(git push *)'], 'Bash', bash('echo $(git push x)'))).toBe(false)
    expect(askRuleMatches(['Bash(echo *)'], 'Bash', bash('echo "a && git push x"'))).toBe(true)
  })
  test('anything it cannot read says no: path rules, domain rules, non-Bash arguments, junk', () => {
    expect(askRuleMatches(['Read(./secrets/**)'], 'Read', { file_path: './secrets/a' })).toBe(false)
    expect(askRuleMatches(['WebFetch(domain:example.com)'], 'WebFetch', { url: 'https://example.com/x' })).toBe(false)
    expect(askRuleMatches(['Bash(git push *)'], 'Bash', 'git push x')).toBe(false)
    expect(askRuleMatches(['Bash(git push *)'], 'Bash', { command: 5 })).toBe(false)
    expect(askRuleMatches(['', 'Bash(', 'Bash()', '(x)', 'Bash(git push *'], 'Bash', bash('git push x'))).toBe(false)
    expect(askRuleMatches([], 'Bash', bash('git push x'))).toBe(false)
  })
})

const SESSION_PID = 4_242_424
let h: Harness | undefined
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await h?.stop()
  h = undefined
})

async function start(rules: string[]) {
  h = await startHarness({
    config: ((c: Record<string, unknown>) => ({ ...c, permission_relay: true })) as never,
  })
  h.bridge.ctx.permission.setHookTimings({ graceMs: 100 })
  h.bridge.ctx.permission.setSessionPids([SESSION_PID])
  h.bridge.ctx.permission.setClientVersion(() => '2.1.312')
  h.bridge.ctx.permission.setAskRuleSource(() => rules)
  writeFileSync(join(h.home, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'test' }), {
    mode: 0o600,
  })
  return h
}

function rawCall(home: string, line: Record<string, unknown>) {
  const sock = createConnection(join(home, 'run', 'hub.sock'))
  sockets.push(sock)
  sock.on('connect', () => sock.write(`${JSON.stringify(line)}\n`))
  sock.on('error', () => {})
}

const perm = (id: string, extra: Record<string, unknown> = {}, command = 'git push origin main') => ({
  t: 'perm',
  id,
  tool_name: 'Bash',
  tool_input: { command, description: 'push it' },
  pid: SESSION_PID,
  permission_mode: 'bypassPermissions',
  ...extra,
})
const permissionCards = (x: Harness) =>
  x.relay.frames
    .filter(
      (f) => f.direction === 'from_bridge' && f.frame.type === 'card.create' && f.frame.card.kind === 'permission',
    )
    .map((f) => (f.frame as { card: CardT }).card)
const hookCard = async (x: Harness): Promise<CardT> => {
  let found: CardT | undefined
  await eventually(() => {
    found = permissionCards(x).find((c) => (c.payload as { request_id?: string }).request_id !== 'abcde')
    expect(found).toBeDefined()
  })
  return found as CardT
}

describe('the card says why it asked only when that is known', () => {
  test('main session, bypassPermissions, a rule of the owner matches: asked_why is your_rule', async () => {
    const x = await start(['Bash(git push *)'])
    rawCall(x.home, perm('r1'))
    expect((await hookCard(x)).asked_why).toBe('your_rule')
  })

  test('no matching rule: unset (Claude Code asked for a reason we cannot see)', async () => {
    const x = await start(['Bash(rm -rf *)'])
    rawCall(x.home, perm('r1'))
    expect((await hookCard(x)).asked_why).toBeUndefined()
  })

  test('the hook did not say the mode, or said another one, or something odd: unset', async () => {
    const x = await start(['Bash(git push *)'])
    for (const [i, mode] of [
      undefined,
      'default',
      'acceptEdits',
      'plan',
      'bypass',
      'BYPASSPERMISSIONS',
      '',
    ].entries()) {
      const line = perm(`m${i}`)
      if (mode === undefined) delete (line as Record<string, unknown>).permission_mode
      else line.permission_mode = mode
      rawCall(x.home, line)
    }
    await eventually(() => expect(permissionCards(x).filter((c) => c.deny_note).length).toBe(7))
    for (const c of permissionCards(x)) expect(c.asked_why).toBeUndefined()
  })

  test("a process that is not this bridge's Claude Code (pid not in its session): unset", async () => {
    const x = await start(['Bash(git push *)'])
    rawCall(x.home, perm('r1', { pid: 999_999 }))
    expect((await hookCard(x)).asked_why).toBeUndefined()
  })

  test('no pid at all: unset', async () => {
    const x = await start(['Bash(git push *)'])
    const line = perm('r1')
    delete (line as Record<string, unknown>).pid
    rawCall(x.home, line)
    expect((await hookCard(x)).asked_why).toBeUndefined()
  })

  test('a channel-relay card: unset (no mode, no source)', async () => {
    const x = await start(['Bash(git push *)'])
    await x.bridge.ctx.permission.onRequest({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'push it',
      input_preview: '{"command":"git push origin main"}',
    })
    const card = permissionCards(x)[0] as CardT
    expect(card.asked_why).toBeUndefined()
  })

  test('an unreadable rule source says nothing (a throwing source never blocks the card)', async () => {
    const x = await start([])
    x.bridge.ctx.permission.setAskRuleSource(() => {
      throw new Error('settings unreadable')
    })
    rawCall(x.home, perm('r1'))
    const card = await hookCard(x)
    expect(card.asked_why).toBeUndefined()
    expect(card.deny_note).toBe(true)
  })

  test('a mode string longer than the hub takes is refused before it is read: the request raises no card', async () => {
    const x = await start(['Bash(git push *)'])
    rawCall(x.home, perm('r1', { permission_mode: 'b'.repeat(200) }))
    // the hub's schema refuses the line (permission_mode is at most 30 characters): nothing is raised
    await eventually(() => expect(x.bridge.hub?.connections).toBe(0))
    expect(permissionCards(x)).toHaveLength(0)
  })
})
