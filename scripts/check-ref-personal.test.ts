// scripts/check-ref-personal.sh against a scratch "remote" with a made-up private list (personal-watch-fixture.ts).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkRef, FAKE, here, noValue, RULE, s12, setup, snapshot, tmpEmpty } from './personal-watch-fixture'

describe('check-ref-personal.sh', () => {
  it('names the file and line of a hit on a handoff branch, never the value, and leaves no temp folder or checkout change', () => {
    const e = setup()
    e.git(e.dev, 'checkout', '-q', '-b', 'handoff/x')
    const sha = e.commit({ 'src/leak.ts': `// one\n// two\nconst org = '${FAKE}'\n` })
    e.push('handoff/x')
    e.git(e.owner, 'fetch', '-q', 'origin')
    const before = snapshot(e)
    const r = checkRef(e, ['origin/handoff/x'])
    expect(r.code, r.err).toBe(1)
    expect(r.out).toBe(`${s12(sha)} src/leak.ts:3 ${RULE}\n`)
    noValue(r.out + r.err)
    tmpEmpty(e)
    expect(snapshot(e)).toEqual(before)
  })

  it('is silent on a clean branch and checks only what the ref brings in, not what main already had', () => {
    const e = setup()
    const old = e.commit({ 'old.md': `${FAKE}\n` }) // on main before the branch: not this ref's change
    e.push()
    e.git(e.dev, 'checkout', '-q', '-b', 'handoff/clean')
    e.commit({ 'src/b.ts': 'export const b = 2\n' })
    e.push('handoff/clean')
    const r = checkRef(e, ['origin/handoff/clean'])
    expect(r.out).toBe('')
    expect(r.code, r.err).toBe(0)
    e.git(e.dev, 'checkout', '-q', 'main')
    // a commit already on main is checked against its parent
    const onMain = checkRef(e, [old])
    expect(onMain.code).toBe(1)
    expect(onMain.out).toBe(`${s12(old)} old.md:1 ${RULE}\n`)
  })

  it('checks the commit message too, and finds the private list in the main checkout when run from a worktree', () => {
    const e = setup()
    e.git(e.dev, 'checkout', '-q', '-b', 'handoff/msg')
    const sha = e.commit({ 'src/c.ts': 'export const c = 3\n' }, `land the ${FAKE} fix`)
    e.push('handoff/msg')
    e.git(e.owner, 'fetch', '-q', 'origin')
    const wt = join(e.root, 'wt')
    e.git(e.owner, 'worktree', 'add', '-q', '--detach', wt)
    mkdirSync(join(wt, 'scripts'), { recursive: true })
    for (const f of ['check-no-personal.sh', 'denylist.generic.txt', 'check-ref-personal.sh']) {
      copyFileSync(join(here, f), join(wt, 'scripts', f))
    }
    expect(existsSync(join(wt, 'scripts', 'personal-denylist.txt'))).toBe(false)
    const r = checkRef(e, ['origin/handoff/msg'], {}, wt)
    expect(r.code, r.err).toBe(1)
    expect(r.out).toBe(`${s12(sha)} .commit-message.${s12(sha)}:1 ${RULE}\n`)
  })

  it('exits 2 on a ref that does not exist, and on a broken rule file, never 0', () => {
    const e = setup()
    expect(checkRef(e, ['origin/nope']).code).toBe(2)
    const bad = join(e.root, 'bad.txt')
    writeFileSync(bad, '.\t-\t(unclosed\n')
    e.commit({ 'x.md': 'x\n' })
    e.push()
    expect(checkRef(e, ['origin/main'], { CHECK_EXTRA_RULES: bad }).code).toBe(2)
    tmpEmpty(e)
  })

  // R1-1: every commit a push brings in, not only the tree at its tip
  it('finds a value added and removed again inside one push, and inside a branch merged with --no-ff', () => {
    const e = setup()
    e.git(e.dev, 'checkout', '-q', '-b', 'handoff/gone')
    const add = e.commit({ 'notes.md': `a\n${FAKE}\n` })
    e.commit({}, 'take it out', ['notes.md'])
    e.push('handoff/gone')
    const r = checkRef(e, ['origin/handoff/gone'])
    expect(r.code, r.err).toBe(1)
    expect(r.out).toBe(`${s12(add)} notes.md:2 ${RULE}\n`)

    e.git(e.dev, 'checkout', '-q', 'main')
    e.git(e.dev, 'merge', '-q', '--no-ff', '-m', 'merge it', 'handoff/gone')
    const merge = e.git(e.dev, 'rev-parse', 'HEAD')
    e.push()
    // a merge commit on main: its parent is the base, so the merged commits come in with it
    const m = checkRef(e, [merge])
    expect(m.code).toBe(1)
    expect(m.out).toBe(`${s12(add)} notes.md:2 ${RULE}\n`)
  })

  // R1-4: everything a push carries
  it('checks node_modules, lockfiles, PDFs, binaries and UTF-16 text, names a private list file, and notes a submodule', () => {
    const e = setup()
    const v = Buffer.from(FAKE)
    const files: Record<string, string | Buffer> = {
      'node_modules/pkg/index.js': `module.exports = '${FAKE}'\n`,
      'pnpm-lock.yaml': `lockfileVersion: 9\n# ${FAKE}\n`,
      'docs/a.pdf': `%PDF-1.4\n${FAKE}\n`,
      'assets/blob.bin': Buffer.concat([Buffer.from([0, 1, 2, 0, 10]), v, Buffer.from([0, 0])]),
      'docs/wide.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`one\n${FAKE}\n`, 'utf16le')]),
      'scripts/personal-denylist.txt': '# nothing in it\n',
      // an image whose bytes happen to look like an email: the generic list skips images, the private list does not
      'assets/pic.png': Buffer.concat([
        Buffer.from([0x89, 0x50, 0, 10]),
        Buffer.from(['jo.smith', '@', 'gmail.com'].join('')),
        Buffer.from([10, 0, 10]),
        v,
        Buffer.from([0]),
      ]),
      // the generic list itself, committed: it is not run over its own file (it would match itself)
      'scripts/denylist.generic.txt': readFileSync(join(here, 'denylist.generic.txt')),
    }
    const sha = e.commit(files)
    const start = e.git(e.dev, 'rev-parse', 'HEAD~1')
    e.git(e.dev, 'update-index', '--add', '--cacheinfo', `160000,${start},vendor/sub`)
    e.git(e.dev, 'commit', '-q', '-m', 'add a submodule entry')
    const sub = e.git(e.dev, 'rev-parse', 'HEAD')
    e.push()
    const r = checkRef(e, [sub, start])
    expect(r.code, r.err).toBe(1)
    const lines = r.out.trim().split('\n').sort()
    expect(lines).toEqual(
      [
        `${s12(sha)} node_modules/pkg/index.js:1 ${RULE}`,
        `${s12(sha)} pnpm-lock.yaml:2 ${RULE}`,
        `${s12(sha)} docs/a.pdf:2 ${RULE}`,
        `${s12(sha)} assets/blob.bin:2 ${RULE}`,
        `${s12(sha)} assets/pic.png:4 ${RULE}`,
        `${s12(sha)} docs/wide.txt:2 ${RULE}`,
        `${s12(sha)} scripts/personal-denylist.txt:1 [private list file]`,
        `note: ${s12(sub)} vendor/sub submodule entry, its contents are not checked`,
      ].sort(),
    )
    noValue(r.out + r.err)
    tmpEmpty(e)
  })

  // R1-2: the causes of an exit 2 that used to pin the watch
  it('reads a link as its text and never follows it, and checks a file whose name is not UTF-8', () => {
    const e = setup()
    symlinkSync('/opt/elsewhere/file', join(e.dev, 'abs-link'))
    symlinkSync(`../${FAKE}/nowhere`, join(e.dev, 'dangling'))
    const links = e.commit({}, 'links')
    // a name with a byte that is not UTF-8 cannot be made on this disk, so the tree is built by hand
    const blob = e.gitIn(e.dev, `x\n${FAKE}\n`, 'hash-object', '-w', '--stdin')
    const base = e.gitIn(e.dev, '', 'ls-tree', 'HEAD')
    const tree = e.gitIn(
      e.dev,
      Buffer.concat([Buffer.from(`${base}\n100644 blob ${blob}\tbad`), Buffer.from([0xff]), Buffer.from('name.txt\n')]),
      'mktree',
    )
    const odd = e.gitIn(e.dev, 'odd name', 'commit-tree', tree, '-p', 'HEAD')
    e.git(e.dev, 'update-ref', 'refs/heads/main', odd)
    e.push()
    const r = checkRef(e, [odd, `${links}~1`])
    expect(r.code, r.err).toBe(1)
    expect(r.out.trim().split('\n').sort()).toEqual(
      [
        `${s12(links)} abs-link:1 [symlink: its target leaves the repository]`,
        `${s12(links)} dangling:1 [symlink: its target leaves the repository]`,
        `${s12(links)} dangling:1 ${RULE}`,
        `${s12(odd)} bad%FFname.txt:2 ${RULE}`,
      ].sort(),
    )
    tmpEmpty(e)
  })

  // R1-5: a path that is itself personal data is never printed
  it('checks each changed path as text and hides a path that hits', () => {
    const e = setup()
    const sha = e.commit({ 'docs/quillmoor-ventures/notes.md': `x\n${FAKE}\n` })
    e.push()
    const r = checkRef(e, [sha])
    expect(r.code, r.err).toBe(1)
    expect(r.out.trim().split('\n').sort()).toEqual(
      [
        `${s12(sha)} <path hidden #1>@${s12(sha)}:name ${RULE}`,
        `${s12(sha)} <path hidden #1>@${s12(sha)}:2 ${RULE}`,
      ].sort(),
    )
    noValue(r.out + r.err)
  })

  it('--tree checks every file and path of a tree once', () => {
    const e = setup()
    e.commit({ 'old/deep.md': `${FAKE}\n` })
    e.commit({ 'later.md': 'clean\n' })
    e.push()
    const r = checkRef(e, ['--tree', 'origin/main'])
    expect(r.code, r.err).toBe(1)
    expect(r.out).toBe(`${s12(e.git(e.dev, 'rev-parse', 'HEAD'))} old/deep.md:1 ${RULE}\n`)
    e.commit({}, 'clean up', ['old/deep.md'])
    e.push()
    const clean = checkRef(e, ['--tree', 'origin/main'])
    expect(clean.out).toBe('')
    expect(clean.code).toBe(0)
  })

  it("checks an annotated tag's message and a ref name when asked", () => {
    const e = setup()
    e.git(e.dev, 'tag', '-a', 'v1', '-m', `release for ${FAKE}`)
    e.git(e.dev, 'push', '-q', 'origin', 'v1')
    const tag = e.git(e.dev, 'rev-parse', 'v1')
    const r = checkRef(e, ['v1'], { CHECK_TAG_OBJECT: tag, CHECK_REF_NAME: 'quillmoor-ventures' })
    expect(r.code, r.err).toBe(1)
    expect(r.out.trim().split('\n').sort()).toEqual(
      [`${s12(tag)} .tag-message.${s12(tag)}:1 ${RULE}`, `${s12(tag)} .ref-name:1 ${RULE}`].sort(),
    )
  })
  // R2-1: a name with a colon or a tab is printed whole, and hidden whole when it hits
  it('hides a hitting name that holds a colon, a tab or a newline on its content hit too, and prints other odd names whole', () => {
    const e = setup()
    const sha = e.commit({
      [`docs/notes ${FAKE} 10:30.md`]: `x\n${FAKE}\n`,
      [`docs/a\t${FAKE}.md`]: `${FAKE}\n`,
      'docs/plain 10:30.md': `a\nb\n${FAKE}\n`,
      [`docs/n\n${FAKE}.md`]: `${FAKE}\n`,
    })
    e.push()
    const r = checkRef(e, [sha])
    expect(r.code).toBe(1)
    const lines = r.out.trim().split('\n')
    noValue(r.out + r.err)
    // each hidden name: one hit on the name and one on its content, never the name itself
    const hidden = lines.filter((l) => l.includes('<path hidden #'))
    expect(hidden.length).toBe(6)
    expect(hidden.filter((l) => l.includes(`@${s12(sha)}:name `)).length).toBe(3)
    expect(lines).toContain(`${s12(sha)} docs/plain 10%3A30.md:3 ${RULE}`)
    expect(lines.length).toBe(7)
    expect(r.out).not.toContain('\t')
  })

  // who made a commit or tag is not checked (the owner's ruling): a listed value as author, committer or tagger, or an ordinary
  // email there (the generic shape), is no hit
  it('does not check the author, the committer or a tagger', () => {
    const e = setup()
    const mail = ['dana.lee', '@', 'acme-widgets.io'].join('') // assembled, so this file holds no address
    const git = (env: Record<string, string>, ...args: string[]) =>
      execFileSync('git', args, { cwd: e.dev, env: { ...e.env, ...env }, encoding: 'utf8' }).trim()
    const before = git({}, 'rev-parse', 'HEAD')
    writeFileSync(join(e.dev, 'p.md'), 'p\n')
    git({}, 'add', 'p.md')
    git({ GIT_AUTHOR_NAME: FAKE, GIT_AUTHOR_EMAIL: mail }, 'commit', '-q', '-m', 'one')
    writeFileSync(join(e.dev, 'q.md'), 'q\n')
    git({}, 'add', 'q.md')
    git(
      { GIT_COMMITTER_NAME: FAKE, GIT_COMMITTER_EMAIL: 'quillmoor-ventures@example.com' },
      'commit',
      '-q',
      '-m',
      'two',
    )
    const head = git({}, 'rev-parse', 'HEAD')
    git({ GIT_COMMITTER_NAME: FAKE, GIT_COMMITTER_EMAIL: mail }, 'tag', '-a', 'rel', '-m', 'release')
    e.push()
    e.git(e.dev, 'push', '-q', 'origin', 'rel')
    const r = checkRef(e, [head, before])
    expect(r.out).toBe('')
    expect(r.code, r.err).toBe(0)
    const t = checkRef(e, ['rel', 'rel'], { CHECK_TAG_OBJECT: e.git(e.dev, 'rev-parse', 'rel') })
    expect(t.out).toBe('')
    expect(t.code, t.err).toBe(0)
  })

  // R2-3: a hand-made tree with a ".." entry must not be written outside the export, and must not pass
  it('refuses a tree with a ".." path: a note and exit 2, never clean', () => {
    const e = setup()
    const blob = e.gitIn(e.dev, `${FAKE}\n`, 'hash-object', '-w', '--stdin')
    const tree = e.gitIn(e.dev, `100644 blob ${blob}\t..\n`, 'mktree')
    const odd = e.gitIn(e.dev, 'odd', 'commit-tree', tree, '-p', 'HEAD')
    e.git(e.dev, 'push', '-q', 'origin', `${odd}:refs/heads/handoff/odd`)
    const r = checkRef(e, ['origin/handoff/odd'])
    expect(r.code).toBe(2)
    expect(r.out).toBe(
      `note: ${s12(odd)} a path that is absolute or has an empty, "." or ".." part: the commit is refused, nothing in it is known clean\n`,
    )
    tmpEmpty(e)
    const tt = checkRef(e, ['--tree', 'origin/handoff/odd'])
    expect(tt.code).toBe(2)
  })

  // R2-4: UTF-16 that does not decode is still read, and says so
  it('notes UTF-16 text that does not decode and still checks its raw bytes', () => {
    const e = setup()
    const sha = e.commit({
      'bad16.txt': Buffer.concat([
        Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00, 0x0a, 0x00]),
        Buffer.from(`\n${FAKE}\n`),
      ]),
    })
    e.push()
    const r = checkRef(e, [sha])
    expect(r.code).toBe(1)
    expect(r.out).toContain(`note: ${s12(sha)} bad16.txt UTF-16 text that does not decode, checked as raw bytes only`)
    expect(r.out).toContain(`${s12(sha)} bad16.txt:`)
  })

  // R3-1: under a UTF-8 locale a byte that is not UTF-8 must not hide a line from the scan
  it('under LANG=en_US.UTF-8, hides a Latin-1 name holding a value and finds a Latin-1 content line', () => {
    const e = setup()
    const utf8 = { LANG: 'en_US.UTF-8', LC_ALL: '', LC_CTYPE: '' }
    const content = e.gitIn(e.dev, Buffer.from(`x\n${FAKE}\n`), 'hash-object', '-w', '--stdin')
    const latin = e.gitIn(e.dev, Buffer.from(`one\ncafé ${FAKE}\n`, 'latin1'), 'hash-object', '-w', '--stdin')
    const base = e.gitIn(e.dev, '', 'ls-tree', 'HEAD')
    const tree = e.gitIn(
      e.dev,
      Buffer.concat([
        Buffer.from(`${base}\n100644 blob ${content}\tcaf`),
        Buffer.from([0xe9]),
        Buffer.from(` ${FAKE}.md\n100644 blob ${latin}\tlatin.txt\n`),
      ]),
      'mktree',
    )
    const sha = e.gitIn(e.dev, 'latin', 'commit-tree', tree, '-p', 'HEAD')
    e.git(e.dev, 'push', '-q', 'origin', `${sha}:refs/heads/handoff/latin`)
    const r = checkRef(e, ['origin/handoff/latin'], utf8)
    expect(r.code, r.err).toBe(1)
    expect(r.out.trim().split('\n').sort()).toEqual(
      [
        `${s12(sha)} <path hidden #1>@${s12(sha)}:name ${RULE}`,
        `${s12(sha)} <path hidden #1>@${s12(sha)}:2 ${RULE}`,
        `${s12(sha)} latin.txt:2 ${RULE}`,
      ].sort(),
    )
    noValue(r.out + r.err)
  })

  // R3-2: escaping must not push a legal name past what the disk allows, and lose the other commits' hits
  it('checks a 213-byte name that escaping makes longer than 255 bytes, and still reports a leak in another commit', () => {
    const e = setup()
    const long = `${'%20'.repeat(70)}.md`
    expect(Buffer.byteLength(long)).toBe(213)
    const a = e.commit({ [long]: `${FAKE}\n` })
    const b = e.commit({ 'leak.md': `x\n${FAKE}\n` })
    e.push()
    const r = checkRef(e, [b, `${a}~1`])
    expect(r.code, r.err).toBe(1)
    expect(r.out.trim().split('\n').sort()).toEqual(
      [`${s12(a)} ${'%2520'.repeat(70)}.md:1 ${RULE}`, `${s12(b)} leak.md:2 ${RULE}`].sort(),
    )
    tmpEmpty(e)
  })
})
