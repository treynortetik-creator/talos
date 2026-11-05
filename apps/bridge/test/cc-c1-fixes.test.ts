// CC-C1 fix round: other channels (note, not a block), relay-off cancels open cards, channel flag parsing, installer safety.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { permissionFixture } from '@talos-app/testkit'
import { runCli } from '../src/cli.ts'
import { channelNames, otherChannelsFromLines } from '../src/permission/doctor.ts'
import { startHarness } from './helpers.ts'

describe('channel flag parsing', () => {
  test('plugins and servers after --channels or the dev flag; Talos itself is not "other"', () => {
    const line =
      'claude --channels plugin:imessage@claude-plugins-official --dangerously-load-development-channels server:talos-app plugin:discord@x --model opus'
    expect(channelNames(line)).toEqual(['imessage', 'talos-app', 'discord'])
    expect(otherChannelsFromLines([line])).toEqual(['discord', 'imessage'])
    expect(otherChannelsFromLines(['claude --channels=plugin:imessage@x'])).toEqual(['imessage'])
    expect(otherChannelsFromLines(['claude --dangerously-skip-permissions'])).toEqual([])
  })
})

describe('turning the relay off closes the open cards', () => {
  test('reconcile() expires them and tells the app', async () => {
    const h = await startHarness()
    try {
      h.bridge.ctx.config.config.permission_relay = true
      h.bridge.setClientVersion(() => '2.1.312')
      h.bridge.setPermissionSender(async () => {})
      await h.bridge.ctx.permission.onRequest(permissionFixture('plain_bash').params)
      const card = (
        await h.relay.expectFrame('card.create', (f) => f.card.kind === 'permission', { direction: 'from_bridge' })
      ).card
      h.bridge.ctx.config.config.permission_relay = false
      h.bridge.ctx.permission.reconcile()
      expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('expired')
      expect(h.bridge.ctx.permission.openCount).toBe(0)
      await h.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.reason === 'relay_off', {
        direction: 'from_bridge',
      })
    } finally {
      await h.stop()
    }
  })
})

describe('install-ask-rules: headless warning lists the rules; nothing is written on a dry run', () => {
  test('names --setting-sources and each rule', async () => {
    const agent = mkdtempSync(join(tmpdir(), 'cc-c1-fix-'))
    const out: string[] = []
    const io = {
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(l),
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => 0,
    }
    expect(await runCli(['install-ask-rules', '--agent-dir', agent, '--dry-run'], io)).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('HEADLESS RUNS')
    expect(text).toContain('--setting-sources user')
    expect(text).toContain('Bash(git push *)')
    expect(text).toContain('Bash(rm -R *)')
  })

  test('a change made while the y/N prompt is open is refused with that change kept; an unchanged file is written', async () => {
    const quiet = (prompt: (f: string) => Promise<string>) => (f: string) => {
      const out: string[] = []
      return {
        out,
        io: {
          out: (l: string) => out.push(l),
          err: (l: string) => out.push(l),
          prompt: () => prompt(f),
          sleep: async () => {},
          now: () => 0,
        },
      }
    }
    const setup = () => {
      const agent = mkdtempSync(join(tmpdir(), 'cc-c1-fix-'))
      mkdirSync(join(agent, '.claude'))
      const f = join(agent, '.claude', 'settings.json')
      writeFileSync(f, '{"a":1}')
      return { agent, f }
    }
    // Changed behind our back: refused, and the other writer's content is what stays on disk.
    const changed = setup()
    const c = quiet(async (f) => {
      writeFileSync(f, '{"a":2}')
      return 'y'
    })(changed.f)
    expect(await runCli(['install-ask-rules', '--agent-dir', changed.agent], c.io)).toBe(1)
    expect(readFileSync(changed.f, 'utf8')).toBe('{"a":2}')
    expect(c.out.join('\n')).toContain('changed while waiting')
    // Control: the same run with nobody else writing is accepted and the rules land next to the original key.
    const clean = setup()
    const u = quiet(async () => 'y')(clean.f)
    expect(await runCli(['install-ask-rules', '--agent-dir', clean.agent], u.io)).toBe(0)
    const cfg = JSON.parse(readFileSync(clean.f, 'utf8'))
    expect(cfg.a).toBe(1)
    expect(cfg.permissions.ask).toContain('Bash(git push *)')
  })
})
