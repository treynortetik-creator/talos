// The root ./install.sh: a second clone does not hijack an existing agent. Harness: root-install-harness.ts.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO, run, type Sandbox, sandbox, snapshot, treeHash } from './root-install-harness.ts'

describe('root install.sh', () => {
  describe('a second clone does not hijack an existing agent', () => {
    const point = (sb: Sandbox) => {
      const mcp = join(sb.agent, '.mcp.json')
      const cfg = JSON.parse(readFileSync(mcp, 'utf8'))
      cfg.mcpServers['talos-app'].args[2] = '/home/alex/old-clone/apps/bridge'
      writeFileSync(mcp, `${JSON.stringify(cfg, null, 2)}\n`)
      const st = join(sb.agent, 'start-talos.sh')
      writeFileSync(st, readFileSync(st, 'utf8').split(REPO).join('/home/alex/old-clone'))
    }
    it('refuses without --repoint, names both clones, and changes nothing', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      point(sb)
      const before = snapshot(sb.agent)
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('/home/alex/old-clone')
      expect(r.out).toContain(REPO)
      expect(r.out).toContain('--repoint')
      expect(snapshot(sb.agent)).toEqual(before)
    }, 120_000)

    it('records the clone as a comment line in start-talos.sh', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      expect(readFileSync(join(sb.agent, 'start-talos.sh'), 'utf8').split('\n')).toContain(`# talos-clone: ${REPO}`)
    }, 120_000)

    it('a clone path with a space is told apart from this clone, and the same path is accepted', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      const st = join(sb.agent, 'start-talos.sh')
      const orig = readFileSync(st, 'utf8')
      writeFileSync(st, orig.replace(`# talos-clone: ${REPO}`, '# talos-clone: /home/alex/my clones/talos app'))
      const r = run(sb, ['--no-app', '--yes'])
      expect(r.code).toBe(1)
      expect(r.out).toContain('/home/alex/my clones/talos app')
      writeFileSync(st, orig)
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
    }, 120_000)

    it.each([
      ['unparsable .mcp.json', (sb: Sandbox) => writeFileSync(join(sb.agent, '.mcp.json'), '{ hand edited')],
      [
        'a hand-edited .mcp.json with --cwd gone',
        (sb: Sandbox) =>
          writeFileSync(
            join(sb.agent, '.mcp.json'),
            JSON.stringify({ mcpServers: { 'talos-app': { command: 'bun', args: ['run', '--silent', 'start'] } } }),
          ),
      ],
      [
        'a .mcp.json whose talos-app args are not a list',
        (sb: Sandbox) =>
          writeFileSync(join(sb.agent, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': { args: 'x' } } })),
      ],
      [
        'a start-talos.sh without the clone line',
        (sb: Sandbox) => {
          const st = join(sb.agent, 'start-talos.sh')
          writeFileSync(st, readFileSync(st, 'utf8').replace(/^# talos-clone:.*\n/m, ''))
        },
      ],
      [
        'an unreadable start-talos.sh',
        (sb: Sandbox) => {
          const st = join(sb.agent, 'start-talos.sh')
          rmSync(st)
          mkdirSync(st) // a folder where the file should be: cannot be read as a file
        },
      ],
    ])(
      'fails closed on %s: refused without --repoint, nothing changed',
      (_n, edit) => {
        const sb = sandbox()
        expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
        edit(sb)
        const before = treeHash(sb.agent)
        const r = run(sb, ['--no-app', '--yes'])
        expect(r.code, r.out).toBe(1)
        expect(r.out).toContain('--repoint')
        expect(treeHash(sb.agent)).toBe(before)
      },
      120_000,
    )

    it('--repoint moves both files to this clone', () => {
      const sb = sandbox()
      expect(run(sb, ['--no-app', '--yes']).code).toBe(0)
      point(sb)
      const r = run(sb, ['--no-app', '--yes', '--repoint'])
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(join(sb.agent, 'start-talos.sh'), 'utf8')).toContain(REPO)
      expect(readFileSync(join(sb.agent, '.mcp.json'), 'utf8')).toContain(join(REPO, 'apps', 'bridge'))
    }, 120_000)
  })
})
