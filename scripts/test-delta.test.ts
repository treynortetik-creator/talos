// scripts/test-delta.ts: how many test cases a change adds or removes against its base, counted from the diff, by kind. Information
// for the builder and the reviewer: it never fails and is no target (deleting a cheap test earns nothing).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { countDeclarations, deltaOf, kindOf, line, main, parseDiff } from './test-delta.ts'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('countDeclarations: one per test case written', () => {
  it('vitest and bun: it and test, with their modifiers, one per line', () => {
    const ts = [
      "it('a', () => {})",
      "  test('b', async () => {})",
      "it.skip('c', () => {})",
      "test.only('d', () => {})",
      "it.todo('e')",
      "it.each([1, 2])('f %s', (n) => {})",
      "test.skipIf(cond)('g', () => {})",
      "test.concurrent('h', () => {})",
      'it(\n',
      'it(`a template name`, () => {})',
    ]
    expect(countDeclarations('apps/bridge/test/a.test.ts', ts)).toBe(ts.length)
  })

  it('not a test case: describe, hooks, steps, a call inside a body, a name that only contains it', () => {
    expect(
      countDeclarations('apps/bridge/test/a.test.ts', [
        "describe('x', () => {})",
        'beforeEach(() => {})',
        "test.describe('x', () => {})",
        "test.step('x', async () => {})",
        'test.setTimeout(5000)',
        "test.skip(browserName === 'webkit', 'why')",
        "const run = test.skipIf(a)('x', () => {})",
        "submit('x')",
        "permit('x')",
        "// it('commented out', () => {})",
        "expect(it('x')).toBe(1)",
      ]),
    ).toBe(0)
  })

  it('Swift: @Test, and func test... of XCTest; a @Test func named test... is one', () => {
    const f = 'apps/desktop/Tests/TalosDesktopCoreTests/AThingTests.swift'
    expect(
      countDeclarations(f, ['@Test func a() {}', '  @Test("named") func b() {}', '@Test(.tags(.x))', 'func c() {}']),
    ).toBe(3)
    expect(
      countDeclarations(f, ['func testOne() {', '  func testTwo() async throws {', 'private func helper() {}']),
    ).toBe(2)
    expect(countDeclarations(f, ['@Test', 'func testSame() {}'])).toBe(1)
    expect(countDeclarations(f, ['@Test', 'func testSame() {}', 'func testNext() {}'])).toBe(2)
  })
})

describe('kindOf', () => {
  it('splits browser and e2e from unit and swift, and ignores what is not a test file', () => {
    expect(kindOf('e2e/tests/a.spec.ts')).toBe('e2e')
    expect(kindOf('apps/web/test/a.spec.ts')).toBe('e2e')
    expect(kindOf('apps/web/test-browser/a.test.tsx')).toBe('e2e')
    expect(kindOf('apps/bridge/test/a.test.ts')).toBe('unit')
    expect(kindOf('scripts/a.test.ts')).toBe('unit')
    expect(kindOf('apps/desktop/Tests/TalosDesktopCoreTests/AThingTests.swift')).toBe('swift')
    expect(kindOf('apps/web/src/a.ts')).toBeUndefined()
    expect(kindOf('apps/desktop/Sources/TalosDesktop/Menu.swift')).toBeUndefined()
    expect(kindOf('docs/a.md')).toBeUndefined()
  })
})

describe('parseDiff and deltaOf', () => {
  const DIFF = [
    'diff --git a/apps/bridge/test/a.test.ts b/apps/bridge/test/a.test.ts',
    '--- a/apps/bridge/test/a.test.ts',
    '+++ b/apps/bridge/test/a.test.ts',
    '@@ -3,2 +3,3 @@',
    "-it('gone', () => {})",
    "-it('also gone', () => {})",
    "+it('new', () => {})",
    "+it('new two', () => {})",
    "+it('new three', () => {})",
    'diff --git a/e2e/tests/n.spec.ts b/e2e/tests/n.spec.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/e2e/tests/n.spec.ts',
    '@@ -0,0 +1,2 @@',
    "+test('a', async () => {})",
    "+test('b', async () => {})",
    'diff --git a/apps/web/src/a.ts b/apps/web/src/a.ts',
    '--- a/apps/web/src/a.ts',
    '+++ b/apps/web/src/a.ts',
    '@@ -1 +1 @@',
    "-it('not a test file', () => {})",
    "+it('not a test file either', () => {})",
  ].join('\n')

  it('counts added and removed declarations per kind, and lists the new e2e files', () => {
    expect(deltaOf(parseDiff(DIFF))).toEqual({
      unit: { added: 3, removed: 2 },
      e2e: { added: 2, removed: 0 },
      swift: { added: 0, removed: 0 },
      newE2eFiles: ['e2e/tests/n.spec.ts'],
    })
  })

  it('a moved test (the line removed in one file, added in another) nets to zero', () => {
    const d = deltaOf(
      parseDiff(
        [
          '--- a/apps/bridge/test/a.test.ts',
          '+++ b/apps/bridge/test/a.test.ts',
          '@@ -1 +0,0 @@',
          "-it('x', () => {})",
          '--- a/apps/bridge/test/b.test.ts',
          '+++ b/apps/bridge/test/b.test.ts',
          '@@ -0,0 +1 @@',
          "+it('x', () => {})",
        ].join('\n'),
      ),
    )
    expect(d.unit).toEqual({ added: 1, removed: 1 })
  })

  it('prints one line: the net, the split, and the new browser files', () => {
    expect(line(deltaOf(parseDiff(DIFF)))).toBe(
      'test-delta: net +3 (added 5, removed 2): unit +3 -2, e2e +2 -0, swift +0 -0; new e2e files: e2e/tests/n.spec.ts (each costs CI seconds of module loading)',
    )
    expect(line(deltaOf(parseDiff('')))).toBe(
      'test-delta: net 0 (added 0, removed 0): unit +0 -0, e2e +0 -0, swift +0 -0',
    )
    expect(
      line({
        unit: { added: 1, removed: 4 },
        e2e: { added: 0, removed: 0 },
        swift: { added: 0, removed: 0 },
        newE2eFiles: [],
      }),
    ).toBe('test-delta: net -3 (added 1, removed 4): unit +1 -4, e2e +0 -0, swift +0 -0')
  })
})

describe('against a real repo', () => {
  const git = (root: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
  const put = (root: string, rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }

  it('main --base prints the delta of base...HEAD, and says nothing is wrong when the base is bad', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-delta-'))
    dirs.push(root)
    git(root, 'init', '-q', '-b', 'main')
    put(root, 'apps/bridge/test/a.test.ts', "it('one', () => {})\nit('two', () => {})\n")
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'base')
    const base = git(root, 'rev-parse', 'HEAD')
    put(root, 'apps/bridge/test/a.test.ts', "it('one', () => {})\n")
    put(root, 'e2e/tests/n.spec.ts', "test('n', async () => {})\n")
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'change')
    const out: string[] = []
    const log = console.log
    console.log = (s: string) => out.push(s)
    try {
      expect(main(['--base', base, '--root', root])).toBe(0)
      expect(main(['--base', 'no-such-ref', '--root', root])).toBe(0) // informational: never fails
    } finally {
      console.log = log
    }
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('net 0 (added 1, removed 1): unit +0 -1, e2e +1 -0')
    expect(out[0]).toContain('new e2e files: e2e/tests/n.spec.ts')
  })
})
