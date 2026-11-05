import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'check-no-personal.sh')
const generic = join(here, 'denylist.generic.txt')

function run(files: Record<string, string>, privateRules?: string) {
  const root = mkdtempSync(join(tmpdir(), 'cnp-'))
  const scripts = join(root, 'scripts')
  mkdirSync(scripts, { recursive: true })
  // the script reads its rule files from its own directory, so copy it next to the generic list
  writeFileSync(join(scripts, 'check-no-personal.sh'), readFileSync(script))
  writeFileSync(join(scripts, 'denylist.generic.txt'), readFileSync(generic))
  if (privateRules) writeFileSync(join(scripts, 'personal-denylist.txt'), privateRules)
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), content)
  }
  const r = spawnSync('bash', [join(scripts, 'check-no-personal.sh'), root], { encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('check-no-personal.sh', () => {
  it('passes on generic content', () => {
    const r = run({
      'a.md': 'Contact alex@example.com or owner@example.org. Timezone UTC. Alex Example.\n',
      'examples/c.json': '{"timezone":"Europe/Berlin"}\n',
      'src/x.ts': 'const v = "pnpm@10.33.0"\n',
    })
    expect(r.out).toContain('ok')
    expect(r.code).toBe(0)
  })

  // Violation samples are assembled at run time so this file itself contains nothing the scan would flag.
  const j = (...parts: string[]) => parts.join('')
  it.each([
    ['a real-looking email', 'a.md', `mail me at ${j('jo.smith', '@', 'gmail.com')}\n`],
    ['a phone number', 'a.md', `call ${['555', '555', '0100'].join('-')} now\n`],
    ['a home path', 'a.md', `see ${j('/Users', '/jsmith')}/project\n`],
    ['a Linux home path', 'a.md', `see ${j('/home', '/jsmith')}/project\n`],
    ['a chat id', 'src/a.ts', `const ${j('chat', '_id')} = ${j('12345', '67890')}\n`],
    ['a non-allowed IANA zone in examples', 'examples/c.json', `{"timezone":"${j('America', '/Los_Angeles')}"}\n`],
    ['a non-allowed IANA zone in fixtures', 'packages/protocol/fixtures/c.json', `{"tz":"${j('Asia', '/Tokyo')}"}\n`],
    ['a Talos message id in docs', 'docs/a.md', `see ${j('m', '_01', 'J8Q2ZK4V7XW3N5P6R9T0YB1CDE')} for details\n`],
    [
      'gendered owner pronouns in UI copy',
      'apps/web/src/copy.ts',
      `const s = 'Ask the owner if ${j('h', 'e')} wants this'\n`,
    ],
  ])('flags %s', (_name, file, content) => {
    const r = run({ [file]: content })
    expect(r.code).toBe(1)
    expect(r.out).toContain('FAILED')
    expect(r.out).toContain(file)
  })

  it('names the file, line and rule of a hit and never prints the matched text', () => {
    const secret = 'Zorp' + 'Industries'
    const r = run({ 'src/a.ts': `// ok\nconst v = '${secret}'\n` }, `.*\t-\t${secret}\n`)
    expect(r.code).toBe(1)
    expect(r.out).toContain('src/a.ts:2')
    expect(r.out).toContain('personal-denylist.txt rule line 1')
    expect(r.out).not.toContain(secret)
    const e = run({ 'a.md': `mail ${'jsmith'}@${'corp'}.io\n` })
    expect(e.out).toContain('a.md:1')
    expect(e.out).toContain('denylist.generic.txt rule line')
    expect(e.out).not.toContain('jsmith')
  })

  it('does not flag path fragments that merely contain home/', () => {
    expect(run({ 'a.md': 'web/ # cards/home/inbox/integrations\n' }).code).toBe(0)
  })

  it('does not flag zones outside examples and fixtures (tests may use real zones)', () => {
    expect(run({ 'packages/protocol/test/q.test.ts': "isQuiet(d, qw, 'America/New_York')\n" }).code).toBe(0)
  })

  it('applies the private list when present and skips the list file itself', () => {
    const secret = 'Zorp' + 'Industries'
    const rules = `.*\t-\t${secret}\n`
    expect(run({ 'a.md': `I work at ${secret}\n` }, rules).code).toBe(1)
    expect(run({ 'a.md': 'clean\n' }, rules).code).toBe(0)
  })

  it('scans text files under assets/ and this test file (nothing is exempt but binaries, the lockfile and the rule files)', () => {
    expect(run({ 'assets/brand/README.md': `mail ${j('jo', '@', 'gmail.com')}\n` }).code).toBe(1)
    expect(run({ 'scripts/check-no-personal.test.ts': `const x = '${j('jo', '@', 'gmail.com')}'\n` }).code).toBe(1)
    expect(run({ 'assets/mascot.png': `${j('jo', '@', 'gmail.com')}\n` }).code).toBe(0)
  })

  it('works inside a git checkout and sees untracked files', () => {
    const root = mkdtempSync(join(tmpdir(), 'cnp-git-'))
    execFileSync('git', ['init', '-q'], { cwd: root })
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'scripts', 'denylist.generic.txt'), readFileSync(generic))
    writeFileSync(join(root, 'scripts', 'check-no-personal.sh'), readFileSync(script))
    writeFileSync(join(root, 'a.md'), `${j('jo', '@', 'gmail.com')}\n`)
    const r = spawnSync('bash', [join(root, 'scripts', 'check-no-personal.sh')], { cwd: root, encoding: 'utf8' })
    expect(r.status).toBe(1)
  })

  it('CHECK_EXTRA_RULES adds a rule file kept elsewhere (the worktree case); a named file that is missing is an error', () => {
    const root = mkdtempSync(join(tmpdir(), 'cnp-x-'))
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'scripts', 'denylist.generic.txt'), readFileSync(generic))
    writeFileSync(join(root, 'scripts', 'check-no-personal.sh'), readFileSync(script))
    writeFileSync(join(root, 'a.md'), 'zq-extra-marker-41\n')
    const extra = join(root, 'elsewhere.txt')
    writeFileSync(extra, '.*\t-\tzq-extra-marker-41\n')
    const go = (e: Record<string, string>) =>
      spawnSync('bash', [join(root, 'scripts', 'check-no-personal.sh'), root], {
        encoding: 'utf8',
        env: { ...process.env, ...e },
      })
    expect(go({}).status).toBe(0) // generic rules alone do not know the marker
    const hit = go({ CHECK_EXTRA_RULES: extra })
    expect(hit.status).toBe(1)
    expect(hit.stderr).toContain('elsewhere.txt rule line 1')
    expect(hit.stderr).not.toContain('zq-extra-marker-41')
    const missing = go({ CHECK_EXTRA_RULES: join(root, 'nope.txt') })
    expect(missing.status).toBe(2)
    expect(missing.stderr).toContain('does not exist')
  })

  it('scans files whose names git would quote: non-ASCII, a double quote, a tab, a space (tracked, in a git checkout)', () => {
    const names = ['café notes.md', 'say "hi".md', 'tab\there.md', 'plain name.md']
    for (const useGit of [true, false]) {
      const root = mkdtempSync(join(tmpdir(), 'cnp-n-'))
      if (useGit) execFileSync('git', ['init', '-q'], { cwd: root })
      mkdirSync(join(root, 'scripts'))
      writeFileSync(join(root, 'scripts', 'denylist.generic.txt'), readFileSync(generic))
      writeFileSync(join(root, 'scripts', 'check-no-personal.sh'), readFileSync(script))
      for (const n of names) {
        writeFileSync(join(root, n), 'fine\n')
      }
      if (useGit) execFileSync('git', ['add', '-A'], { cwd: root })
      const go = () => spawnSync('bash', [join(root, 'scripts', 'check-no-personal.sh'), root], { encoding: 'utf8' })
      const clean = go()
      expect(clean.status, clean.stderr).toBe(0)
      expect(clean.stdout).toContain(`ok (${names.length + 1} files`) // every name, plus the script; the rule list is not scanned
      for (const n of names) {
        writeFileSync(join(root, n), `${j('jo', '@', 'gmail.com')}\n`)
        const r = go()
        expect(r.status, `${JSON.stringify(n)} in git=${useGit}`).toBe(1)
        expect(r.stderr).toContain('FAILED')
        writeFileSync(join(root, n), 'fine\n')
      }
    }
  })

  it('a malformed rule is reported by file name and line only, never by its text', () => {
    const root = mkdtempSync(join(tmpdir(), 'cnp-b-'))
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'scripts', 'denylist.generic.txt'), readFileSync(generic))
    writeFileSync(join(root, 'scripts', 'check-no-personal.sh'), readFileSync(script))
    writeFileSync(join(root, 'scripts', 'personal-denylist.txt'), '# c\nzq-private-value-55\t-\n')
    const r = spawnSync('bash', [join(root, 'scripts', 'check-no-personal.sh'), root], { encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('bad rule at personal-denylist.txt line 2')
    expect(r.stderr).not.toContain('zq-private-value-55')
  })

  it('a listing that fails is an error (exit 2) and says nothing was checked, never a quiet ok', () => {
    const mk = (git: boolean) => {
      const root = mkdtempSync(join(tmpdir(), 'cnp-f-'))
      if (git) execFileSync('git', ['init', '-q'], { cwd: root })
      mkdirSync(join(root, 'scripts'))
      writeFileSync(join(root, 'scripts', 'denylist.generic.txt'), readFileSync(generic))
      writeFileSync(join(root, 'scripts', 'check-no-personal.sh'), readFileSync(script))
      writeFileSync(join(root, 'a.md'), `${j('jo', '@', 'gmail.com')}\n`)
      return root
    }
    const go = (root: string, env: Record<string, string> = {}) =>
      spawnSync('bash', [join(root, 'scripts', 'check-no-personal.sh'), root], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      })
    const g = mk(true)
    writeFileSync(join(g, '.git', 'index'), 'not an index') // git ls-files cannot read it
    const r1 = go(g)
    expect(r1.status).toBe(2)
    expect(r1.stderr).toContain('nothing was checked')
    expect(r1.stdout).not.toContain('ok')
    const f = mk(false)
    mkdirSync(join(f, 'locked'))
    chmodSync(join(f, 'locked'), 0o000) // find cannot read it
    try {
      const r2 = go(f)
      expect(r2.status).toBe(2)
      expect(r2.stderr).toContain('nothing was checked')
    } finally {
      chmodSync(join(f, 'locked'), 0o755)
    }
  })

  it('GIT_DIR in the environment (a hook in a linked worktree) does not steer the listing: CHECK_NO_GIT lists the folder itself', () => {
    const other = mkdtempSync(join(tmpdir(), 'cnp-g-'))
    execFileSync('git', ['init', '-q'], { cwd: other })
    appendFileSync(join(other, '.git', 'info', 'exclude'), 'hidden-*.md\n')
    const root = mkdtempSync(join(tmpdir(), 'cnp-h-'))
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'scripts', 'denylist.generic.txt'), readFileSync(generic))
    writeFileSync(join(root, 'scripts', 'check-no-personal.sh'), readFileSync(script))
    writeFileSync(join(root, 'hidden-n.md'), `${j('jo', '@', 'gmail.com')}\n`) // ignored by the other repository's rules
    for (const env of [{ GIT_DIR: join(other, '.git') }, { GIT_DIR: join(other, '.git'), CHECK_NO_GIT: '1' }]) {
      const r = spawnSync('bash', [join(root, 'scripts', 'check-no-personal.sh'), root], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      })
      expect(r.status, JSON.stringify(env)).toBe(1)
    }
  })

  it('keeps the committed generic list free of owner-specific strings', () => {
    const text = readFileSync(generic, 'utf8').toLowerCase()
    const owner = [
      'trey' + 'nor',
      'safely' + 'you',
      'vir' + 'gil',
      'phoe' + 'nix',
      '20:' + '15',
      'job ' + 'hunt',
      'derr' + 'yck',
      'enterprise ' + 'it',
    ]
    for (const s of owner) expect(text.includes(s), s).toBe(false)
  })

  it('a failed write of the file list is an error, never a quiet pass over a list that is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'cnp-full-'))
    const scripts = join(root, 'scripts')
    mkdirSync(scripts, { recursive: true })
    writeFileSync(join(scripts, 'check-no-personal.sh'), readFileSync(script))
    writeFileSync(join(scripts, 'denylist.generic.txt'), readFileSync(generic))
    writeFileSync(join(root, 'a.md'), 'fine\n')
    // A mktemp whose file is a link to nowhere: writing the list fails, the way it does on a full disk.
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const stub = join(bin, 'mktemp')
    writeFileSync(stub, '#!/bin/sh\nd="$(/usr/bin/mktemp -d)"; ln -s /nonexistent/dir/list "$d/list"; echo "$d/list"\n')
    chmodSync(stub, 0o755)
    const r = spawnSync('bash', [join(scripts, 'check-no-personal.sh'), root], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    expect(`${r.stdout}${r.stderr}`).not.toContain('ok (')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('file list')
  })
})
