import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'check-no-personal.sh')
const generic = join(here, 'denylist.generic.txt')

function run(
  files: Record<string, string | Buffer>,
  privateRules?: string | Buffer,
  links: Record<string, string> = {},
  env?: Record<string, string | undefined>,
) {
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
  for (const [p, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    symlinkSync(target, join(root, p))
  }
  const r = spawnSync('bash', [join(scripts, 'check-no-personal.sh'), root], {
    encoding: 'utf8',
    env: env ?? process.env,
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}`, root }
}

describe('check-no-personal.sh', () => {
  it('Railway named generically, or by the made-up example hosts, passes', () => {
    const r = run({
      'docs/deploy.md':
        'Use the generated `*.up.railway.app` address, `https://<service>.up.railway.app`; up.railway.app is a public suffix.\n',
      'README.md': 'e.g. https://my-relay.up.railway.app or https://your-relay.up.railway.app\n',
    })
    expect(r.out).toContain('ok')
    expect(r.code).toBe(0)
  })

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
    [
      'a real-looking Railway relay host',
      'apps/windows/tests/x.ps1',
      `'https://${j('relay-production-', 'abcd1234')}.up.${j('railway', '.app')}'\n`,
    ],
    [
      'a Railway relay host in a doc',
      'docs/x.md',
      `open https://${j('talos-', 'fern')}.up.${j('railway', '.app')} in Safari\n`,
    ],
    [
      'a Railway host with regex-escaped dots',
      'apps/relay/test/x.ts',
      `/${j('talos-', 'fern')}\\.up\\.${j('railway', '\\.app')}/\n`,
    ],
    ['a Railway host with encoded dots', 'docs/x.md', `?u=${j('talos-', 'fern')}%2Eup%2E${j('railway', '%2Eapp')}\n`],
    [
      'a Railway host with doubled backslashes',
      'apps/x/a.json',
      `"${j('zed-', 'fern')}\\\\.up\\\\.${j('railway', '\\\\.app')}"\n`,
    ],
    ['a Railway host with bracketed dots', 'docs/x.md', `${j('zed-', 'fern')}[.]up[.]${j('railway', '[.]app')}\n`],
    [
      'a Railway host ending in an example name',
      'docs/x.md',
      `https://${j('X', 'relay')}.up.${j('railway', '.app')}\n`,
    ],
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

  // THIRD_PARTY_NOTICES.md keeps upstream licence texts verbatim; two upstream copyright lines carry their author's address.
  // Only those exact addresses, only in that file, pass. Built at run time so this file holds nothing the scan would flag.
  it("lets the two upstream authors' addresses through in THIRD_PARTY_NOTICES.md and nothing else", () => {
    const clsx = j('luke.edwards05', '@', 'gmail.com')
    const idb = j('jaffathecake', '@', 'gmail.com')
    const ok = run({ 'THIRD_PARTY_NOTICES.md': `Copyright (c) Luke <${clsx}>\nCopyright (c) 2016, Jake <${idb}>\n` })
    expect(ok.code).toBe(0)
    const other = run({
      'THIRD_PARTY_NOTICES.md': `Copyright (c) Luke <${clsx}>\nmail ${j('jo.smith', '@', 'gmail.com')}\n`,
    })
    expect(other.code).toBe(1)
    expect(other.out).toContain('THIRD_PARTY_NOTICES.md:2')
    expect(other.out).not.toContain('THIRD_PARTY_NOTICES.md:1\n')
    const elsewhere = run({ 'docs/a.md': `by ${clsx}\n` })
    expect(elsewhere.code).toBe(1)
    expect(elsewhere.out).toContain('docs/a.md')
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

  it('lets tests use the allowlisted zones, edge cases included', () => {
    const zones = [
      'Etc/UTC',
      'Etc/GMT',
      'Etc/GMT+5',
      'America/New_York',
      'Europe/Paris',
      'Asia/Kolkata',
      'Pacific/Kiritimati',
    ]
    const r = run({
      'packages/protocol/test/q.test.ts': zones.map((z) => `isQuiet(d, qw, '${z}')`).join('\n') + '\n',
      'apps/desktop/TalosTests/QuietTests.swift': 'let tz = TimeZone(identifier: "Etc/GMT+5")!\n',
    })
    expect(r.out).toContain('ok')
    expect(r.code).toBe(0)
  })

  // A zone not on the list, in each kind of test path. Assembled at run time, like the samples above.
  it.each([
    ['a test folder', 'apps/relay/test/push/q.ts', j('Australia', '/Perth')],
    ['a *.test.* file', 'apps/web/src/lib/zone.test.ts', j('America', '/Bogota')],
    ['a *.spec.* file', 'apps/web/e2e/quiet.spec.ts', j('America', '/Lima')],
    ['a Swift tests folder', 'apps/desktop/TalosTests/QuietTests.swift', j('Etc', '/GMT+3')],
    ['an Etc zone that only begins like an allowed one', 'apps/bridge/test/q.test.ts', j('Etc', '/GMT+50')],
    ['a contract test folder', 'apps/bridge/test-contract/q.contract.vitest.ts', j('Australia', '/Perth')],
    ['the e2e harness', 'e2e/harness/clock.ts', j('Australia', '/Perth')],
    ['the testkit', 'packages/testkit/src/clock.ts', j('Australia', '/Perth')],
    ['review fixtures', 'packages/testkit/review-fixtures/a.json', j('Australia', '/Perth')],
    ['a Python test', 'tools/test_quiet.py', j('Australia', '/Perth')],
    ['a legacy US link', 'apps/relay/test/q.ts', j('US', '/Hawaii')],
    ['a legacy Canada link', 'apps/relay/test/q.ts', j('Canada', '/Atlantic')],
    ['a legacy Mexico link', 'apps/relay/test/q.ts', j('Mexico', '/General')],
    ['a POSIX rule with daylight', 'apps/relay/test/q.ts', j('ACS', 'T-9:30', 'ACD', 'T')],
    ['a lowercase zone', 'apps/relay/test/q.ts', j('australia', '/perth')],
    ['a zone nested to end like an allowed one', 'apps/relay/test/q.ts', j('Asia', '/Europe/Paris')],
    ['a shell test named test-*', 'kit/scripts/test-x.sh', j('Australia', '/Perth')],
    ['a shell test named *-test', 'apps/desktop/scripts/clock-test.sh', j('Australia', '/Perth')],
    ['an e2e script', 'scripts/e2e-clock.sh', j('Australia', '/Perth')],
    ['a folder test-foo-bar', 'apps/relay/test-foo-bar/q.ts', j('Australia', '/Perth')],
    ['a folder test_helpers', 'apps/relay/test_helpers/q.ts', j('Australia', '/Perth')],
    ['a mocks folder', 'apps/web/src/__mocks__/clock.ts', j('Australia', '/Perth')],
    ['a snapshot', 'apps/web/src/x.test.ts.snap', j('Australia', '/Perth')],
    ['a Python *_test.py', 'tools/clock_test.py', j('Australia', '/Perth')],
    ['a conftest.py', 'tools/conftest.py', j('Australia', '/Perth')],
    ['a fixtures folder', 'apps/relay/fixtures/a.json', j('australia', '/perth')],
    ['a zoneinfo path', 'apps/relay/test/q.ts', j('/usr/share/zoneinfo/', 'Australia', '/Perth')],
    ['a posix/ zoneinfo path', 'apps/relay/test/q.ts', j('posix/', 'Australia', '/Perth')],
    ['upper case', 'apps/relay/test/q.ts', j('AUSTRALIA', '/PERTH')],
    ['a lowercase legacy link', 'apps/relay/test/q.ts', j('us', '/hawaii')],
    ['a lowercase Etc offset', 'apps/relay/test/q.ts', j('etc', '/gmt+3')],
    ['a JSON-escaped slash', 'apps/relay/test/q.json', j('Australia', '\\/Perth')],
    ['a Playwright config', 'apps/web/playwright.config.ts', j('Australia', '/Perth')],
    ['a POSIX rule with an offset', 'apps/relay/test/q.ts', j('AWS', 'T-8')],
    ['a standard-time abbreviation as a tz value', 'apps/relay/test/q.ts', j('SAS', 'T')],
    ['a daylight abbreviation as a tz value', 'apps/relay/test/q.ts', j('ACD', 'T')],
  ])('flags a zone not on the list in %s, naming the place and never the zone', (_name, file, zone) => {
    const r = run({ [file]: `const tz = '${zone}'\n` })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`${file}:1`)
    expect(r.out).not.toContain(zone)
  })

  // Zone abbreviations, by shape and only where a zone stands. Samples are from the far side of the world, made at run time.
  const awst = j('AWS', 'T')
  const acdt = j('ACD', 'T')
  const sast = j('SAS', 'T')
  it.each([
    ['after a clock time', `meet at 22:00 ${awst} sharp`],
    ['after an hour with am/pm', `starts 9am ${acdt}`],
    ['in parentheses after a time', `10:30 (${sast})`],
    ['a JS/TS object value', `{ timeZone: '${awst}' }`],
    ['a JSON value', `{ "timezone": "${acdt}" }`],
    ['a Swift label', `TimeZone(abbreviation: "${sast}")`],
    ['a Python keyword argument', `fmt(tz="${awst}")`],
    ['a snake_case key', `time_zone = '${acdt}'`],
    ['a shell variable', `TZ=${sast}-2 date`],
    ['a function call', `zone('${awst}')`],
    ['a POSIX rule as a TZ value', `TZ='${j('ACS', 'T-9:30', 'ACD', 'T')}' run`],
    ['a value with spaces lined up', `timezone:   "${j('HK', 'T')}"`],
    ['a backtick-quoted value', 'zone: `' + j('SG', 'T') + '`'],
    ['ZoneId.of', `ZoneId.of("${j('HK', 'T')}")`],
    ['a neutral abbreviation with an offset of its own', `TZ=${j('GM', 'T+9')}`],
    ['a UTC rule with an offset', `TZ=${j('UT', 'C+9')}`],
    ['vi.stubEnv', `vi.stubEnv('TZ', '${awst}')`],
    ['setenv', `setenv("TZ", "${acdt}", 1)`],
    ['escaped JSON', `"{\\"timeZone\\":\\"${sast}\\"}"`],
    ['a TZ value with a leading colon', `TZ=":${awst}"`],
    ['a comparison', `if (tz === '${acdt}') {}`],
    ['a command-line flag', `run --tz ${sast}`],
    ['a tab after the colon', `timeZone:\t'${awst}'`],
    ['Intl output with a narrow space', `10:30\u202fPM ${acdt}`],
    ['a compound camelCase key', `const userTimeZone = '${awst}'`],
    ['a compound snake_case key', `owner_tz: "${acdt}"`],
    ['an upper-case constant', `DEFAULT_TZ = '${sast}'`],
    ['an assertion on a tz value', `expect(tz).toBe('${awst}')`],
    ['a Swift TimeZone(identifier:)', `TimeZone(identifier: "${acdt}")`],
    ['a Swift abbreviation() comparison', `tz.abbreviation() == "${sast}"`],
    ['a Python ZoneInfo', `ZoneInfo("${awst}")`],
    ['a timezoneId option', `{ timezoneId: '${acdt}' }`],
    ['a clock time with fractions of a second', `10:30:00.123 ${sast}`],
  ])('flags a zone abbreviation %s, naming the place and never the value', (_name, line) => {
    const file = 'apps/relay/test/clock.test.ts'
    const r = run({ [file]: `${line}\n` })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`${file}:1`)
    for (const v of [awst, acdt, sast, j('HK', 'T'), j('SG', 'T')]) expect(r.out).not.toContain(v)
  })

  it("lets through the listed zones' abbreviations, plain words in the same shapes, and a bare quoted word (the stated limit)", () => {
    const r = run({
      'apps/relay/test/clock.test.ts': [
        'meet at 22:00 EST, 9am EDT, 10:30 (BST), 7:00 JST, 12:20 EDT: done',
        "{ timeZone: 'UTC' } { tz: 'GMT' } TZ=EST5EDT TZ=CST6CDT TZ=CET-1CEST TZ='IST-5:30' zone: 'NZST-12NZDT'",
        'const NAT64 = 1; $SET0 ROT2 NET-3 CHAT-77 // shapes with no zone context',
        "const dropZone = 'LEFT'; quartz = 'FAST'; tz: TEST_TZ; at 09:00 UTC-5",
        'expect(method).toBe("POST") // (TRUST) (POST) (DIST): words, not zones',
        "const words = ['POST', 'LIST', 'TEST', 'RESULT', 'DEFAULT', 'FIRST']",
        "load('/usr/share/zoneinfo/Etc/GMT+5')",
      ].join('\n'),
    })
    expect(r.out).toContain('ok')
    expect(r.code).toBe(0)
  })

  it('lets an allowed zone through in any form a test writes it, and the abbreviations of allowed zones', () => {
    const r = run({
      'apps/relay/test/q.json': '{"tz":"America\\/New_York"}\n',
      'apps/relay/test/q.ts':
        "// 22:00 EST is 03:00Z; CST6CDT and EST5EDT are the listed US pair\nload('/usr/share/zoneinfo/Europe/Berlin')\n",
    })
    expect(r.out).toContain('ok')
    expect(r.code).toBe(0)
  })

  it('does not read a test into a source name that merely contains one (latest, contest)', () => {
    expect(run({ 'apps/web/src/lib/latest.ts': `export const Z = '${j('Australia', '/Perth')}'\n` }).code).toBe(0)
  })

  it('does not take a system path in a test for a zone', () => {
    expect(run({ 'apps/bridge/test/fs.test.ts': "readFileSync('/etc/hosts')\nconst p = 'etc/hosts'\n" }).code).toBe(0)
  })

  it('does not apply the test-zone list to app source (the zone a person picks is data there)', () => {
    expect(run({ 'apps/web/src/lib/zones.ts': `export const Z = ['${j('Australia', '/Perth')}']\n` }).code).toBe(0)
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

  // a dependency link into one machine's home folder (what a worktree's borrowed node_modules looks like), built at run time
  const machinePath = ['', 'home', 'example', 'Talos', 'app', 'node_modules'].join('/')
  it('flags a link whose target is an absolute path, naming the link and never the target', () => {
    const r = run({ 'a.md': 'fine\n' }, undefined, { 'apps/x/node_modules': machinePath })
    expect(r.code).toBe(1)
    expect(r.out).toContain('[symlink] apps/x/node_modules: its target is an absolute path')
    expect(r.out).not.toContain(machinePath)
  })
  it('flags a relative link that leads out of the repository, and passes one that stays inside', () => {
    const out = run({ 'a.md': 'fine\n' }, undefined, { 'a/b/link': '../../../elsewhere' })
    expect(out.code).toBe(1)
    expect(out.out).toContain('[symlink] a/b/link: its target leads out of the repository')
    const inside = run({ 'a.md': 'fine\n', 'b/file.md': 'fine\n' }, undefined, {
      'a/link': '../b/file.md',
      'c/d/up': '../..',
    })
    expect(inside.out).toContain('ok')
    expect(inside.code).toBe(0)
  })
  it('flags a tracked link in a git checkout (the link git stores is its target text)', () => {
    const root = mkdtempSync(join(tmpdir(), 'cnp-gitlink-'))
    execFileSync('git', ['init', '-q'], { cwd: root })
    mkdirSync(join(root, 'scripts'))
    mkdirSync(join(root, 'apps', 'bridge'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'denylist.generic.txt'), readFileSync(generic))
    writeFileSync(join(root, 'scripts', 'check-no-personal.sh'), readFileSync(script))
    symlinkSync(machinePath, join(root, 'apps', 'bridge', 'node_modules'))
    execFileSync('git', ['add', 'apps/bridge/node_modules'], { cwd: root })
    const r = spawnSync('bash', [join(root, 'scripts', 'check-no-personal.sh')], { cwd: root, encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(`${r.stdout}${r.stderr}`).toContain('[symlink] apps/bridge/node_modules')
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

  // Bytes, not characters: under a UTF-8 locale grep passes over a line holding a byte that is not UTF-8, so a Latin-1 line with
  // a value used to read as clean. The scan now matches bytes in the C locale for every caller, and rewrites each rule into bytes
  // (non-ASCII letters folded as byte alternations, "." as one whole character), so the result is the same in every locale.
  // The values here are made up.
  describe.each(['C', 'en_US.UTF-8'])('under LANG=%s', (lang) => {
    const envFor = () => {
      const env: Record<string, string | undefined> = { ...process.env, LANG: lang }
      delete env.LC_ALL
      delete env.LC_CTYPE
      return env
    }
    const rules = '.\ti\tquillmoor[ -]ventures\n.\ti\tzoë ventures\n.\ti\tzo. bridges\n.\t-\tnorth[^ ]wind\n'
    const latin1 = (text: string) => Buffer.from(text, 'latin1')
    const scan = (files: Record<string, string | Buffer>, r = rules) => run(files, r, {}, envFor())

    it('finds a value on a Latin-1 content line', () => {
      const r = scan({ 'docs/a.md': latin1('one\ncafé Quillmoor Ventures\n') })
      expect(r.code).toBe(1)
      expect(r.out).toContain('[personal-denylist.txt rule line 1] docs/a.md:2')
      expect(r.out.toLowerCase()).not.toContain('quillmoor')
    })

    it('folds a non-ASCII letter of an "i" rule', () => {
      const r = scan({ 'docs/b.md': 'x\nZOË VENTURES\n' })
      expect(r.code).toBe(1)
      expect(r.out).toContain('[personal-denylist.txt rule line 2] docs/b.md:2')
    })

    // R4-1: a line that mixes encodings (a Latin-1 byte, then the value in UTF-8 with other case)
    it('folds it on a line that mixes Latin-1 and UTF-8', () => {
      const r = scan({ 'docs/m.md': Buffer.concat([latin1('a\ncafé '), Buffer.from('ZOË VENTURES\n')]) })
      expect(r.code).toBe(1)
      expect(r.out).toContain('[personal-denylist.txt rule line 2] docs/m.md:2')
    })

    // R4-2: "." and a negated set take a whole non-ASCII character
    it('lets "." and a negated set match one whole non-ASCII character', () => {
      const r = scan({ 'docs/d.md': 'x\nzoë bridges\nZOË BRIDGES\n', 'docs/n.md': 'northéwind\n' })
      expect(r.code).toBe(1)
      expect(r.out).toContain('[personal-denylist.txt rule line 3] docs/d.md:2')
      expect(r.out).toContain('[personal-denylist.txt rule line 3] docs/d.md:3')
      expect(r.out).toContain('[personal-denylist.txt rule line 4] docs/n.md:1')
    })

    it('refuses a rule with a non-ASCII bracket set, naming its line and never passing', () => {
      const r = scan({ 'docs/e.md': 'zoë x\n' }, '# a comment\n.\t-\tzo[ëé] x\n')
      expect(r.code).toBe(2)
      expect(r.out).toContain('personal-denylist.txt line 2 has a bracket set with non-ASCII letters')
      expect(r.out).not.toContain('zo[')
    })

    // Fail-closed hardening: rules the byte rewrite can't hold faithfully are refused, never run half-right
    it('refuses a rule that is not valid UTF-8, naming its line', () => {
      const r = scan(
        { 'docs/f.md': 'x\n' },
        Buffer.concat([Buffer.from('# c\n.\ti\tcaf'), Buffer.from([0xe9]), Buffer.from(' x\n')]),
      )
      expect(r.code).toBe(2)
      expect(r.out).toContain('personal-denylist.txt line 2 is not valid UTF-8')
    })

    it('refuses a rule that mixes non-ASCII letters with \\b, naming its line', () => {
      const r = scan({ 'docs/g.md': 'zoë x\n' }, '.\ti\t\\bzoë x\n')
      expect(r.code).toBe(2)
      expect(r.out).toContain('personal-denylist.txt line 1 mixes non-ASCII letters')
      expect(r.out).toContain('not reliable byte-wise')
    })

    it('refuses a rule whose byte form comes out empty (a perl that prints nothing)', () => {
      const fake = mkdtempSync(join(tmpdir(), 'cnp-perl-'))
      writeFileSync(join(fake, 'perl'), '#!/bin/sh\ncat >/dev/null\nexit 0\n')
      chmodSync(join(fake, 'perl'), 0o755)
      const env = envFor()
      env.PATH = `${fake}:${env.PATH ?? '/usr/bin:/bin'}`
      const r = run({ 'docs/h.md': 'ZOË VENTURES\n' }, rules, {}, env)
      expect(r.code).toBe(2)
      // the first rule that needs a rewrite stops the scan (in the generic list, which runs first)
      expect(r.out).toMatch(
        /check-no-personal: [a-z.-]+\.txt line \d+: its byte form came out empty; nothing is known clean/,
      )
    })

    it("is not changed by the caller's PERL5OPT, PERL5LIB or PERL_UNICODE", () => {
      const lib = mkdtempSync(join(tmpdir(), 'cnp-lib-'))
      // a module that, if loaded, ends the rewrite before it prints anything
      writeFileSync(join(lib, 'Quiet.pm'), 'package Quiet; sub import { exit 0 } 1;\n')
      const env = { ...envFor(), PERL5OPT: '-MQuiet', PERL5LIB: lib, PERL_UNICODE: 'SDA' }
      const r = run({ 'docs/i.md': 'x\nZOË VENTURES\n' }, rules, {}, env)
      expect(r.code).toBe(1)
      expect(r.out).toContain('[personal-denylist.txt rule line 2] docs/i.md:2')
    })

    it('finds a value in a file whose name is Latin-1, where the disk allows such a name', () => {
      const r = scan({})
      const name = Buffer.concat([Buffer.from(join(r.root, 'docs', 'caf')), Buffer.from([0xe9]), Buffer.from('.md')])
      mkdirSync(join(r.root, 'docs'), { recursive: true })
      try {
        writeFileSync(name, latin1('café Quillmoor Ventures\n'))
      } catch (err) {
        // APFS refuses a name that is not UTF-8 (EILSEQ); check-ref-personal.test.ts covers such names from git on every disk
        expect((err as NodeJS.ErrnoException).code).toBe('EILSEQ')
        return
      }
      const again = spawnSync('bash', [join(r.root, 'scripts', 'check-no-personal.sh'), r.root], {
        encoding: 'utf8',
        env: envFor(),
      })
      expect(again.status).toBe(1)
      expect(again.stderr).toContain('[personal-denylist.txt rule line 1] docs/caf')
    })
  })
})
