// The root ./install.sh: the Mac app launches this agent (desktop.json). Harness: root-install-harness.ts.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  calls,
  DESKTOP_JSON,
  FLAGS,
  flag,
  MOD,
  mac,
  run,
  type Sandbox,
  SCRIPT,
  sandbox,
} from './root-install-harness.ts'

describe('root install.sh', () => {
  describe('the Mac app launches this agent (desktop.json)', () => {
    const dir = (sb: Sandbox) => join(sb.home, 'Library', 'Application Support', 'Talos')
    const put = (sb: Sandbox, text: string) => {
      mkdirSync(dir(sb), { recursive: true })
      writeFileSync(DESKTOP_JSON(sb), text)
    }
    const backups = (sb: Sandbox) => readdirSync(dir(sb)).filter((n) => n.includes('.bak'))
    const settings = (sb: Sandbox, out: string) => {
      expect(out).toContain('Settings')
      expect(out).toContain(sb.agent)
      expect(out).toContain(`--plugin-dir ${MOD}`)
      expect(out).toContain('--dangerously-load-development-channels server:talos-app')
    }

    it('always passes --no-quit to the desktop installer, running app or not', () => {
      for (const running of [false, true]) {
        const sb = sandbox()
        if (running) writeFileSync(flag(sb, 'app-running'), '')
        const r = run(sb, ['--yes'], mac)
        expect(r.code, r.out).toBe(0)
        expect(calls(sb)).toContain('app-install.sh --no-open --no-quit')
        expect(calls(sb).filter((c) => c.startsWith('osascript') && /quit/.test(c))).toEqual([])
      }
      const dry = run(sandbox(), ['--yes', '--dry-run'], mac)
      expect(dry.out).toContain('--no-quit')
    }, 120_000)

    it('--no-relay-wait goes through to the desktop installer, and only when given', () => {
      const sb = sandbox()
      const r = run(sb, ['--yes', '--no-relay-wait'], mac)
      expect(r.code, r.out).toBe(0)
      expect(calls(sb)).toContain('app-install.sh --no-open --no-quit --no-relay-wait')
      const plain = sandbox()
      expect(run(plain, ['--yes'], mac).code).toBe(0)
      expect(calls(plain).filter((c) => c.includes('--no-relay-wait'))).toEqual([])
      expect(run(sandbox(), ['--yes', '--dry-run', '--no-relay-wait'], mac).out).toContain('--no-relay-wait')
    }, 120_000)

    it('the desktop installer stopping for the relay (exit 8) is said as that, not as a generic failure', () => {
      const sb = sandbox()
      writeFileSync(
        join(sb.desktop, 'install.sh'),
        '#!/bin/sh\necho "install: stopped, nothing was installed: the relay is still on version a1 while this build is b2" >&2\nexit 8\n',
      )
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).not.toBe(0)
      expect(r.out).toContain('the relay is still on version a1 while this build is b2')
      expect(r.out).toContain('the Mac app was built but not installed: the relay does not serve this build yet')
      expect(r.out).toContain('--no-relay-wait')
      expect(r.out).not.toContain('installing the Mac app failed')
    }, 120_000)

    it('a missing desktop.json is not created: the exact Settings change is printed, with the reason', () => {
      const sb = sandbox()
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      expect(existsSync(DESKTOP_JSON(sb))).toBe(false)
      expect(existsSync(dir(sb))).toBe(false)
      settings(sb, r.out)
      expect(r.out).toContain('pre-setup')
    }, 120_000)

    it('a running app: nothing is written, the Settings change and the reason are printed', () => {
      const sb = sandbox()
      const text = '{"v":1,"agent_dir":"~/talos-agent","args":["--model","opus"]}\n'
      put(sb, text)
      writeFileSync(flag(sb, 'app-running'), '')
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(DESKTOP_JSON(sb), 'utf8')).toBe(text)
      expect(backups(sb)).toEqual([])
      settings(sb, r.out)
      expect(r.out).toContain('overwrites')
    }, 120_000)

    it('an existing file, app not running: merges, keeps every other key, backs up first, mode 0600, rerun is a no-op', () => {
      const sb = sandbox()
      const old = {
        v: 1,
        agent_dir: '~/talos-agent',
        args: ['--model', 'opus', '--dangerously-load-development-channels', 'server:talos-app'],
        env: { FOO: 'bar' },
        hotkeys: { compose: 'ctrl+opt+space' },
        future_key: { nested: [1, 2] },
      }
      const oldText = `${JSON.stringify(old, null, 2)}\n`
      put(sb, oldText)
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      const cfg = JSON.parse(readFileSync(DESKTOP_JSON(sb), 'utf8'))
      expect(cfg.args).toEqual([...old.args, '--plugin-dir', MOD])
      expect(cfg.env).toEqual({ FOO: 'bar' })
      expect(cfg.future_key).toEqual({ nested: [1, 2] })
      expect(cfg.agent_dir).toBe('~/talos-agent')
      expect(statSync(DESKTOP_JSON(sb)).mode & 0o777).toBe(0o600)
      expect(backups(sb)).toHaveLength(1)
      expect(readFileSync(join(dir(sb), backups(sb)[0] as string), 'utf8')).toBe(oldText)
      mkdirSync(join(sb.home, 'Applications', 'Talos.app'), { recursive: true })
      const again = run(sb, ['--yes'], mac)
      expect(again.code, again.out).toBe(0)
      expect(again.out).toContain('Nothing to change')
      expect(backups(sb)).toHaveLength(1)
    }, 120_000)

    it('fsyncs the temp file before it replaces the real one', () => {
      const text = readFileSync(SCRIPT, 'utf8')
      const fs = text.indexOf('os.fsync')
      const rep = text.indexOf('os.replace')
      expect(fs).toBeGreaterThan(-1)
      expect(rep).toBeGreaterThan(fs)
    })

    it('a symlinked desktop.json: the target is updated and the link stays a link', () => {
      const sb = sandbox()
      mkdirSync(dir(sb), { recursive: true })
      const real = join(sb.root, 'dotfiles', 'desktop.json')
      mkdirSync(join(sb.root, 'dotfiles'))
      writeFileSync(real, '{"v":1,"agent_dir":"~/talos-agent","args":[]}\n')
      symlinkSync(real, DESKTOP_JSON(sb))
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      expect(lstatSync(DESKTOP_JSON(sb)).isSymbolicLink()).toBe(true)
      expect(readlinkSync(DESKTOP_JSON(sb))).toBe(real)
      expect(JSON.parse(readFileSync(real, 'utf8')).args).toEqual(FLAGS)
    }, 120_000)

    it('a dangling symlink counts as missing: nothing is written through it', () => {
      const sb = sandbox()
      mkdirSync(dir(sb), { recursive: true })
      const target = join(sb.root, 'nowhere.json')
      symlinkSync(target, DESKTOP_JSON(sb))
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      expect(existsSync(target)).toBe(false)
      expect(lstatSync(DESKTOP_JSON(sb)).isSymbolicLink()).toBe(true)
      settings(sb, r.out)
    }, 120_000)

    it('leaves a desktop.json for a different agent folder alone and says what to change in Settings', () => {
      const sb = sandbox()
      const text = '{"v":1,"agent_dir":"/home/alex/other-agent","args":["--model","opus"]}\n'
      put(sb, text)
      const r = run(sb, ['--yes'], mac)
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(DESKTOP_JSON(sb), 'utf8')).toBe(text)
      expect(r.out).toContain('/home/alex/other-agent')
      settings(sb, r.out)
    }, 120_000)

    it('--no-app leaves desktop.json alone', () => {
      const sb = sandbox()
      const text = '{"v":1,"agent_dir":"~/talos-agent","args":[]}\n'
      put(sb, text)
      expect(run(sb, ['--no-app', '--yes'], mac).code).toBe(0)
      expect(readFileSync(DESKTOP_JSON(sb), 'utf8')).toBe(text)
    }, 120_000)
  })
})
