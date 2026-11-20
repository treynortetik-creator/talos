// Dante's setup (2026-11-19): Main ran a whole morning without `--dangerously-load-development-channels server:talos-app`.
// Every outbound tool worked; nothing the owner sent was pushed in. The live bridge now reads its claude's launch at start,
// says it loudly in the log, writes it to status.json (talos_channel), and `doctor` FAILs and `status` says FAIL on it.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { CHANNEL_OFF_TEXT, loadsTalosChannel, type ProcReader, talosChannelState } from '../src/claude-env.ts'
import { runCli } from '../src/cli.ts'
import { paths } from '../src/config.ts'
import { readStatusFile } from '../src/status-file.ts'
import { type Harness, startHarness, tempHome, waitFor } from './helpers.ts'

/** A fake process tree: pid -> [parent, command line, program]. The bridge is pid 100. */
function tree(t: Record<number, [number, string, string?]>): ProcReader {
  return {
    parentOf: (pid) => t[pid]?.[0],
    envText: (pid) => `${t[pid]?.[1] ?? ''} PATH=/usr/bin`,
    commandText: (pid) => t[pid]?.[1] ?? '',
    executable: (pid) => t[pid]?.[2] ?? '',
  }
}
const FLAG = '--dangerously-load-development-channels server:talos-app'

describe('loadsTalosChannel', () => {
  test('server:talos-app among the development-channel values, in any form; nothing else', () => {
    expect(loadsTalosChannel(`claude ${FLAG}`)).toBe(true)
    expect(loadsTalosChannel('claude --dangerously-load-development-channels=server:talos-app')).toBe(true)
    expect(
      loadsTalosChannel('claude --dangerously-load-development-channels plugin:x@y server:talos-app --model o'),
    ).toBe(true)
    expect(loadsTalosChannel('claude --dangerously-load-development-channels plugin:x@y,server:talos-app')).toBe(true)
    // after another option the values are that option's
    expect(
      loadsTalosChannel('claude --dangerously-load-development-channels plugin:x@y --add-dir server:talos-app'),
    ).toBe(false)
    // Claude Code takes only approved channels with --channels: a server of one's own needs the development flag
    expect(loadsTalosChannel('claude --channels server:talos-app')).toBe(false)
    expect(loadsTalosChannel('claude --dangerously-load-development-channels server:talos-app2')).toBe(false)
  })
})

describe('talosChannelState: the claude above the bridge, read once', () => {
  const NATIVE = '/Users/alex/.local/share/claude/versions/2.1.322'
  const under = (claude: string, program = NATIVE) =>
    tree({
      100: [101, 'bun run --cwd /x --silent start'],
      101: [102, 'bash -c bun run start'],
      102: [103, claude, program],
      103: [1, '/bin/zsh -l'],
    })

  test('on with the development-channels flag; off without it, with only other channels, or with --channels', () => {
    expect(talosChannelState({}, under(`/opt/homebrew/bin/claude --model opus ${FLAG}`), 100)).toBe('on')
    expect(talosChannelState({}, under(`claude --channels server:talos-app --continue`), 100)).toBe('off')
    expect(talosChannelState({}, under('claude --model opus --continue'), 100)).toBe('off')
    expect(
      talosChannelState(
        {},
        under('claude --dangerously-load-development-channels plugin:imessage@claude-plugins'),
        100,
      ),
    ).toBe('off')
  })

  // npm's Claude Code sets process.title to "claude", which wipes its arguments from ps: a bare line from Node says nothing.
  test('a bare `claude` line: off from Claude Code’s own binary, unknown from Node or a program that cannot be read', () => {
    expect(talosChannelState({}, under('claude', NATIVE), 100)).toBe('off')
    expect(talosChannelState({}, under('/usr/local/bin/claude ', '/usr/local/bin/claude'), 100)).toBe('off')
    expect(talosChannelState({}, under('claude', '/usr/bin/node'), 100)).toBe('unknown')
    expect(talosChannelState({}, under('claude', 'node'), 100)).toBe('unknown') // a Mac's ps -o comm=
    expect(talosChannelState({}, under('claude', '/opt/node22/bin/node22'), 100)).toBe('unknown')
    expect(talosChannelState({}, under('claude', ''), 100)).toBe('unknown')
  })

  test('no claude above it (a test, an odd launcher): unknown, never a guess', () => {
    expect(talosChannelState({}, tree({ 100: [101, 'bun run start'], 101: [1, '/bin/zsh'] }), 100)).toBe('unknown')
    expect(talosChannelState({}, tree({}), 100)).toBe('unknown')
  })

  test('CLAUDE_PID names the claude to read; one that is not claude is unknown', () => {
    const t = tree({ 7: [1, `claude ${FLAG}`], 8: [1, 'vim notes.md'] })
    expect(talosChannelState({ CLAUDE_PID: '7' }, t, 100)).toBe('on')
    expect(talosChannelState({ CLAUDE_PID: '8' }, t, 100)).toBe('unknown')
  })

  test('the env text of a process (its variables) never counts as a channel flag', () => {
    const t: ProcReader = {
      parentOf: (pid) => (pid === 100 ? 101 : undefined),
      envText: () => `claude --model opus X=${FLAG}`,
      commandText: () => 'claude --model opus',
    }
    expect(talosChannelState({}, t, 100)).toBe('off')
  })

  test('a reader that throws is unknown', () => {
    const t: ProcReader = {
      parentOf: () => {
        throw new Error('ps gone')
      },
      envText: () => '',
    }
    expect(talosChannelState({}, t, 100)).toBe('unknown')
  })

  test("the tests' seam wins in a test run (test/preload.ts sets unknown), and only there", () => {
    expect(
      talosChannelState({ TALOS_TEST_SANDBOX: '/t', TALOS_TEST_CHANNEL: 'off' }, under(`claude ${FLAG}`), 100),
    ).toBe('off')
    expect(talosChannelState({ TALOS_TEST_CHANNEL: 'off' }, under(`claude ${FLAG}`), 100)).toBe('on')
    expect(process.env.TALOS_TEST_CHANNEL).toBe('unknown')
  })
})

/** A live-looking status.json written by hand, with the channel as given (undefined: an older bridge that never wrote it). */
function liveStatus(home: string, channel?: string) {
  const now = new Date().toISOString()
  mkdirSync(home, { recursive: true })
  writeFileSync(
    paths(home).status,
    JSON.stringify({
      v: 1,
      pid: process.pid,
      instance: 'i',
      started_at: now,
      mode: 'live',
      relay: { connected: true, last_connect_at: now, last_close_code: null },
      queue_depth: 0,
      unseen_oldest_at: null,
      permission_relay: false,
      permission_relay_declared: false,
      bridge_commit: 'abc1234',
      claude_session_marker_inherited: false,
      governor: null,
      last_owner_at: null,
      ...(channel === undefined ? {} : { talos_channel: channel }),
      updated_at: now,
    }),
  )
}

function io() {
  const out: string[] = []
  return {
    out,
    io: {
      out: (l: string) => out.push(l),
      err: () => {},
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.now(),
    },
  }
}

describe('status.json talos_channel, read by doctor and status', () => {
  test('read back as written; an older file, or a value this build does not know, is unknown', () => {
    for (const [written, read] of [
      ['on', 'on'],
      ['off', 'off'],
      [undefined, 'unknown'],
      ['maybe', 'unknown'],
    ] as const) {
      const home = tempHome()
      liveStatus(home, written)
      expect(readStatusFile(paths(home).status)?.talos_channel, String(written)).toBe(read)
    }
  })

  const doctorRows = async (channel?: string) => {
    const home = tempHome()
    liveStatus(home, channel)
    const c = io()
    await runCli(
      ['doctor', '--json', '--claude-dir', tempHome('talos-claude-')],
      c.io,
      { TALOS_APP_HOME: home },
      {
        processes: () => [],
        alive: () => true,
      },
    )
    return (
      JSON.parse(c.out.join('\n')) as { checks: Array<{ level: string; name: string; detail: string }> }
    ).checks.filter((r) => r.name === 'Talos channel')
  }

  test('doctor: FAIL with the words when the session was started without the channel; ok when on; nothing when unknown', async () => {
    expect(await doctorRows('off')).toEqual([{ level: 'FAIL', name: 'Talos channel', detail: CHANNEL_OFF_TEXT }])
    expect((await doctorRows('on')).map((r) => r.level)).toEqual(['ok'])
    expect(await doctorRows(undefined)).toEqual([])
  })

  test('status: a FAIL line under the bridge line when off, none when on', async () => {
    for (const [channel, want] of [
      ['off', true],
      ['on', false],
    ] as const) {
      const home = tempHome()
      liveStatus(home, channel)
      const c = io()
      await runCli(['status'], c.io, { TALOS_APP_HOME: home }, { alive: () => true })
      expect(c.out.includes(`FAIL: ${CHANNEL_OFF_TEXT}`), channel).toBe(want)
    }
  })
})

describe('the live bridge writes what it found at start', () => {
  let h: Harness | undefined
  const before = process.env.TALOS_TEST_CHANNEL
  afterEach(async () => {
    await h?.stop()
    h = undefined
    process.env.TALOS_TEST_CHANNEL = before
  })

  test('started without the channel: talos_channel off in status.json', async () => {
    process.env.TALOS_TEST_CHANNEL = 'off'
    h = await startHarness()
    const home = h.home
    await waitFor(() => readStatusFile(paths(home).status)?.talos_channel === 'off')
  })
})
