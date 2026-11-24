// gate-reads: kit/scripts/_test-env.sh kit/scripts/test-install.sh scripts/*
// talos_copy_kit (kit/scripts/_test-env.sh): the copy of a kit folder that the install self-test edits. It must not follow a link
// that leads out of the folder (an owner's vault would be copied into temp during the 1.x gate), and a shipped kit's own scripts/
// link into the release must become a real folder, so that a file removed from the copy is never the release's.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO, refusingPath } from './root-install-harness.ts'

const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'talos-copy-kit-'))
  made.push(d)
  return d
}
function copy(src: string, dest: string) {
  const r = spawnSync(
    'bash',
    ['-c', `. "${join(REPO, 'kit', 'scripts', '_test-env.sh')}"; talos_copy_kit "$1" "$2"`, 'x', src, dest],
    { encoding: 'utf8', env: { PATH: refusingPath(), HOME: tmpdir() } },
  )
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
}
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [e.name]))

describe('talos_copy_kit', () => {
  it('the install self-test copies the kit with it, never with cp -RL (which follows every link)', () => {
    const text = readFileSync(join(REPO, 'kit', 'scripts', 'test-install.sh'), 'utf8')
    expect(text).not.toMatch(/cp -RL/)
    expect(text).toContain('talos_copy_kit "$KIT"')
  })

  it('a link that leads out of the folder is copied as a link, never followed', () => {
    const root = tmp()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret-note.txt'), 'private')
    const kit = join(root, 'kit')
    mkdirSync(join(kit, 'scripts'), { recursive: true })
    writeFileSync(join(kit, 'scripts', 'a.sh'), 'x')
    symlinkSync(outside, join(kit, 'vault'))
    copy(kit, join(root, 'copy'))
    expect(lstatSync(join(root, 'copy', 'vault')).isSymbolicLink()).toBe(true)
    expect(files(join(root, 'copy', 'scripts'))).toEqual(['a.sh'])
    // nothing from the outside folder was copied into the copy
    expect(readdirSync(join(root, 'copy')).filter((n) => n === 'secret-note.txt')).toEqual([])
    expect(existsSync(join(root, 'copy', 'secret-note.txt'))).toBe(false)
  })

  it("a shipped kit's scripts/ link into the release becomes a real folder: a file removed from the copy is the copy's own", () => {
    const root = tmp()
    const release = join(root, 'release', 'talos-kit', 'scripts')
    mkdirSync(release, { recursive: true })
    writeFileSync(join(release, 'install-chronos-scope.sh'), 'rule')
    const agent = join(root, 'agent')
    mkdirSync(agent)
    symlinkSync(release, join(agent, 'scripts'))
    copy(agent, join(root, 'copy'))
    expect(lstatSync(join(root, 'copy', 'scripts')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(root, 'copy', 'scripts', 'install-chronos-scope.sh'))).toBe(true)
    rmSync(join(root, 'copy', 'scripts', 'install-chronos-scope.sh'))
    expect(existsSync(join(release, 'install-chronos-scope.sh'))).toBe(true)
  })

  it('a scripts/ link that does not lead into a release is left a link and its target untouched', () => {
    const root = tmp()
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'personal.txt'), 'mine')
    const kit = join(root, 'kit')
    mkdirSync(kit)
    symlinkSync(elsewhere, join(kit, 'scripts'))
    copy(kit, join(root, 'copy'))
    expect(lstatSync(join(root, 'copy', 'scripts')).isSymbolicLink()).toBe(true)
    expect(files(elsewhere)).toEqual(['personal.txt'])
  })
})
