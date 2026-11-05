// Splits the frame switch of apps/web/src/lib/socketClient.ts into one file per frame family. A move and nothing else: each
// `case` body becomes a handler function with its text unchanged, and the connection, the outbox and `dispatch` stay in
// socketClient.ts. A handler gets the closure it needs through one explicit context object built once in createSocketClient.
//
//   npx tsx scripts/split-socketclient.ts            split the working tree's socketClient.ts (run on a fresh main checkout)
//   npx tsx scripts/split-socketclient.ts --check [--base origin/main]
//                                                    prove the split is a move: compare it with socketClient.ts at the base ref
//
// The only text a handler gains is a prelude that reads its context (`const { set } = ctx`, `const key = ctx.getKey()`).
// The only text a body changes is listed in SUBSTITUTIONS. Rerun on a fresh checkout of main after main moves.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const libDir = join(root, 'apps', 'web', 'src', 'lib')
const MAIN = 'socketClient.ts'
const CONTEXT_FILE = 'socket-frames-context.ts'
const CTX = 'ctx' // the context parameter of a handler
const CTX_VAR = 'frameCtx' // the context object in createSocketClient

/** Which frame types each family file handles. Order inside a file follows the original switch. */
const FAMILIES: Record<string, { file: string; about: string; types: string[] }> = {
  chat: {
    file: 'socket-frames-chat.ts',
    about:
      'Message frames: the stored copy of an owner message, the agent reply, voice transcripts and delivery receipts.',
    types: ['message.stored', 'reply', 'transcript', 'receipt'],
  },
  cards: {
    file: 'socket-frames-cards.ts',
    about: 'Cards, MCP app views and the inbox: creation, updates, and the unread count a new inbox item adds.',
    types: ['card.create', 'card.update', 'app.update', 'inbox.item', 'inbox.update'],
  },
  threads: {
    file: 'socket-frames-threads.ts',
    about: 'Thread list, agent status, presence, read marks and the agent config the Mac pushes.',
    types: ['status', 'presence', 'thread.upsert', 'thread.archive', 'thread.read', 'thread.unread', 'config.sync'],
  },
  catchup: {
    file: 'socket-frames-catchup.ts',
    about:
      'What happens after a connection: `ready`, catch-up batches (the lastSeq logic), the reset, and history pages.',
    types: ['ready', 'catchup.batch', 'catchup.reset', 'catchup.summary', 'history.page'],
  },
  delivery: {
    file: 'socket-frames-delivery.ts',
    about: 'Answers to what this device sent: the device pin, acks and errors.',
    types: ['device.pinned', 'ack', 'error'],
  },
}

/** Handler name for a frame type: `thread.upsert` -> `onThreadUpsert`. */
const handlerName = (type: string) =>
  `on${type
    .split(/[._]/)
    .map((p) => p[0]?.toUpperCase() + p.slice(1))
    .join('')}`
const familyOf = (type: string) => Object.entries(FAMILIES).find(([, f]) => f.types.includes(type))?.[0]

/**
 * The context, one row per entry. `binds` is the variable in createSocketClient the entry gives access to; `value` is the exact
 * text written into the object. A variable that createSocketClient reassigns (`let`) is never handed over by value: it is read
 * through a function, so a handler sees what the variable holds when the frame arrives, not when the context was built.
 * --check recomputes "reassigned" and the declaration kind from the source and compares them with this table.
 */
type Entry = { name: string; type: string; value: string; binds: string; reassigned: boolean }
const CONTEXT: Entry[] = [
  { name: 'store', type: 'StoreApi<ClientState>', value: 'store', binds: 'store', reassigned: false },
  {
    name: 'set',
    type: '(fn: (s: ClientState) => Partial<ClientState>) => void',
    value: 'set',
    binds: 'set',
    reassigned: false,
  },
  { name: 'now', type: '() => number', value: 'now', binds: 'now', reassigned: false },
  { name: 'lostIds', type: 'Set<string>', value: 'lostIds', binds: 'lostIds', reassigned: false },
  {
    name: 'patchMessage',
    type: '(id: string, fn: (m: MessageT) => MessageT) => void',
    value: 'patchMessage',
    binds: 'patchMessage',
    reassigned: false,
  },
  {
    name: 'upsertMessage',
    type: '(m: MessageT) => void',
    value: 'upsertMessage',
    binds: 'upsertMessage',
    reassigned: false,
  },
  { name: 'upsertCard', type: '(card: CardT) => void', value: 'upsertCard', binds: 'upsertCard', reassigned: false },
  {
    name: 'withSeq',
    type: '(m: MessageT, frame: { relay?: { seq: number } }) => MessageT',
    value: 'withSeq',
    binds: 'withSeq',
    reassigned: false,
  },
  {
    name: 'bumpSeq',
    type: '(frame: { relay?: { seq: number } }) => void',
    value: 'bumpSeq',
    binds: 'bumpSeq',
    reassigned: false,
  },
  {
    name: 'bumpUnread',
    type: '(threadId: string) => void',
    value: 'bumpUnread',
    binds: 'bumpUnread',
    reassigned: false,
  },
  {
    name: 'findMessage',
    type: '(id: string) => MessageT | undefined',
    value: 'findMessage',
    binds: 'findMessage',
    reassigned: false,
  },
  {
    name: 'clearFailed',
    type: '(clientMsgId: string) => void',
    value: 'clearFailed',
    binds: 'clearFailed',
    reassigned: false,
  },
  {
    name: 'markFailed',
    type: "(clientMsgId: string, kind: 'retry' | 'final') => void",
    value: 'markFailed',
    binds: 'markFailed',
    reassigned: false,
  },
  {
    name: 'addSystemRow',
    type: '(text: string, id: string, threadId?: string) => void',
    value: 'addSystemRow',
    binds: 'addSystemRow',
    reassigned: false,
  },
  {
    name: 'emit',
    type: '(type: string, frame: Record<string, unknown>) => void',
    value: 'emit',
    binds: 'emit',
    reassigned: false,
  },
  {
    name: 'settleConfig',
    type: '(id: string, err?: TalosClientError) => boolean',
    value: 'settleConfig',
    binds: 'settleConfig',
    reassigned: false,
  },
  {
    name: 'configWaiters',
    type: 'Map<string, { baseRev: number; resolve: () => void; reject: (e: TalosClientError) => void; timer: ReturnType<typeof setTimeout> }>',
    value: 'configWaiters',
    binds: 'configWaiters',
    reassigned: false,
  },
  {
    name: 'mediaFetchIds',
    type: 'Map<string, string>',
    value: 'mediaFetchIds',
    binds: 'mediaFetchIds',
    reassigned: false,
  },
  {
    name: 'pending',
    type: 'Map<string, { resolve: (seq: number | undefined) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>',
    value: 'pending',
    binds: 'pending',
    reassigned: false,
  },
  { name: 'historyGen', type: 'Map<string, number>', value: 'historyGen', binds: 'historyGen', reassigned: false },
  {
    name: 'historyAsked',
    type: 'Map<string, string>',
    value: 'historyAsked',
    binds: 'historyAsked',
    reassigned: false,
  },
  {
    name: 'contextRequests',
    type: 'Set<string>',
    value: 'contextRequests',
    binds: 'contextRequests',
    reassigned: false,
  },
  { name: 'latestRequests', type: 'Set<string>', value: 'latestRequests', binds: 'latestRequests', reassigned: false },
  {
    name: 'historyWaiters',
    type: "Map<string, (p: FrameOf<'history.page'>) => void>",
    value: 'historyWaiters',
    binds: 'historyWaiters',
    reassigned: false,
  },
  {
    name: 'historyErrors',
    type: 'Map<string, (e: TalosClientError) => void>',
    value: 'historyErrors',
    binds: 'historyErrors',
    reassigned: false,
  },
  {
    name: 'inboxSettled',
    type: '(frameId: string, keep?: boolean) => boolean',
    value: 'inboxSettled',
    binds: 'inboxSettled',
    reassigned: false,
  },
  {
    name: 'onAcked',
    type: '(frameId: string) => Promise<void>',
    value: 'onAcked',
    binds: 'onAcked',
    reassigned: false,
  },
  {
    name: 'dropFromOutbox',
    type: '(frameId: string) => Promise<void>',
    value: 'dropFromOutbox',
    binds: 'dropFromOutbox',
    reassigned: false,
  },
  { name: 'flushOutbox', type: '() => Promise<void>', value: 'flushOutbox', binds: 'flushOutbox', reassigned: false },
  {
    name: 'dispatch',
    type: '(frame: Frame, isCatchup?: boolean) => void',
    value: 'dispatch',
    binds: 'dispatch',
    reassigned: false,
  },
  { name: 'send', type: '(fields: Record<string, unknown>) => void', value: 'send', binds: 'send', reassigned: false },
  {
    name: 'isRecord',
    type: '(v: unknown) => v is Record<string, unknown>',
    value: 'isRecord',
    binds: 'isRecord',
    reassigned: false,
  },
  {
    name: 'applyStoredOwnerFrame',
    type: '(raw: Record<string, unknown>) => void',
    value: 'applyStoredOwnerFrame',
    binds: 'applyStoredOwnerFrame',
    reassigned: false,
  },
  {
    name: 'noteUnknown',
    type: 'ReturnType<typeof createUnknownNotes>',
    value: 'noteUnknown',
    binds: 'noteUnknown',
    reassigned: false,
  },
  // ---- reassigned by createSocketClient: read through a function, never captured
  { name: 'getKey', type: '() => DeviceKey | null', value: '() => key', binds: 'key', reassigned: true },
  { name: 'getOutbox', type: '() => OutboxEntry[]', value: '() => outbox', binds: 'outbox', reassigned: true },
  { name: 'getResetGen', type: '() => number', value: '() => resetGen', binds: 'resetGen', reassigned: true },
  {
    name: 'bumpResetGen',
    type: '() => void',
    value: '() => {\n      resetGen++\n    }',
    binds: 'resetGen',
    reassigned: true,
  },
]
/** A reassigned variable a handler reads: the prelude line is `const <variable> = ctx.<getter>()`. */
const GETTERS: Record<string, string> = { key: 'getKey', outbox: 'getOutbox', resetGen: 'getResetGen' }
/** The only text changes inside a moved body: a write to a reassigned variable goes through a context function. */
const SUBSTITUTIONS: Array<{ type: string; from: string; to: string }> = [
  { type: 'catchup.reset', from: 'resetGen++', to: `${CTX}.bumpResetGen()` },
]

const parse = (name: string, text: string) =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

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

/** Names declared inside a piece of code (variables, parameters, catch variables, inner functions). */
function declaredNames(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>()
  const bind = (n: ts.BindingName) => {
    if (ts.isIdentifier(n)) out.add(n.text)
    else for (const e of n.elements) if (ts.isBindingElement(e)) bind(e.name)
  }
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n)) bind(n.name)
    if (ts.isFunctionDeclaration(n) && n.name) out.add(n.name.text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

type Import = { typeOnly: boolean; from: string; named: Array<{ name: string; text: string }> }
function importsOf(sf: ts.SourceFile): Import[] {
  const out: Import[] = []
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue
    const clause = st.importClause
    const named: Import['named'] = []
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
      for (const e of clause.namedBindings.elements) named.push({ name: e.name.text, text: e.getText(sf) })
    out.push({ typeOnly: !!clause?.isTypeOnly, from: (st.moduleSpecifier as ts.StringLiteral).text, named })
  }
  return out
}

/** The import lines a new file needs: the original imports cut down to what its code uses, plus extra lines. */
function importBlock(orig: Import[], code: string, extra: string[], keep: string[] = []): string {
  const used = usedNames(parse('x.ts', code))
  for (const k of keep) used.add(k)
  const lines: string[] = []
  for (const imp of orig) {
    const keep = imp.named.filter((n) => used.has(n.name))
    if (!keep.length) continue
    lines.push(`import ${imp.typeOnly ? 'type ' : ''}{ ${keep.map((k) => k.text).join(', ')} } from '${imp.from}'`)
  }
  return `${[...lines, ...extra].join('\n')}\n`
}

const biome = (files: string[]) => {
  try {
    execFileSync('pnpm', ['exec', 'biome', 'check', '--write', ...files], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer }
    console.log(String(err.stdout ?? ''), String(err.stderr ?? ''))
    throw e
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// reading the original

type Case = { type: string; clause: ts.CaseClause; body: string; start: number; end: number }
type Orig = {
  sf: ts.SourceFile
  fn: ts.FunctionDeclaration
  applyFrame: ts.FunctionDeclaration
  switchStmt: ts.SwitchStatement
  cases: Case[]
  scope: Map<string, { kind: 'const' | 'let' | 'function'; async: boolean }>
}

function dedent(s: string): string {
  const lines = s.replace(/^\n+|\s+$/g, '').split('\n')
  const indents = lines.filter((l) => l.trim()).map((l) => (/^ */.exec(l) as RegExpExecArray)[0].length)
  const cut = Math.min(...indents, Number.POSITIVE_INFINITY)
  return lines.map((l) => l.slice(Math.min(cut, (/^ */.exec(l) as RegExpExecArray)[0].length))).join('\n')
}

function readOrig(name: string, text: string): Orig {
  const sf = parse(name, text)
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'createSocketClient',
  )
  if (!fn?.body) throw new Error('createSocketClient not found in socketClient.ts')
  const scope: Orig['scope'] = new Map()
  const bind = (n: ts.BindingName, kind: 'const' | 'let', async: boolean) => {
    if (ts.isIdentifier(n)) scope.set(n.text, { kind, async })
    else for (const e of n.elements) if (ts.isBindingElement(e)) bind(e.name, kind, async)
  }
  let applyFrame: ts.FunctionDeclaration | undefined
  for (const st of fn.body.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) {
      scope.set(st.name.text, {
        kind: 'function',
        async: !!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
      })
      if (st.name.text === 'applyFrame') applyFrame = st
    }
    if (ts.isVariableStatement(st)) {
      const kind = st.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let'
      for (const d of st.declarationList.declarations) {
        const init = d.initializer
        const async =
          !!init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
          !!init.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
        bind(d.name, kind, async)
      }
    }
  }
  if (!applyFrame?.body) throw new Error('applyFrame not found in createSocketClient')
  const switchStmt = applyFrame.body.statements.find((s): s is ts.SwitchStatement => ts.isSwitchStatement(s))
  if (!switchStmt) throw new Error('the switch in applyFrame is gone; update the plan')
  const cases: Case[] = []
  for (const clause of switchStmt.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue
    if (!ts.isStringLiteral(clause.expression)) throw new Error('a case that is not a string literal')
    const only = clause.statements.length === 1 ? clause.statements[0] : undefined
    let body: string
    if (only && ts.isBlock(only)) body = text.slice(only.getStart(sf) + 1, only.end - 1)
    else body = text.slice(text.indexOf(':', clause.expression.end) + 1, clause.end)
    cases.push({
      type: clause.expression.text,
      clause,
      body: dedent(body),
      start: clause.getStart(sf),
      end: clause.end,
    })
  }
  return { sf, fn, applyFrame, switchStmt, cases, scope }
}

/** The body of a case with the declared substitutions applied. */
function substituted(c: Case): string {
  let body = c.body
  for (const s of SUBSTITUTIONS) if (s.type === c.type) body = body.split(s.from).join(s.to)
  return body
}

/** Scope names (from createSocketClient) a body reads, after substitutions, and not shadowed by its own declarations. */
function needs(o: Orig, body: string): string[] {
  const sf = parse('x.ts', `function w(frame: unknown, isCatchup: boolean){\n${body}\n}`)
  const declared = declaredNames(sf)
  const used = usedNames(sf)
  const out: string[] = []
  for (const n of used) if (o.scope.has(n) && !declared.has(n)) out.push(n)
  return out
}

/** The context entry a body name needs: the variable itself, or the name's getter. */
const entryFor = (variable: string) => (GETTERS[variable] ? GETTERS[variable] : variable)

// ---------------------------------------------------------------------------------------------------------------------
// split

function handlerCode(o: Orig, c: Case): { code: string; uses: string[] } {
  const body = substituted(c)
  const names = needs(o, body)
  const plain = CONTEXT.filter((e) => names.includes(e.binds) && !e.reassigned).map((e) => e.name)
  const read = names.filter((n) => GETTERS[n])
  const usedCtxCalls = CONTEXT.filter((e) => e.reassigned && body.includes(`${CTX}.${e.name}(`)).map((e) => e.name)
  for (const n of names) {
    const entry = entryFor(n)
    if (!CONTEXT.some((e) => e.name === entry))
      throw new Error(`${c.type} needs ${n}, which the context table does not hold`)
  }
  for (const n of names)
    if (n !== 'frame' && !plain.includes(n) && !GETTERS[n]) throw new Error(`${c.type}: ${n} is not handed over`)
  const usesIsCatchup = usedNames(parse('x.ts', `function w(){\n${body}\n}`)).has('isCatchup')
  const params = `${CTX}: FrameContext, frame: FrameOf<'${c.type}'>${usesIsCatchup ? ', isCatchup: boolean' : ''}`
  const prelude = [
    ...(plain.length ? [`const { ${plain.join(', ')} } = ${CTX}`] : []),
    ...read.map((v) => `const ${v} = ${CTX}.${GETTERS[v]}()`),
  ]
  const code = `export function ${handlerName(c.type)}(${params}): void {\n${[...prelude, body].join('\n')}\n}\n`
  return { code, uses: [...plain, ...usedCtxCalls, ...read.map((v) => GETTERS[v] as string)] }
}

function contextTypeFile(origImports: Import[]): string {
  const members = CONTEXT.map((e) => `  ${e.name}: ${e.type}`).join('\n')
  const code = `export type FrameContext = {\n${members}\n}\n`
  const extra = [
    `import type { OutboxEntry } from './socketClient.ts'`,
    `import type { StoreApi } from 'zustand/vanilla'`,
  ]
  return `// What the frame handlers (socket-frames-*.ts) reach in createSocketClient. Built once there; a variable that\n// createSocketClient reassigns is read through a function, so a handler sees its value when the frame arrives.\n${importBlock(origImports, code, extra)}\n${code}`
}

function split() {
  const mainPath = join(libDir, MAIN)
  const text = readFileSync(mainPath, 'utf8')
  if (text.includes(`./${CONTEXT_FILE}`)) {
    console.log('socketClient.ts is already split; start from a fresh main checkout.')
    return
  }
  const o = readOrig(MAIN, text)
  const origImports = importsOf(o.sf)
  for (const c of o.cases) if (!familyOf(c.type)) throw new Error(`case '${c.type}' is in no family; update FAMILIES`)
  for (const f of Object.values(FAMILIES))
    for (const t of f.types)
      if (!o.cases.some((c) => c.type === t)) throw new Error(`planned '${t}' is not in the switch`)

  const written: string[] = []
  for (const [key, fam] of Object.entries(FAMILIES)) {
    const code = fam.types.map((t) => handlerCode(o, o.cases.find((c) => c.type === t) as Case).code).join('\n')
    const extra = [`import type { FrameContext } from './${CONTEXT_FILE}'`]
    const out = `// ${fam.about}\n// Handlers of the frame switch in socketClient.ts, which dispatches to them. Each reads the closure through ctx.\n${importBlock(origImports, code, extra)}\n${code}`
    writeFileSync(join(libDir, fam.file), out)
    written.push(fam.file)
    void key
  }
  writeFileSync(join(libDir, CONTEXT_FILE), contextTypeFile(origImports))
  written.push(CONTEXT_FILE)

  // ---- socketClient.ts: the cases call their handlers, the context is built, imports follow
  let rest = text
  const edits: Array<[number, number, string]> = []
  for (const c of o.cases) {
    const h = handlerName(c.type)
    const usesIsCatchup = handlerCode(o, c).code.includes('isCatchup: boolean')
    edits.push([
      c.start,
      c.end,
      `case '${c.type}':\n        return ${h}(${CTX_VAR}, frame${usesIsCatchup ? ', isCatchup' : ''})`,
    ])
  }
  const isRecord = o.fn.body?.statements.find(
    (s) =>
      ts.isVariableStatement(s) &&
      s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === 'isRecord'),
  ) as ts.Statement
  const ctxCode = `\n\n  /** What the frame handlers (socket-frames-*.ts) reach here. Built once. A \`let\` that is reassigned below is read through a function. */\n  const ${CTX_VAR}: FrameContext = {\n${CONTEXT.map((e) => (e.value === e.name ? `    ${e.name},` : `    ${e.name}: ${e.value},`)).join('\n')}\n  }`
  edits.push([isRecord.end, isRecord.end, ctxCode])
  const stmts = o.sf.statements.filter(ts.isImportDeclaration)
  const importsStart = (stmts[0] as ts.ImportDeclaration).getStart(o.sf)
  const importsEnd = (stmts[stmts.length - 1] as ts.ImportDeclaration).end
  edits.push([importsStart, importsEnd, '@@IMPORTS@@'])
  edits.sort((a, b) => b[0] - a[0])
  for (const [a, b, t] of edits) rest = rest.slice(0, a) + t + rest.slice(b)
  const frameImports = Object.values(FAMILIES).map(
    (f) => `import { ${f.types.map(handlerName).join(', ')} } from './${f.file}'`,
  )
  // names the file only re-exports (`export type { X }`) stay imported
  const reexported: string[] = []
  for (const st of o.sf.statements)
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause))
      for (const e of st.exportClause.elements) reexported.push((e.propertyName ?? e.name).text)
  const block = importBlock(
    origImports,
    rest.replace('@@IMPORTS@@', ''),
    [`import type { FrameContext } from './${CONTEXT_FILE}'`, ...frameImports],
    reexported,
  ).trimEnd()
  rest = rest.replace('@@IMPORTS@@', block)
  writeFileSync(mainPath, rest)
  written.push(MAIN)
  biome(written.map((f) => join(libDir, f)))
  console.log(`wrote ${written.join(', ')}`)
}

// ---------------------------------------------------------------------------------------------------------------------
// --check: the split is a move

function show(ref: string): string {
  return execFileSync('git', ['show', `${ref}:apps/web/src/lib/${MAIN}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
}

/** Every string, template and regex literal of a piece of code, in order: formatting must never touch these. */
function literalsOf(text: string): string[] {
  const out: string[] = []
  const sf = parse('x.ts', `function w(){\n${text}\n}`)
  const visit = (n: ts.Node) => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n) ||
      ts.isRegularExpressionLiteral(n)
    )
      out.push(n.getText(sf))
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/**
 * identical: the same text apart from leading indentation. reflowed: the formatter re-wrapped lines or moved a trailing comma, and
 * the code is the same once whitespace and trailing commas are ignored, with every literal unchanged. differs: anything else.
 */
function compareCode(a: string, b: string): 'identical' | 'reflowed' | 'differs' {
  const lines = (s: string) =>
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n')
  if (lines(a) === lines(b)) return 'identical'
  const squash = squashWs
  if (squash(a) !== squash(b)) return 'differs'
  const la = literalsOf(a)
  const lb = literalsOf(b)
  return la.length === lb.length && la.every((x, i) => x === lb[i]) ? 'reflowed' : 'differs'
}

/** Variables of createSocketClient that are assigned or incremented after their declaration. */
function reassignedVars(o: Orig): Set<string> {
  const out = new Set<string>()
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind
      if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(n.left))
        out.add(n.left.text)
    }
    if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(n.operand)
    )
      out.add(n.operand.text)
    ts.forEachChild(n, visit)
  }
  if (o.fn.body) visit(o.fn.body)
  return out
}

const squashWs = (s: string) => s.replace(/\s+/g, '').replace(/,(?=[)\]}>])/g, '')
const isAsync = (n: ts.Node) =>
  ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
const hasAwait = (text: string) => {
  let found = false
  const visit = (n: ts.Node) => {
    if (ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier)) found = true
    ts.forEachChild(n, visit)
  }
  visit(parse('x.ts', `async function w(){\n${text}\n}`))
  return found
}

/** The source of createSocketClient with the switch and the context cut out, as the "everything else is untouched" witness. */
function withoutMoved(sf: ts.SourceFile, text: string): string {
  const cuts: Array<[number, number]> = []
  for (const st of sf.statements) if (ts.isImportDeclaration(st)) cuts.push([st.getStart(sf), st.end])
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'createSocketClient',
  )
  for (const st of fn?.body?.statements ?? []) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === 'applyFrame') cuts.push([attachedStart(sf, st), st.end])
    if (
      ts.isVariableStatement(st) &&
      st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === CTX_VAR)
    )
      cuts.push([attachedStart(sf, st), st.end])
  }
  cuts.sort((a, b) => b[0] - a[0])
  let t = text
  for (const [a, b] of cuts) t = t.slice(0, a) + t.slice(b)
  return t
}

function check(base: string): number {
  const origText = show(base)
  const o = readOrig(MAIN, origText)
  const texts = new Map<string, string>()
  for (const f of [MAIN, CONTEXT_FILE, ...Object.values(FAMILIES).map((x) => x.file)])
    texts.set(f, existsSync(join(libDir, f)) ? readFileSync(join(libDir, f), 'utf8') : '')
  let bad = 0
  const fail = (msg: string) => {
    console.log(`FAIL  ${msg}`)
    bad++
  }
  for (const [f, t] of texts) if (!t) fail(`${f} is missing`)
  if (bad) return 1
  const now = readOrig(MAIN, texts.get(MAIN) as string)
  console.log(`compared with ${base}:apps/web/src/lib/${MAIN}`)

  // ---- 1. the switch: same cases, same order, each calling its own family handler
  console.log('\n== dispatch: each case calls its own family handler')
  const planned = Object.values(FAMILIES).flatMap((f) => f.types)
  const origTypes = o.cases.map((c) => c.type)
  for (const t of origTypes) if (!planned.includes(t)) fail(`case '${t}' is in the original but in no family`)
  for (const t of planned) if (!origTypes.includes(t)) fail(`'${t}' is planned but not in the original switch`)
  const mainSf = now.sf
  const mainImports = new Map<string, string>() // imported name -> module
  for (const st of mainSf.statements)
    if (
      ts.isImportDeclaration(st) &&
      st.importClause?.namedBindings &&
      ts.isNamedImports(st.importClause.namedBindings)
    )
      for (const e of st.importClause.namedBindings.elements)
        mainImports.set(e.name.text, (st.moduleSpecifier as ts.StringLiteral).text)
  // the original applyFrame with each case replaced by its call must equal the working one
  const sigEnd = (sf: ts.SourceFile, a: ts.FunctionDeclaration) =>
    sf.text.slice(a.getStart(sf), (a.body as ts.Block).getStart(sf))
  if (squashWs(sigEnd(o.sf, o.applyFrame)) !== squashWs(sigEnd(now.sf, now.applyFrame)))
    fail('applyFrame signature changed')
  const nowTypes = now.cases.map((c) => c.type)
  if (nowTypes.join('|') !== origTypes.join('|'))
    fail(`frame order changed:\n   was ${origTypes.join(' ')}\n   now ${nowTypes.join(' ')}`)
  const origDefault = o.switchStmt.caseBlock.clauses
    .filter(ts.isDefaultClause)
    .map((c) => squashWs(o.sf.text.slice(c.getStart(o.sf), c.end)))
  const nowDefault = now.switchStmt.caseBlock.clauses
    .filter(ts.isDefaultClause)
    .map((c) => squashWs(now.sf.text.slice(c.getStart(now.sf), c.end)))
  if (origDefault.join() !== nowDefault.join()) fail('the default clause changed')
  const lastClauseOf = (x: Orig) => x.switchStmt.caseBlock.clauses[x.switchStmt.caseBlock.clauses.length - 1]
  if (
    ts.isDefaultClause(lastClauseOf(o) as ts.CaseOrDefaultClause) !==
    ts.isDefaultClause(lastClauseOf(now) as ts.CaseOrDefaultClause)
  )
    fail('default is no longer last')
  const handlerWithIsCatchup = new Set<string>()
  for (const c of now.cases) {
    const fam = familyOf(c.type)
    if (!fam) continue
    const file = (FAMILIES[fam] as (typeof FAMILIES)[string]).file
    const h = handlerName(c.type)
    const origCase = o.cases.find((x) => x.type === c.type)
    const wantCatch = origCase ? needsIsCatchup(origCase) : false
    if (wantCatch) handlerWithIsCatchup.add(c.type)
    const want = `return${h}(${CTX_VAR},frame${wantCatch ? ',isCatchup' : ''})`
    const got = squashWs(c.body)
    const importedFrom = mainImports.get(h)
    const ok = got === want && importedFrom === `./${file}`
    console.log(`${ok ? 'ok   ' : 'FAIL '} case '${c.type}' -> ${h}${wantCatch ? ' (+isCatchup)' : ''} from ${file}`)
    if (!ok) {
      bad++
      if (got !== want) console.log(`      body is ${JSON.stringify(c.body)}`)
      if (importedFrom !== `./${file}`) console.log(`      imported from ${importedFrom}`)
    }
  }

  // ---- 2. the handlers: body byte-identical (after the listed substitutions), prelude as planned, async-ness as in the source
  console.log('\n== handlers: body vs the original case, prelude, async-ness')
  let identical = 0
  let reflowed = 0
  const fileFns = new Map<string, Map<string, ts.FunctionDeclaration>>()
  for (const [key, fam] of Object.entries(FAMILIES)) {
    void key
    const text = texts.get(fam.file) as string
    const sf = parse(fam.file, text)
    const fns = new Map<string, ts.FunctionDeclaration>()
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st)) continue
      if (ts.isFunctionDeclaration(st) && st.name) {
        fns.set(st.name.text, st)
        continue
      }
      fail(`${fam.file} holds something other than imports and handlers: ${st.getText(sf).slice(0, 60)}`)
    }
    fileFns.set(fam.file, fns)
    const want = fam.types.map(handlerName)
    if ([...fns.keys()].join() !== want.join())
      fail(`${fam.file} holds ${[...fns.keys()].join(', ')}; the plan says ${want.join(', ')}`)
    for (const type of fam.types) {
      const h = handlerName(type)
      const fn = fns.get(h)
      const origCase = o.cases.find((x) => x.type === type)
      if (!fn?.body || !origCase) {
        fail(`${type}: handler or original case missing`)
        continue
      }
      const rows: string[] = []
      // async-ness: the original case runs inside applyFrame (sync) and may not await; the handler must say the same
      const srcAsync = isAsync(o.applyFrame) || hasAwait(origCase.body)
      const dstAsync = isAsync(fn)
      if (srcAsync !== dstAsync) rows.push(`async-ness: source ${srcAsync}, handler ${dstAsync}`)
      if (fn.type?.getText(sf) !== 'void') rows.push('return type is not void')
      // signature: ctx, frame of its own type, isCatchup when the body reads it
      const params = fn.parameters.map((p) => p.getText(sf).replace(/\s+/g, ' '))
      const wantParams = [
        `${CTX}: FrameContext`,
        `frame: FrameOf<'${type}'>`,
        ...(handlerWithIsCatchup.has(type) ? ['isCatchup: boolean'] : []),
      ]
      if (params.join('|') !== wantParams.join('|'))
        rows.push(`parameters ${params.join(', ')}; want ${wantParams.join(', ')}`)
      // prelude: leading statements that read ctx, nothing else
      const stmts = [...fn.body.statements]
      const prelude: string[] = []
      const plainNames: string[] = []
      const readNames: string[] = []
      while (stmts.length) {
        const st = stmts[0] as ts.Statement
        if (!ts.isVariableStatement(st) || st.declarationList.declarations.length !== 1) break
        const d = st.declarationList.declarations[0] as ts.VariableDeclaration
        const init = d.initializer
        if (init && ts.isIdentifier(init) && init.text === CTX && ts.isObjectBindingPattern(d.name)) {
          for (const e of d.name.elements)
            if (ts.isIdentifier(e.name) && !e.propertyName && !e.initializer) plainNames.push(e.name.text)
        } else if (
          init &&
          ts.isCallExpression(init) &&
          ts.isPropertyAccessExpression(init.expression) &&
          ts.isIdentifier(init.expression.expression) &&
          init.expression.expression.text === CTX &&
          ts.isIdentifier(d.name) &&
          GETTERS[d.name.text] === init.expression.name.text &&
          init.arguments.length === 0
        ) {
          readNames.push(d.name.text)
        } else break
        prelude.push(st.getText(sf))
        stmts.shift()
      }
      const bodyFrom = stmts.length ? attachedStart(sf, stmts[0] as ts.Statement) : fn.body.end - 1
      const movedText = text.slice(bodyFrom, fn.body.end - 1)
      const expected = substituted(origCase)
      const how = compareCode(expected, movedText)
      if (how === 'differs') rows.push('body differs from the original case (after the listed substitutions)')
      else if (how === 'identical') identical++
      else reflowed++
      // the prelude names exactly what the original body reads from the closure
      const needed = needs(o, expected)
      const wantPlain = CONTEXT.filter((e) => needed.includes(e.binds) && !e.reassigned).map((e) => e.name)
      const wantRead = needed.filter((n) => GETTERS[n])
      if ([...plainNames].sort().join() !== [...wantPlain].sort().join())
        rows.push(`context reads: handler takes {${plainNames.join(', ')}}; the body needs {${wantPlain.join(', ')}}`)
      if ([...readNames].sort().join() !== [...wantRead].sort().join())
        rows.push(
          `live reads: handler has ${readNames.join(', ') || 'none'}; the body needs ${wantRead.join(', ') || 'none'}`,
        )
      for (const n of plainNames)
        if (!CONTEXT.some((e) => e.name === n && !e.reassigned)) rows.push(`ctx.${n} is not an entry`)
      // a reassigned variable may never be destructured out of ctx
      for (const n of plainNames) if (CONTEXT.find((e) => e.name === n)?.reassigned) rows.push(`${n} is read by value`)
      console.log(
        `${rows.length ? 'FAIL ' : 'ok   '} ${h.padEnd(18)} ${fam.file.padEnd(26)} body ${how}, async ${srcAsync}->${dstAsync}, ctx {${plainNames.join(', ')}}${readNames.length ? ` live ${readNames.join(', ')}` : ''}`,
      )
      for (const r of rows) {
        console.log(`      ${r}`)
        bad++
      }
      if (rows.length) {
        console.log('      --- expected ---')
        console.log(expected)
      }
      // a SUBSTITUTION must have happened where listed, and only there
      for (const s of SUBSTITUTIONS)
        if (s.type === type && !movedText.includes(s.to)) {
          console.log(`FAIL  ${type}: substitution ${s.from} -> ${s.to} not found`)
          bad++
        }
    }
  }
  console.log(
    `bodies: ${identical} identical apart from indentation, ${reflowed} re-wrapped by the formatter (code and literals equal)`,
  )

  // ---- 3. the context: every entry, its value, whether createSocketClient reassigns it, and the type file
  console.log('\n== context: entry, value in createSocketClient, source declaration, reassigned')
  const reassigned = reassignedVars(o)
  const ctxDecl = now.fn.body?.statements.find(
    (s): s is ts.VariableStatement =>
      ts.isVariableStatement(s) &&
      s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === CTX_VAR),
  )
  const obj = ctxDecl?.declarationList.declarations[0]?.initializer
  if (!obj || !ts.isObjectLiteralExpression(obj)) {
    fail(`${CTX_VAR} object not found in createSocketClient`)
    return 1
  }
  const have = new Map<string, string>()
  for (const p of obj.properties) {
    if (ts.isShorthandPropertyAssignment(p)) have.set(p.name.text, p.name.text)
    else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) have.set(p.name.text, p.initializer.getText(now.sf))
    else fail(`${CTX_VAR} has an entry that is not name: value (${p.getText(now.sf).slice(0, 40)})`)
  }
  if ([...have.keys()].join() !== CONTEXT.map((e) => e.name).join())
    fail(
      `${CTX_VAR} entries differ from the list:\n   has  ${[...have.keys()].join(', ')}\n   list ${CONTEXT.map((e) => e.name).join(', ')}`,
    )
  const typeSf = parse(CONTEXT_FILE, texts.get(CONTEXT_FILE) as string)
  const typeDecl = typeSf.statements.find(
    (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === 'FrameContext',
  )
  const haveTypes = new Map<string, string>()
  if (typeDecl && ts.isTypeLiteralNode(typeDecl.type))
    for (const m of typeDecl.type.members)
      if (ts.isPropertySignature(m) && ts.isIdentifier(m.name) && m.type)
        haveTypes.set(m.name.text, m.type.getText(typeSf))
  if (!typeDecl) fail('FrameContext type not found')
  console.log(`${'entry'.padEnd(22)} ${'value'.padEnd(18)} ${'source'.padEnd(18)} reassigned`)
  for (const e of CONTEXT) {
    const rows: string[] = []
    const src = o.scope.get(e.binds)
    if (!src) rows.push(`${e.binds} is not declared in createSocketClient`)
    const actuallyReassigned = reassigned.has(e.binds)
    if (actuallyReassigned !== e.reassigned)
      rows.push(`list says reassigned=${e.reassigned}, the source says ${actuallyReassigned}`)
    if (src) {
      if (!e.reassigned && src.kind === 'let') rows.push('a `let` is handed over by value')
      if (e.reassigned && src.kind !== 'let') rows.push('a getter for a variable that is not a `let`')
      // an entry that is a function: its type says Promise exactly when the source function is async
      const isFnType = /=>/.test(e.type) && !/^Map|^Set|^Return|^Store/.test(e.type)
      if (!e.reassigned && isFnType && src.async !== /=>\s*Promise</.test(e.type))
        rows.push(`async-ness: source async=${src.async}, type ${e.type}`)
    }
    const val = have.get(e.name)
    if (val === undefined) rows.push('missing from the object')
    else if (squashWs(val) !== squashWs(e.value)) rows.push(`value is ${val}; the list says ${e.value}`)
    const t = haveTypes.get(e.name)
    if (t === undefined) rows.push('missing from the FrameContext type')
    else if (squashWs(t).replace(/;/g, '') !== squashWs(e.type).replace(/;/g, ''))
      rows.push(`type is ${t}; the list says ${e.type}`)
    if (e.reassigned && !/^\(\)=>/.test(squashWs(e.value))) rows.push('a reassigned variable is not behind a function')
    if (!e.reassigned && e.value !== e.binds) rows.push('a variable that is never reassigned is wrapped')
    if (e.reassigned && e.name in GETTERS) rows.push('reserved')
    console.log(
      `${rows.length ? 'FAIL ' : 'ok   '}${e.name.padEnd(22)} ${e.value.replace(/\s+/g, ' ').padEnd(18)} ${(src ? `${src.kind}${src.async ? ' async' : ''}` : '?').padEnd(18)} ${actuallyReassigned ? 'YES (let, via function)' : 'no'}`,
    )
    for (const r of rows) {
      console.log(`      ${r}`)
      bad++
    }
  }
  for (const n of haveTypes.keys())
    if (!CONTEXT.some((e) => e.name === n)) fail(`FrameContext has an entry the list does not: ${n}`)
  // every reassigned variable that a handler reads is behind a getter, and the table covers them all
  for (const [v, g] of Object.entries(GETTERS))
    if (!CONTEXT.some((e) => e.name === g && e.binds === v && e.reassigned))
      fail(`getter ${g} for ${v} is not in the list`)

  // ---- 4. everything else in socketClient.ts is untouched
  console.log('\n== the rest of socketClient.ts')
  const restOrig = withoutMoved(o.sf, origText)
  const restNow = withoutMoved(now.sf, texts.get(MAIN) as string)
  const how = compareCode(restOrig, restNow)
  console.log(`${how === 'differs' ? 'FAIL ' : 'ok   '} everything but imports, the switch and ${CTX_VAR} is ${how}`)
  if (how === 'differs') bad++

  console.log(bad ? `\n${bad} problem(s)` : '\nall checks pass')
  return bad ? 1 : 0
}

/** Does the original case read `isCatchup`? */
function needsIsCatchup(c: Case): boolean {
  return usedNames(parse('x.ts', `function w(){\n${c.body}\n}`)).has('isCatchup')
}

const args = process.argv.slice(2)
if (args.includes('--check')) {
  const i = args.indexOf('--base')
  process.exit(check(i >= 0 ? (args[i + 1] as string) : 'origin/main'))
} else split()
