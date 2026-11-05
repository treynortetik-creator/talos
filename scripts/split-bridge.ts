// Proves that slimming apps/bridge/src/bridge.ts was a move and nothing else.
//
//   node scripts/split-bridge.ts --check [--base origin/main]
//
// Every top-level declaration and every class method of bridge.ts at the base ref must be found, with the same text, in
// bridge.ts or in one of the files below. Two kinds of change are allowed and nothing else:
//   - a Bridge method that became a function takes the context as its first parameter, so `this.ctx`, `this.clock` and
//     `this.log` read `ctx`, `ctx.clock` and `ctx.log`, and a `const { ctx } = this` line is gone. The check applies the same
//     rewrite to the original and compares the comments and the whole body;
//   - the call sites inside methods that stayed (CALL_SITES below) and nothing else in them;
//   - layout of functions and methods: compared with all white space removed, because a formatter re-wraps lines after a dedent.
//     Constants and types (the instruction text, BridgeOptions) are compared exactly, character for character.
// It also fails on a declaration that exists now and did not before, apart from the one-line INSTRUCTIONS alias in bridge.ts.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'apps', 'bridge', 'src')
const MAIN = 'bridge.ts'
const MOVED = ['instructions.ts', 'bridge-options.ts', 'outbox-drop.ts', 'bridge-housekeeping.ts']
/** Declarations that may exist now without existing at the base: the alias bridge.ts keeps for the size-budget test. */
const ALLOWED_NEW = new Set(['INSTRUCTIONS'])
/** The only edits inside methods that stayed in bridge.ts: a call to a moved method now calls the function with the context. */
const CALL_SITES: Array<[string, string]> = [
  ['this.tellAgentOfDrop(row)', 'tellAgentOfDrop(this.ctx,row)'],
  ['this.backfillCardRows()', 'backfillCardRows(this.ctx)'],
  ['this.tellOwnerHistoryKeptAside()', 'tellOwnerHistoryKeptAside(ctx)'],
]

const parse = (name: string, text: string) =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

type Piece = { comments: string; body: string; kind: 'decl' | 'func' }

function attachedStart(sf: ts.SourceFile, node: ts.Node): number {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.pos) ?? []
  let start = node.getStart(sf)
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i] as ts.CommentRange
    if (!/^[ \t]*\r?\n[ \t]*$/.test(sf.text.slice(r.end, start))) break
    start = r.pos
  }
  return start
}

const squash = (s: string) => s.replace(/\s+/g, '')
const unThis = (s: string) =>
  s
    .replace(/^\s*const \{ ctx \} = this\s*$/gm, '')
    .replace(/this\.ctx\b/g, 'ctx')
    .replace(/this\.clock\b/g, 'ctx.clock')
    .replace(/this\.log\b/g, 'ctx.log')

/** Top-level declarations and class methods by name. A method or function is compared by comments plus body. */
function collect(name: string, text: string, rewrite: boolean): Map<string, Piece> {
  const sf = parse(name, text)
  const out = new Map<string, Piece>()
  const fn = (node: ts.FunctionDeclaration | ts.MethodDeclaration, n: string) => {
    if (!node.body) return
    const start = attachedStart(sf, node)
    const comments = text.slice(start, node.getStart(sf))
    const body = node.body.getText(sf)
    out.set(n, {
      kind: 'func',
      comments: squash(comments),
      body: squash(rewrite ? unThis(body) : body),
    })
  }
  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st))
      for (const m of st.members) if (ts.isMethodDeclaration(m) && ts.isIdentifier(m.name)) fn(m, m.name.text)
    if (ts.isFunctionDeclaration(st) && st.name) fn(st, st.name.text)
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name))
          out.set(d.name.text, {
            kind: 'decl',
            comments: text.slice(attachedStart(sf, st), st.getStart(sf)),
            body: st.getText(sf).replace(/^export\s+/, ''),
          })
    if (ts.isTypeAliasDeclaration(st))
      out.set(st.name.text, {
        kind: 'decl',
        comments: text.slice(attachedStart(sf, st), st.getStart(sf)),
        body: st.getText(sf).replace(/^export\s+/, ''),
      })
  }
  return out
}

const git = (ref: string) =>
  execFileSync('git', ['show', `${ref}:apps/bridge/src/${MAIN}`], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 })

function check(base: string): number {
  const orig = collect(MAIN, git(base), true)
  const now = new Map<string, { file: string; p: Piece }>()
  let bad = 0
  for (const f of [MAIN, ...MOVED]) {
    // the alias line in bridge.ts is the one declaration that shares a name with the moved text

    // the original is rewritten as a function would read, the new file is read as it is
    for (const [n, p] of collect(f, readFileSync(join(srcDir, f), 'utf8'), false)) {
      if (f === MAIN && ALLOWED_NEW.has(n)) continue
      if (now.has(n)) {
        console.log(`DUPLICATE ${n}: ${now.get(n)?.file} and ${f}`)
        bad++
      }
      now.set(n, { file: f, p })
    }
  }
  // Methods that stayed in the class keep `this.ctx` in the new bridge.ts, so compare those against an unrewritten original.
  const origPlain = collect(MAIN, git(base), false)
  let same = 0
  let moved = 0
  for (const [n, o] of orig) {
    const cur = now.get(n)
    if (!cur) {
      console.log(`MISSING   ${n}`)
      bad++
      continue
    }
    const plain = origPlain.get(n) as Piece
    const want =
      cur.file === MAIN
        ? { ...plain, body: CALL_SITES.reduce((b, [a, z]) => b.replace(squash(a), squash(z)), plain.body) }
        : o
    if (want.comments === cur.p.comments && want.body === cur.p.body) {
      same++
      if (cur.file !== MAIN) moved++
    } else {
      console.log(`DIFFERS   ${n} (${cur.file})`)
      bad++
    }
  }
  for (const [n, c] of now)
    if (!orig.has(n) && !ALLOWED_NEW.has(n)) {
      console.log(`NEW       ${n} (${c.file})`)
      bad++
    }
  console.log(`compared with ${base}:apps/bridge/src/${MAIN}`)
  console.log(`${orig.size} declarations in the original; ${same} identical (${moved} of them moved to another file)`)
  return bad ? 1 : 0
}

const args = process.argv.slice(2)
if (!args.includes('--check')) {
  console.log('usage: node scripts/split-bridge.ts --check [--base origin/main]')
  process.exit(2)
}
const i = args.indexOf('--base')
process.exit(check(i >= 0 ? (args[i + 1] as string) : 'origin/main'))
