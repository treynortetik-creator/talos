// Regression tests for the Claude Code control path. Each test pins one bug that was found and fixed.
// Temp dirs only: nothing here reads or writes the real ~/.claude.
import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionVerdictT } from '@talos-app/protocol'
import { permissionFixture } from '@talos-app/testkit'
import { runCli } from '../src/cli.ts'
import { claudeProcessLines } from '../src/permission/doctor.ts'
import { startHarness } from './helpers.ts'

const tmp = (p = 'cc-c1-review-') => realpathSync(mkdtempSync(join(tmpdir(), p)))
function cliIO(answer: string | (() => string) = 'y') {
  const out: string[] = []
  return {
    out,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(l),
      prompt: async () => (typeof answer === 'string' ? answer : answer()),
      sleep: async () => {},
      now: () => Date.now(),
    },
  }
}
const settings = (dir: string) => join(dir, '.claude', 'settings.json')

describe('CC-C1 review: install-ask-rules never loosens the file (F4)', () => {
  test('a 0600 settings file (it can hold `env` secrets) stays 0600', async () => {
    const agent = tmp()
    mkdirSync(join(agent, '.claude'))
    writeFileSync(settings(agent), JSON.stringify({ env: { SOME_TOKEN: 'x' } }), { mode: 0o600 })
    expect(await runCli(['install-ask-rules', '--agent-dir', agent], cliIO('y').io)).toBe(0)
    expect(statSync(settings(agent)).mode & 0o777).toBe(0o600)
  })

  test('a symlinked settings file (dotfiles) is edited through the link, not replaced by a copy', async () => {
    const agent = tmp()
    const dotfiles = tmp('cc-c1-dotfiles-')
    const real = join(dotfiles, 'claude-settings.json')
    writeFileSync(real, JSON.stringify({ model: 'opus' }))
    mkdirSync(join(agent, '.claude'))
    symlinkSync(real, settings(agent))
    expect(await runCli(['install-ask-rules', '--agent-dir', agent], cliIO('y').io)).toBe(0)
    expect(lstatSync(settings(agent)).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(real, 'utf8')).permissions?.ask).toContain('Bash(git push *)')
  })
})

describe('CC-C1 review: doctor misses a channel loaded with the development flag (F7)', () => {
  test('a running `claude --dangerously-load-development-channels plugin:imessage@…` is listed', async () => {
    // a harmless stand-in process whose command line looks like that launch (no claude is started)
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 4000)', 'claude', '--dangerously-load-development-channels', 'plugin:imessage@x'],
      { stdio: 'ignore' },
    )
    try {
      await new Promise((r) => setTimeout(r, 300))
      const lines = claudeProcessLines()
      expect(lines.some((l) => l.includes('plugin:imessage@x'))).toBe(true)
    } finally {
      child.kill()
    }
  })
})

describe('CC-C1 review: turning the relay off does not revoke open cards (F5)', () => {
  test('permission_relay set to false: a pending card can no longer send allow', async () => {
    const h = await startHarness()
    try {
      h.bridge.ctx.config.config.permission_relay = true
      h.bridge.setClientVersion(() => '2.1.312')
      const sent: PermissionVerdictT[] = []
      h.bridge.setPermissionSender(async (v) => {
        sent.push(v)
      })
      const fx = permissionFixture('plain_bash').params
      await h.bridge.ctx.permission.onRequest(fx)
      const card = (
        await h.relay.expectFrame(
          'card.create',
          (f) => (f.card.payload as { request_id?: string })?.request_id === fx.request_id,
          { direction: 'from_bridge' },
        )
      ).card
      // the owner switches phone approvals off (lost phone, changed their mind)
      h.bridge.ctx.config.config.permission_relay = false
      await h.app.resolveCard(card, 'primary', card.payload_hash, {
        stepup_token: h.relay.mintStepup(`card:${card.id}`),
      })
      await new Promise((r) => setTimeout(r, 300))
      expect(sent.filter((v) => v.behavior === 'allow')).toEqual([])
    } finally {
      await h.stop()
    }
  })
})
