// The root ./install.sh and desktop.json: malformed files are left alone (split from root-install-desktop.test.ts so the two
// halves run side by side; the imports and helpers are the same).
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

    const bad: [string, string, string][] = [
      ['not valid JSON', '{ not json', 'not valid JSON'],
      ['a top level that is a list', '[1,2]\n', 'not a JSON object'],
      ['a top level that is a string', '"hello"\n', 'not a JSON object'],
      ['a top level that is null', 'null\n', 'not a JSON object'],
      ['a numeric agent_dir', '{"v":1,"agent_dir":7,"args":[]}\n', 'agent_dir'],
      ['a list agent_dir', '{"v":1,"agent_dir":["x"],"args":[]}\n', 'agent_dir'],
      ['args that is not a list of strings', '{"v":1,"agent_dir":"~/talos-agent","args":[1]}\n', 'args'],
    ]
    for (const [name, text, word] of bad) {
      it(`${name}: left byte-identical, plain message, no traceback`, () => {
        const sb = sandbox()
        put(sb, text)
        const r = run(sb, ['--yes'], mac)
        expect(r.code, r.out).toBe(0)
        expect(readFileSync(DESKTOP_JSON(sb), 'utf8')).toBe(text)
        expect(backups(sb)).toEqual([])
        expect(r.out).toContain(word)
        expect(r.out).not.toContain('Traceback')
        settings(sb, r.out)
      }, 120_000)
    }
  })
})
