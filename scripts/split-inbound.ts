// Splits apps/bridge/src/inbound.ts by frame family. A move and nothing else: every handler keeps its text, and the class,
// its public surface and dispatch stay in inbound.ts. Some handlers carry their own seen-id, age or card-state checks.
//
//   node scripts/split-inbound.ts                  split the working tree's inbound.ts (run on a fresh main checkout)
//   node scripts/split-inbound.ts --check [--base origin/main]
//                                                  prove the split is a move: compare it with inbound.ts at the base ref
//
// Rerun on a fresh checkout of main after main moves; it reads whatever inbound.ts says now. A method the plan below does not
// name stays where it is, and the script says so.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'apps', 'bridge', 'src')
const MAIN = 'inbound.ts'

/** Which class methods move to which file. Order inside a file follows the original source. */
const FAMILIES: Record<string, { file: string; about: string; methods: string[] }> = {
  schedule: {
    file: 'inbound-schedule.ts',
    about: 'Signed schedule frames: the owner signature is checked here, then the scheduler service answers.',
    methods: ['onScheduleFrame', 'onBadScheduleFrame'],
  },
  reads: {
    file: 'inbound-reads.ts',
    about: 'Signed owner reads (search, memory, speak, history pages, media re-upload) and signed app requests.',
    methods: [
      'onReadFrame',
      'onHistoryFrame',
      'refuseUnsigned',
      'onMediaFetchFrame',
      'onAppFrame',
      'refuseReplay',
      'answerRead',
      'onHistoryRequest',
      'onMediaFetch',
    ],
  },
  messages: {
    file: 'inbound-messages.ts',
    about: 'Owner messages and voice notes, one at a time and as a backlog after the Mac was offline.',
    methods: [
      'fetchAttachments',
      'record',
      'seq',
      'messageExtras',
      'messageRow',
      'onMessage',
      'afterOwnerNotify',
      'voiceNoteContent',
      'onVoiceNote',
      'handleBacklog',
    ],
  },
  runs: {
    file: 'inbound-runs.ts',
    about: 'The owner tapping Run on a script block.',
    methods: ['onRun'],
  },
  cards: {
    file: 'inbound-cards.ts',
    about: 'Card decisions: taps from the app, taps from a notification, and what happens when the agent is not told.',
    methods: [
      'onNativeAct',
      'onCardResolve',
      'tellAgent',
      'endUndelivered',
      'cardNotDelivered',
      'sweepInterrupted',
      'closeDecided',
    ],
  },
  config: {
    file: 'inbound-config.ts',
    about: 'Settings patches from the app.',
    methods: ['onConfigPatch'],
  },
  events: {
    file: 'inbound-events.ts',
    about: 'Voice calls, shared items, problem reports and webhook events.',
    methods: ['onVoiceAsk', 'onVoiceEnded', 'onShareItem', 'onProblemItem', 'onHookEvent', 'onHookDigest'],
  },
}
/** Top-level functions that travel with the family that uses them (name -> family key). */
const FUNCTIONS: Record<string, string> = { tooLarge: 'reads' }
/** Top-level declarations the moved code needs; they go to inbound-shared.ts and gain `export`. */
const SHARED = [
  'Of',
  'Item',
  'OwnerCheck',
  'READ_MAX_AGE_MS',
  'CLOCK_OFF_MESSAGE',
  'oneLine',
  'BACKLOG_PART_BYTES',
  'backlogRowBytes',
]
const SHARED_FILE = 'inbound-shared.ts'
/** Public names inbound.ts must keep exporting. */
const REEXPORT = ['CLOCK_OFF_MESSAGE']
const NS = (key: string) => key // namespace import name in inbound.ts

const parse = (name: string, text: string) =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

type Piece = { name: string; start: number; end: number; node: ts.Node }

/** Start of a node including the comments stuck to it (no blank line between). */
function attachedStart(sf: ts.SourceFile, node: ts.Node): number {
  const text = sf.text
  const ranges = ts.getLeadingCommentRanges(text, node.pos) ?? []
  let start = node.getStart(sf)
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i] as ts.CommentRange
    if (!/^[ \t]*\r?\n[ \t]*$/.test(text.slice(r.end, start))) break
    start = r.pos
  }
  return start
}

function topLevel(sf: ts.SourceFile): Map<string, Piece> {
  const out = new Map<string, Piece>()
  for (const st of sf.statements) {
    const names: string[] = []
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text)
    if ((ts.isFunctionDeclaration(st) || ts.isTypeAliasDeclaration(st)) && st.name) names.push(st.name.text)
    for (const name of names) out.set(name, { name, start: attachedStart(sf, st), end: st.end, node: st })
  }
  return out
}

function classOf(sf: ts.SourceFile): ts.ClassDeclaration {
  const c = sf.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === 'Inbound')
  if (!c) throw new Error('class Inbound not found in inbound.ts')
  return c
}

function methodsOf(sf: ts.SourceFile, cls: ts.ClassDeclaration): Map<string, Piece> {
  const out = new Map<string, Piece>()
  for (const m of cls.members)
    if (ts.isMethodDeclaration(m) && ts.isIdentifier(m.name))
      out.set(m.name.text, { name: m.name.text, start: attachedStart(sf, m), end: m.end, node: m })
  return out
}

/** Names a piece of code uses as values or types, ignoring property names and declaration names. */
function usedNames(sf: ts.SourceFile): Set<string> {
  const used = new Set<string>()
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) {
      const p = n.parent
      const skip =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isQualifiedName(p) && p.right === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        ((ts.isMethodDeclaration(p) ||
          ts.isPropertyDeclaration(p) ||
          ts.isPropertySignature(p) ||
          ts.isMethodSignature(p)) &&
          p.name === n) ||
        (ts.isBindingElement(p) && p.propertyName === n) ||
        ts.isImportSpecifier(p) ||
        ts.isExportSpecifier(p)
      if (!skip) used.add(n.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return used
}

type Import = {
  text: string
  typeOnly: boolean
  from: string
  default?: string
  named: Array<{ name: string; text: string }>
}

function importsOf(sf: ts.SourceFile): Import[] {
  const out: Import[] = []
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue
    const from = (st.moduleSpecifier as ts.StringLiteral).text
    const clause = st.importClause
    const named: Import['named'] = []
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
      for (const e of clause.namedBindings.elements) named.push({ name: e.name.text, text: e.getText(sf) })
    out.push({ text: st.getText(sf), typeOnly: !!clause?.isTypeOnly, from, default: clause?.name?.text, named })
  }
  return out
}

/** The import lines a new file needs: the original imports cut down to what its code uses, plus extra lines. */
function importBlock(orig: Import[], code: string, extra: string[]): string {
  const sf = parse('x.ts', code)
  const used = usedNames(sf)
  const lines: string[] = []
  for (const imp of orig) {
    if (imp.named.length === 0) continue // a side-effect or namespace import: none in inbound.ts
    const keep = imp.named.filter((n) => used.has(n.name))
    if (!keep.length) continue
    lines.push(`import ${imp.typeOnly ? 'type ' : ''}{ ${keep.map((k) => k.text).join(', ')} } from '${imp.from}'`)
  }
  return `${[...lines, ...extra].join('\n')}\n`
}

const biome = (files: string[]) =>
  execFileSync('pnpm', ['exec', 'biome', 'check', '--write', ...files], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

function split() {
  const mainPath = join(srcDir, MAIN)
  const text = readFileSync(mainPath, 'utf8')
  if (text.includes(`./${SHARED_FILE}`)) {
    console.log('inbound.ts is already split; start from a fresh main checkout.')
    return
  }
  const sf = parse(MAIN, text)
  const cls = classOf(sf)
  const methods = methodsOf(sf, cls)
  const tops = topLevel(sf)
  const origImports = importsOf(sf)

  const plan = Object.values(FAMILIES).flatMap((f) => f.methods)
  for (const name of plan)
    if (!methods.has(name)) throw new Error(`planned method ${name} is not in inbound.ts; update FAMILIES`)
  for (const name of [...Object.keys(FUNCTIONS), ...SHARED])
    if (!tops.has(name)) throw new Error(`planned declaration ${name} is not in inbound.ts; update the plan`)
  const staying = [...methods.keys()].filter((n) => !plan.includes(n))
  console.log(`staying in inbound.ts: ${staying.join(', ')}`)

  // Members of the class that moved code reaches through `this`: they lose `private` (the one declaration change).
  const reached = new Set<string>()
  const noteThis = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword) reached.add(n.name.text)
    if (
      ts.isVariableDeclaration(n) &&
      n.initializer?.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isObjectBindingPattern(n.name)
    )
      for (const e of n.name.elements) reached.add((e.propertyName ?? e.name).getText(sf))
    ts.forEachChild(n, noteThis)
  }
  for (const name of plan) noteThis((methods.get(name) as Piece).node)

  // ---- the family files
  const written: string[] = []
  const inClass = (piece: Piece, name: string) => {
    const m = piece.node as ts.MethodDeclaration
    const open = m.parameters.pos - 1 // the "(" of the parameter list
    const head = text.slice(piece.start, m.getStart(sf))
    const mods = (m.modifiers ?? []).filter((x) => x.kind !== ts.SyntaxKind.PrivateKeyword).map((x) => x.getText(sf))
    const typeParams = m.typeParameters ? text.slice(m.typeParameters.pos - 1, m.typeParameters.end + 1) : ''
    const params = m.parameters.length ? 'this: Inbound, ' : 'this: Inbound'
    if (text[open] !== '(') throw new Error(`cannot find the parameter list of ${name}`)
    return `${head}${[...mods, ''].join(' ')}${name}${typeParams}(${params}${text.slice(open + 1, m.end)},`
  }

  const bodies = new Map<string, string>() // family -> code
  for (const [key, fam] of Object.entries(FAMILIES)) {
    const objName = `${key}Frames`
    const parts = fam.methods.map((name) => inClass(methods.get(name) as Piece, name))
    let code = `export const ${objName} = {\n${parts.join('\n\n')}\n}\n`
    const fns = Object.entries(FUNCTIONS).filter(([, k]) => k === key)
    for (const [fn] of fns) {
      const p = tops.get(fn) as Piece
      code += `\n${text.slice(p.start, p.end)}\n`
    }
    bodies.set(key, code)
  }

  // ---- shared declarations
  let shared = ''
  for (const name of SHARED) {
    const p = tops.get(name) as Piece
    let t = text.slice(p.start, p.end)
    const st = p.node as ts.Statement
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) t = t.replace(new RegExp(`^((?:[^\\n]*\\n)*?)((?:const|type) ${name}\\b)`), '$1export $2')
    shared += `${t}\n\n`
  }
  // Of/Item/OwnerCheck reference Frame; each file gets only the imports it uses.
  const sharedCode = shared.trimEnd()
  const sharedFile = `// Types and constants the inbound frame families share.\n${importBlock(origImports, sharedCode, [])}\n${sharedCode}\n`

  const sharedNames = SHARED.filter((n) => !n.startsWith('Of') || true)
  const sharedImportFor = (code: string) => {
    const used = usedNames(parse('x.ts', code))
    const want = sharedNames.filter((n) => used.has(n))
    if (!want.length) return []
    const typeNames = new Set(['Of', 'Item', 'OwnerCheck'])
    return [`import { ${want.map((n) => (typeNames.has(n) ? `type ${n}` : n)).join(', ')} } from './${SHARED_FILE}'`]
  }

  for (const [key, fam] of Object.entries(FAMILIES)) {
    const code = bodies.get(key) as string
    const extra = [`import type { Inbound } from './inbound.ts'`, ...sharedImportFor(code)]
    const out = `// ${fam.about}\n// Handlers of the Inbound class (inbound.ts), which forwards to them. Dispatch and the first trust checks are in inbound.ts;\n// some handlers here run their own seen-id, age or card-state checks, so read both when auditing trust.\n${importBlock(origImports, code, extra)}\n${code}`
    writeFileSync(join(srcDir, fam.file), out)
    written.push(fam.file)
  }
  writeFileSync(join(srcDir, SHARED_FILE), sharedFile)
  written.push(SHARED_FILE)

  // ---- inbound.ts: cut the moved pieces out, add forwarders, drop what is no longer used
  const cuts: Array<[number, number]> = []
  for (const name of plan) {
    const p = methods.get(name) as Piece
    cuts.push([p.start, p.end])
  }
  for (const name of [...Object.keys(FUNCTIONS), ...SHARED]) {
    const p = tops.get(name) as Piece
    cuts.push([p.start, p.end])
  }
  // the import block is rebuilt, so cut it too
  const importStmts = sf.statements.filter(ts.isImportDeclaration)
  const importsStart = (importStmts[0] as ts.ImportDeclaration).getStart(sf)
  const importsEnd = (importStmts[importStmts.length - 1] as ts.ImportDeclaration).end
  cuts.push([importsStart, importsEnd])
  cuts.sort((a, b) => b[0] - a[0])
  let rest = text
  for (const [a, b] of cuts) rest = rest.slice(0, a) + (a === importsStart ? '@@IMPORTS@@' : '') + rest.slice(b)

  // un-private what moved code reaches
  const clsAfter = classOf(parse(MAIN, rest))
  const sf2 = parse(MAIN, rest)
  const edits: Array<[number, number]> = []
  const strip = (modsOwner: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }) => {
    for (const mod of modsOwner.modifiers ?? [])
      if (mod.kind === ts.SyntaxKind.PrivateKeyword) edits.push([mod.getStart(sf2), mod.end + 1])
  }
  const memberName = (m: ts.ClassElement) => (m.name && ts.isIdentifier(m.name) ? m.name.text : undefined)
  for (const m of classOf(sf2).members) {
    const n = memberName(m)
    if (n && reached.has(n)) strip(m as ts.PropertyDeclaration)
    if (ts.isConstructorDeclaration(m))
      for (const p of m.parameters) if (ts.isIdentifier(p.name) && reached.has(p.name.text)) strip(p)
  }
  void clsAfter
  edits.sort((a, b) => b[0] - a[0])
  for (const [a, b] of edits) rest = rest.slice(0, a) + rest.slice(b)

  // forwarders, grouped before the end of the class
  const forwarders = Object.entries(FAMILIES)
    .flatMap(([key, fam]) =>
      fam.methods.map((name) => {
        const m = methods.get(name)?.node as ts.MethodDeclaration
        const isPrivate = !reached.has(name) && (m.modifiers ?? []).some((x) => x.kind === ts.SyntaxKind.PrivateKeyword)
        return `  ${isPrivate ? 'private ' : ''}${name}(...args: Parameters<typeof ${NS(key)}Frames.${name}>) {\n    return ${NS(key)}Frames.${name}.apply(this, args)\n  }`
      }),
    )
    .join('\n\n')
  const clsEnd = classOf(parse(MAIN, rest))
  const closeAt = clsEnd.end - 1 // the "}" of the class
  const banner =
    '  // ---- frame families ------------------------------------------------------------------------------------------\n' +
    '  // The handlers live in inbound-*.ts, one file per family. Each method here forwards to its handler with the same arguments.\n\n'
  rest = `${rest.slice(0, closeAt).trimEnd()}\n\n${banner}${forwarders}\n${rest.slice(closeAt)}`

  // banners whose section moved away
  const bannerRe = /\n {2}\/\/ ---- [^\n]*\n\n(?= {2}\/\/ ---- |\})/g
  for (let prev = ''; prev !== rest; ) {
    prev = rest
    rest = rest.replace(bannerRe, '\n')
  }

  // imports
  const frameImports = Object.entries(FAMILIES).map(
    ([key, fam]) => `import { ${NS(key)}Frames } from './${fam.file.replace(/\.ts$/, '.ts')}'`,
  )
  const sharedSf = parse('x.ts', rest.replace('@@IMPORTS@@', ''))
  const used = usedNames(sharedSf)
  const sharedWant = SHARED.filter((n) => used.has(n))
  const typeNames = new Set(['Of', 'Item', 'OwnerCheck'])
  const sharedLine = sharedWant.length
    ? [`import { ${sharedWant.map((n) => (typeNames.has(n) ? `type ${n}` : n)).join(', ')} } from './${SHARED_FILE}'`]
    : []
  const reexport = REEXPORT.map((n) => `export { ${n} } from './${SHARED_FILE}'`)
  const block = importBlock(origImports, rest.replace('@@IMPORTS@@', ''), [...sharedLine, ...frameImports]).trimEnd()
  rest = rest.replace('@@IMPORTS@@', `${block}\n${reexport.join('\n')}`)
  rest = rest.replace(/\n{3,}/g, '\n\n')
  writeFileSync(mainPath, rest)
  written.push(MAIN)

  biome(written.map((f) => join(srcDir, f)))
  console.log(`wrote ${written.join(', ')}`)
}

// ---------------------------------------------------------------------------------------------------------------------
// --check: the split is a move

function show(ref: string): string {
  return execFileSync('git', ['show', `${ref}:apps/bridge/src/${MAIN}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
}

type Member = { header: string; rest: string; comments: string; priv: boolean }

/** A method or function split into the parts the check compares: comments, header (modifiers + name), and the rest from "(". */
function describeMember(sf: ts.SourceFile, node: ts.Node, start: number): Member {
  const text = sf.text
  const m = node as ts.MethodDeclaration | ts.FunctionDeclaration | ts.MethodSignature
  const open = m.parameters.pos - 1
  const mods = (ts.canHaveModifiers(m) ? (ts.getModifiers(m) ?? []) : []).map((x) => x.kind)
  return {
    comments: text.slice(start, m.getStart(sf)),
    header: text
      .slice(m.getStart(sf), open)
      .replace(/^(private |public )/, '')
      .replace(/^export /, '')
      .replace(/^function /, ''),
    rest: text.slice(open, m.end),
    priv: mods.includes(ts.SyntaxKind.PrivateKeyword),
  }
}

function collect(sf: ts.SourceFile): Map<string, Member> {
  const out = new Map<string, Member>()
  const addMethod = (m: ts.MethodDeclaration) => {
    if (ts.isIdentifier(m.name)) out.set(m.name.text, describeMember(sf, m, attachedStart(sf, m)))
  }
  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st)) for (const m of st.members) if (ts.isMethodDeclaration(m)) addMethod(m)
    if (ts.isFunctionDeclaration(st) && st.name) out.set(st.name.text, describeMember(sf, st, attachedStart(sf, st)))
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (d.initializer && ts.isObjectLiteralExpression(d.initializer))
          for (const m of d.initializer.properties) if (ts.isMethodDeclaration(m)) addMethod(m)
  }
  return out
}

/** Lines of a file outside import declarations, trimmed and without blanks. */
function codeLines(name: string, text: string): string[] {
  const sf = parse(name, text)
  let t = text
  for (const st of [...sf.statements].reverse())
    if (ts.isImportDeclaration(st)) t = t.slice(0, st.getStart(sf)) + t.slice(st.end)
  return t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

function check(base: string): number {
  const origText = show(base)
  const orig = collect(parse(MAIN, origText))
  const files = [MAIN, SHARED_FILE, ...Object.values(FAMILIES).map((f) => f.file)]
  const texts = new Map(files.map((f) => [f, existsSync(join(srcDir, f)) ? readFileSync(join(srcDir, f), 'utf8') : '']))
  const now = new Map<string, { file: string; m: Member }>()
  const fwd = new Set<string>()
  for (const [f, t] of texts) {
    for (const [name, m] of collect(parse(f, t))) {
      // a forwarder is the one-line `return xFrames.name.apply(this, args)` body in inbound.ts
      if (
        f === MAIN &&
        /\.apply\(this, args\)/.test(m.rest) &&
        Object.values(FAMILIES).some((x) => x.methods.includes(name))
      ) {
        fwd.add(name)
        continue
      }
      if (now.has(name)) {
        console.log(`DUPLICATE ${name}: ${now.get(name)?.file} and ${f}`)
        return 1
      }
      now.set(name, { file: f, m })
    }
  }
  let bad = 0
  let same = 0
  let movedCount = 0
  const stripThis = (s: string) => s.replace(/^\(this: Inbound, /, '(').replace(/^\(this: Inbound\)/, '()')
  const rows: string[] = []
  for (const [name, o] of orig) {
    const n = now.get(name)
    if (!n) {
      rows.push(`MISSING   ${name}`)
      bad++
      continue
    }
    const moved = n.file !== MAIN
    const body = moved ? stripThis(n.m.rest) : n.m.rest
    const trail = moved ? body.replace(/,$/, '') : body
    const ok = o.comments === n.m.comments && o.header === n.m.header && o.rest === trail
    if (ok) {
      same++
      if (moved) movedCount++
    } else {
      bad++
      rows.push(`DIFFERS   ${name} (${n.file})`)
      if (o.comments !== n.m.comments) rows.push('   comments differ')
      if (o.header !== n.m.header) rows.push(`   header: ${JSON.stringify(o.header)} -> ${JSON.stringify(n.m.header)}`)
      if (o.rest !== trail) rows.push('   body differs')
    }
  }
  for (const name of now.keys())
    if (!orig.has(name)) {
      rows.push(`NEW       ${name} (${now.get(name)?.file})`)
      bad++
    }
  for (const name of fwd)
    if (!orig.has(name)) {
      rows.push(`NEW FORWARDER ${name}`)
      bad++
    }
  const movedNames = new Set([...now].filter(([, v]) => v.file !== MAIN).map(([k]) => k))
  for (const name of movedNames)
    if (!fwd.has(name) && Object.values(FAMILIES).some((f) => f.methods.includes(name))) {
      rows.push(`NO FORWARDER ${name}`)
      bad++
    }

  // Independent of the per-function view: every code line outside imports, as a multiset, before and after.
  const count = (lines: string[]) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>())
  const before = count(codeLines(MAIN, origText))
  const after = count([...texts].flatMap(([f, t]) => codeLines(f, t)))
  const removed: string[] = []
  const added: string[] = []
  for (const [l, c] of before) if ((after.get(l) ?? 0) < c) removed.push(`${c - (after.get(l) ?? 0)}x ${l}`)
  for (const [l, c] of after) if ((before.get(l) ?? 0) < c) added.push(`${c - (before.get(l) ?? 0)}x ${l}`)

  console.log(`compared with ${base}:apps/bridge/src/${MAIN}`)
  console.log(
    `${orig.size} functions in the original; ${same} byte-identical (${movedCount} of them moved to a family file)`,
  )
  console.log(
    'compared: leading comments, modifiers and name (a dropped `private` is allowed), and everything from "(" to the end;',
  )
  console.log(
    '          the added `this: Inbound` first parameter of a moved method is the only text removed before comparing',
  )
  for (const r of rows) console.log(r)
  console.log(`\nlines only in the original (outside imports): ${removed.length}`)
  for (const l of removed) console.log(`  - ${l}`)
  console.log(`lines only in the split (outside imports): ${added.length}`)
  for (const l of added) console.log(`  + ${l}`)
  return bad ? 1 : 0
}

const args = process.argv.slice(2)
if (args.includes('--check')) {
  const i = args.indexOf('--base')
  process.exit(check(i >= 0 ? (args[i + 1] as string) : 'origin/main'))
} else split()
