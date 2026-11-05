// Splits apps/relay/src/core/hub.ts by frame family. A move and nothing else: every handler keeps its text, and the class,
// its public surface and the dispatch stay in hub.ts, in the same order, with the same signature, device and card checks.
//
//   node scripts/split-hub.ts                      split the working tree's hub.ts (run on a fresh main checkout)
//   node scripts/split-hub.ts --check [--base origin/main]
//                                                  prove the split is a move: compare it with hub.ts at the base ref
//
// Unlike the bridge's inbound split, no member of Hub loses `private`. A moved handler is written as a method of an object
// with a `this: <Family>Ctx` parameter, so its body keeps every `this.` call as it was; `this` is a small context object
// that Hub builds in its constructor, holding only the state and functions that family uses.
//
// Rerun on a fresh checkout of main after main moves; it reads whatever hub.ts says now. A planned unit that is not found
// stops the script; a method the plan does not name stays where it is.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'apps', 'relay', 'src', 'core')
const MAIN = 'hub.ts'
const REL = `apps/relay/src/core/${MAIN}`

/** A whole class method that moves, or the body of one `case` of a switch method (which becomes a method of its own). */
type Unit =
  | { kind: 'method'; name: string }
  | { kind: 'case'; name: string; inMethod: string; labels: string[]; about: string }
type Family = { file: string; about: string; units: Unit[]; classes?: string[] }

const FAMILIES: Record<string, Family> = {
  chat: {
    file: 'hub-chat.ts',
    about: 'Owner messages and voice notes from an app.',
    units: [
      {
        kind: 'case',
        name: 'onOwnerMessage',
        inMethod: 'onAppFrameBuiltin',
        labels: ['message', 'voice_note'],
        about:
          'The `message` and `voice_note` frames: the signature-device check, the duplicate check, then stored and queued.',
      },
    ],
  },
  cards: {
    file: 'hub-cards.ts',
    about:
      'Card decisions: a tap in the app, a tap on a notification, and putting a card back when the Mac refuses it.',
    units: [
      {
        kind: 'case',
        name: 'onCardResolve',
        inMethod: 'onAppFrameBuiltin',
        labels: ['card.resolve'],
        about: 'The `card.resolve` frame: device check, duplicate check, step-up, then the card-state check.',
      },
      { kind: 'method', name: 'acceptNativeAct' },
      { kind: 'method', name: 'rollbackRejectedResolve' },
      { kind: 'method', name: 'nativeApproveCard' },
      { kind: 'method', name: 'putCardBackToPending' },
    ],
    classes: ['NativeRefusal'],
  },
  config: {
    file: 'hub-config.ts',
    about: 'Settings patches from an app.',
    units: [
      {
        kind: 'case',
        name: 'onConfigPatch',
        inMethod: 'onAppFrameBuiltin',
        labels: ['config.patch'],
        about:
          'The `config.patch` frame: device check, duplicate check, field check, then the step-up the field needs.',
      },
    ],
  },
  history: {
    file: 'hub-history.ts',
    about:
      'Signed history reads and media re-uploads, routed to the Mac and the answer routed back to the asking socket.',
    units: [
      { kind: 'method', name: 'readBudget' },
      { kind: 'method', name: 'history' },
      {
        kind: 'case',
        name: 'onMediaFetch',
        inMethod: 'onAppFrameBuiltin',
        labels: ['media.fetch'],
        about: 'The `media.fetch` frame: device check, read budget, id check, then forwarded to the Mac.',
      },
    ],
  },
  undelivered: {
    file: 'hub-undelivered.ts',
    about: 'Owner frames the Mac never took: the report before the sweep deletes them, and the day-6 warning.',
    units: [
      { kind: 'method', name: 'decisionCard' },
      { kind: 'method', name: 'cardDecidedOnMac' },
      { kind: 'method', name: 'reportUndelivered' },
      { kind: 'method', name: 'warnDeadMac' },
    ],
  },
}

/** Hub names the family files import from hub.ts. These were already top-level in hub.ts; two gain `export`. */
const HUB_EXPORTS = ['AppConn', 'Ref', 'Hub', 'HubDeps']
/** Types that gain `export` in hub.ts so the family files can name them. Nothing else about them changes. */
const NEWLY_EXPORTED = ['AppConn', 'Ref']

/**
 * What a handler may reach through `this`. A field has a `value` (the expression in Hub's constructor); a function has none
 * and forwards to the Hub method of that name. Private members stay private: Hub hands them out here, one by one.
 */
const MEMBERS: Record<string, { type: string; value?: string }> = {
  d: { type: 'HubDeps', value: 'd' },
  historyReqs: { type: 'Map<string, Ref & { frameId: string }>', value: 'this.historyReqs' },
  historyFrameIds: { type: 'Map<string, number>', value: 'this.historyFrameIds' },
  bridgeFeatures: { type: 'BridgeFeatures', value: 'this.bridgeFeatures' },
  readLimits: { type: 'RateLimiter', value: 'this.readLimits' },
  ownerDeviceOk: { type: 'ownerDeviceOk(a: AppConn, deviceId: string, frameId: string): boolean' },
  acceptOwner: {
    type: 'acceptOwner(a: AppConn, frame: { id: string; type: string }, raw: Record<string, unknown>, threadId: string | null, extraKeys?: string[], alsoWrite?: () => void): StoredFrame | null',
  },
  appError: { type: 'appError(a: AppConn, code: string, message: string, ref?: unknown): void' },
  sendApp: { type: 'sendApp(a: AppConn, frame: Record<string, unknown>): void' },
  sendBridge: { type: 'sendBridge(frame: Record<string, unknown>): void' },
  fanOut: { type: 'fanOut(frame: Record<string, unknown>, onlyDeviceId?: string, except?: string): void' },
  stampForApps: { type: 'stampForApps(frame: Record<string, unknown>): StoredFrame' },
  enqueueRow: { type: 'enqueueRow(stamped: StoredFrame, ttlMs: number): void' },
  afterEnqueue: { type: 'afterEnqueue(stamped: StoredFrame): void' },
  rememberRef: {
    type: 'rememberRef(frameId: string, a: AppConn, threadId: string | null, volatile?: boolean): void',
  },
  expireCard: { type: 'expireCard(card: CardT): void' },
  bridgeOnline: { type: 'bridgeOnline(): boolean' },
  agentConfig: { type: 'agentConfig(): ReturnType<Hub["agentConfig"]>' },
  cfg: { type: 'cfg(): NonNullable<ReturnType<Hub["agentConfig"]>> | typeof DEFAULT_AGENT_CONFIG' },
  notify: { type: 'notify(intent: Parameters<HubDeps["push"]["notify"]>[0], rich?: RichPushInput): void' },
  clearQueuedTimer: { type: 'clearQueuedTimer(msgId: string): void' },
  pruneHistoryReqs: { type: 'pruneHistoryReqs(): void' },
  eventMessage: { type: 'eventMessage(f: StoredFrame): MessageT | null' },
  bridgeIsTwoStage: { type: 'bridgeIsTwoStage(): boolean' },
  // members of a family that another family (or the same one) calls
  readBudget: { type: "readBudget(a: AppConn, name: 'history' | 'media_fetch', ref: string): boolean" },
  nativeApproveCard: { type: 'nativeApproveCard(body: unknown): string | undefined' },
  putCardBackToPending: { type: 'putCardBackToPending(cardId: string, reason: string): void' },
  decisionCard: { type: 'decisionCard(type: string, f: Record<string, unknown>): string | undefined' },
  cardDecidedOnMac: { type: 'cardDecidedOnMac(type: string, f: Record<string, unknown>): boolean' },
}

const Cap = (s: string) => s[0]?.toUpperCase() + s.slice(1)
const objName = (key: string) => `${key}Frames`
const ctxField = (key: string) => `${key}Ctx`
const ctxType = (key: string) => `${Cap(key)}Ctx`

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
    if ((ts.isFunctionDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st)) && st.name)
      names.push(st.name.text)
    for (const name of names) out.set(name, { name, start: attachedStart(sf, st), end: st.end, node: st })
  }
  return out
}

function classOf(sf: ts.SourceFile): ts.ClassDeclaration {
  const c = sf.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === 'Hub')
  if (!c) throw new Error('class Hub not found in hub.ts')
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
    out.push({ text: st.getText(sf), typeOnly: !!clause?.isTypeOnly, from, named })
  }
  return out
}

/** The import lines a file needs: the original imports cut down to what its code uses, plus extra lines. */
function importBlock(orig: Import[], code: string, extra: string[]): string {
  const used = usedNames(parse('x.ts', code))
  const lines: string[] = []
  for (const imp of orig) {
    if (imp.named.length === 0) continue // hub.ts has no side-effect or namespace import
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

/** Members reached through `this` inside a node (this.x, and this.x(...)). */
function thisMembers(node: ts.Node): Set<string> {
  const out = new Set<string>()
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword) out.add(n.name.text)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

const hasAwait = (node: ts.Node): boolean => {
  let found = false
  const visit = (n: ts.Node) => {
    if (ts.isAwaitExpression(n)) found = true
    else if (!ts.isFunctionLike(n) || n === node) ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/** The `case` clauses of the switch inside a method, the one with these labels, and its block. */
function findCase(_sf: ts.SourceFile, cls: ts.ClassDeclaration, inMethod: string, labels: string[]) {
  const m = cls.members.find(
    (x): x is ts.MethodDeclaration => ts.isMethodDeclaration(x) && ts.isIdentifier(x.name) && x.name.text === inMethod,
  )
  if (!m?.body) throw new Error(`method ${inMethod} not found in hub.ts`)
  let found: { clause: ts.CaseClause; block: ts.Block } | undefined
  const visit = (n: ts.Node) => {
    if (ts.isSwitchStatement(n)) {
      const cl = n.caseBlock.clauses
      for (let i = 0; i < cl.length; i++) {
        const c = cl[i] as ts.CaseOrDefaultClause
        if (!ts.isCaseClause(c) || !ts.isStringLiteral(c.expression) || c.expression.text !== labels[0]) continue
        // the labels are consecutive clauses; the block is on the last one
        const run = labels.map((_, j) => cl[i + j])
        const okLabels = run.every(
          (x, j) => x && ts.isCaseClause(x) && ts.isStringLiteral(x.expression) && x.expression.text === labels[j],
        )
        const last = run[labels.length - 1]
        if (!okLabels || !last || !ts.isCaseClause(last)) continue
        const block = last.statements[0]
        if (last.statements.length !== 1 || !block || !ts.isBlock(block))
          throw new Error(`case ${labels.join(' / ')} is not a single block`)
        found = { clause: last, block }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(m.body)
  if (!found) throw new Error(`case ${labels.join(' / ')} not found in ${inMethod}`)
  return found
}

const PREAMBLE = 'const store = this.d.store'

/** Text of a block's statements, from the first statement (with its comments) to the end of the last. */
function blockInner(sf: ts.SourceFile, block: ts.Block): string {
  return sf.text
    .slice(block.getStart(sf) + 1, block.end - 1)
    .replace(/^\s*\n/, '')
    .trimEnd()
}

function dedent(t: string, by: number): string {
  return t
    .split('\n')
    .map((l) => l.replace(new RegExp(`^ {0,${by}}`), ''))
    .join('\n')
}

function split() {
  const mainPath = join(srcDir, MAIN)
  const text = readFileSync(mainPath, 'utf8')
  if (text.includes(`./${FAMILIES.chat?.file}`)) {
    console.log('hub.ts is already split; start from a fresh main checkout.')
    return
  }
  const sf = parse(MAIN, text)
  const cls = classOf(sf)
  const methods = methodsOf(sf, cls)
  const tops = topLevel(sf)
  const origImports = importsOf(sf)
  const topNames = new Set(tops.keys())

  const edits: Array<{ start: number; end: number; text: string }> = []
  const forwarders: string[] = []
  const bodies = new Map<string, string>()
  const ctxMembers = new Map<string, Set<string>>()

  for (const [key, fam] of Object.entries(FAMILIES)) {
    const parts: string[] = []
    const reached = new Set<string>()
    for (const unit of fam.units) {
      if (unit.kind === 'method') {
        const piece = methods.get(unit.name)
        if (!piece) throw new Error(`planned method ${unit.name} is not in hub.ts; update FAMILIES`)
        const m = piece.node as ts.MethodDeclaration
        for (const x of thisMembers(m)) reached.add(x)
        const open = m.parameters.pos - 1 // the "(" of the parameter list
        if (text[open] !== '(') throw new Error(`cannot find the parameter list of ${unit.name}`)
        const head = text.slice(piece.start, m.getStart(sf))
        const mods = (m.modifiers ?? [])
          .filter((x) => x.kind !== ts.SyntaxKind.PrivateKeyword)
          .map((x) => x.getText(sf))
        const typeParams = m.typeParameters ? text.slice(m.typeParameters.pos - 1, m.typeParameters.end + 1) : ''
        const params = m.parameters.length ? `this: ${ctxType(key)}, ` : `this: ${ctxType(key)}`
        parts.push(
          `${head}${[...mods, ''].join(' ')}${unit.name}${typeParams}(${params}${text.slice(open + 1, m.end)},`,
        )
        edits.push({ start: piece.start, end: piece.end, text: '' })
        const isPrivate = (m.modifiers ?? []).some((x) => x.kind === ts.SyntaxKind.PrivateKeyword)
        forwarders.push(
          `  ${isPrivate ? 'private ' : ''}${unit.name}(...args: Parameters<typeof ${objName(key)}.${unit.name}>) {\n    return ${objName(key)}.${unit.name}.apply(this.${ctxField(key)}, args)\n  }`,
        )
      } else {
        const { clause, block } = findCase(sf, cls, unit.inMethod, unit.labels)
        for (const x of thisMembers(block)) reached.add(x)
        const inner = blockInner(sf, block)
        const usesStore = usedNames(parse('x.ts', `function f() {\n${inner}\n}`)).has('store')
        const isAsync = hasAwait(block)
        const frameType = `FrameOf<${unit.labels.map((l) => `'${l}'`).join(' | ')}>`
        const ret = isAsync ? ': Promise<void>' : '' // a bare `void` annotation makes Biome refuse the `return f()` lines
        parts.push(
          `  /** ${unit.about} The \`case\` of that name in Hub.${unit.inMethod}. */\n  ${isAsync ? 'async ' : ''}${unit.name}(this: ${ctxType(key)}, a: AppConn, frame: ${frameType}, raw: Record<string, unknown>)${ret} {\n${usesStore ? `    ${PREAMBLE}\n` : ''}${dedent(inner, 4)}\n  },`,
        )
        edits.push({
          start: block.getStart(sf),
          end: block.end,
          text: `\n return ${objName(key)}.${unit.name}.call(this.${ctxField(key)}, a, frame, raw)`,
        })
        void clause
      }
    }
    // top-level declarations that travel with the family
    let code = `export const ${objName(key)} = {\n${parts.join('\n\n')}\n}\n`
    for (const name of fam.classes ?? []) {
      const p = tops.get(name)
      if (!p) throw new Error(`planned declaration ${name} is not in hub.ts; update FAMILIES`)
      code += `\n${text.slice(p.start, p.end)}\n`
      edits.push({ start: p.start, end: p.end, text: '' })
    }
    // Every `this.x` must be something Hub hands out; the context type lists exactly those.
    for (const x of reached)
      if (!MEMBERS[x]) throw new Error(`${key}: this.${x} is not in MEMBERS; add it with its type`)
    ctxMembers.set(key, reached)
    const order = Object.keys(MEMBERS).filter((x) => reached.has(x))
    const ctxDecl = `/** What the ${key} handlers use of Hub, and nothing else. Hub builds it in its constructor. */\nexport type ${ctxType(key)} = {\n${order
      .map((x) => {
        const mem = MEMBERS[x] as { type: string; value?: string }
        return mem.value ? `  ${x}: ${mem.type}` : `  ${mem.type}`
      })
      .join('\n')}\n}\n`
    bodies.set(key, `${ctxDecl}\n${code}`)
  }

  // Names that moved code uses from hub.ts's own top level must be exported or moved with it.
  const written: string[] = []
  for (const [key, fam] of Object.entries(FAMILIES)) {
    const code = bodies.get(key) as string
    const used = usedNames(parse('x.ts', code))
    for (const n of topNames) {
      if (!used.has(n) || (fam.classes ?? []).includes(n) || HUB_EXPORTS.includes(n)) continue
      // a name hub.ts imports is in the import block; one it declares must be planned
      if (!origImports.some((i) => i.named.some((x) => x.name === n)))
        throw new Error(`${key} uses ${n} from hub.ts's top level; plan it (export it or move it)`)
    }
    const hubNames = HUB_EXPORTS.filter((n) => used.has(n))
    const hubType = ['AppConn', 'Ref', 'Hub', 'HubDeps'].filter((n) => hubNames.includes(n))
    const extra = hubType.length ? [`import type { ${hubType.join(', ')} } from './${MAIN}'`] : []
    const out = `// ${fam.about}\n// Handlers of the Hub class (hub.ts), which forwards to them. Dispatch and the first trust checks are in hub.ts; some\n// handlers here run their own device, seen-id, step-up or card-state checks, so read both when auditing trust.\n${importBlock(origImports, code, extra)}\n${code}`
    writeFileSync(join(srcDir, fam.file), out)
    written.push(fam.file)
  }

  // ---- hub.ts: apply the edits, add forwarders and the context objects
  let rest = text
  // the class gets: fields for the contexts, the contexts built at the end of the constructor, forwarders at the end
  const ctor = cls.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration
  const ctorEnd = (ctor.body as ts.Block).end - 1
  const schedulesDecl = cls.members.find(
    (m): m is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === 'schedules',
  ) as ts.PropertyDeclaration
  edits.push({
    start: schedulesDecl.end,
    end: schedulesDecl.end,
    text: `\n${Object.keys(FAMILIES)
      .map((k) => `  private ${ctxField(k)}: ${ctxType(k)}`)
      .join('\n')}`,
  })
  const ctxBuilds = Object.keys(FAMILIES)
    .map((key) => {
      const reached = ctxMembers.get(key) as Set<string>
      const order = Object.keys(MEMBERS).filter((x) => reached.has(x))
      const lines = order.map((x) => {
        const mem = MEMBERS[x] as { type: string; value?: string }
        if (mem.value) return mem.value === x ? `      ${x},` : `      ${x}: ${mem.value},`
        const decl = parse('x.ts', `type T = {\n${mem.type}\n}`)
        const sig = (decl.statements[0] as ts.TypeAliasDeclaration).type as ts.TypeLiteralNode
        const names = ((sig.members[0] as ts.MethodSignature).parameters ?? []).map(
          (p) => (p.name as ts.Identifier).text,
        )
        return `      ${x}: (${names.join(', ')}) => this.${x}(${names.join(', ')}),`
      })
      return `    this.${ctxField(key)} = {\n${lines.join('\n')}\n    }`
    })
    .join('\n')
  edits.push({ start: ctorEnd, end: ctorEnd, text: `\n${ctxBuilds}\n  ` })

  // newly exported types
  for (const n of NEWLY_EXPORTED) {
    const p = tops.get(n)
    if (!p) throw new Error(`type ${n} not found in hub.ts`)
    const st = p.node as ts.Statement
    edits.push({ start: st.getStart(sf), end: st.getStart(sf), text: 'export ' })
  }

  // the import block is rebuilt
  const importStmts = sf.statements.filter(ts.isImportDeclaration)
  const importsStart = (importStmts[0] as ts.ImportDeclaration).getStart(sf)
  const importsEnd = (importStmts[importStmts.length - 1] as ts.ImportDeclaration).end
  edits.push({ start: importsStart, end: importsEnd, text: '@@IMPORTS@@' })

  const closeAt = cls.end - 1
  const banner =
    '  // ---- frame families ------------------------------------------------------------------------------------------\n' +
    '  // The handlers live in hub-*.ts, one file per family, and run on a small context object (see `this.*Ctx`). Each\n' +
    '  // method here forwards to its handler with the same arguments.\n\n'
  edits.push({ start: closeAt, end: closeAt, text: `\n${banner}${forwarders.join('\n\n')}\n` })

  edits.sort((a, b) => b.start - a.start || b.end - a.end)
  for (const e of edits) rest = rest.slice(0, e.start) + e.text + rest.slice(e.end)

  const familyImports = Object.entries(FAMILIES).map(
    ([key, fam]) =>
      `import { ${objName(key)} } from './${fam.file}'\nimport type { ${ctxType(key)} } from './${fam.file}'`,
  )
  const block = importBlock(origImports, rest.replace('@@IMPORTS@@', ''), []).trimEnd()
  rest = rest.replace('@@IMPORTS@@', `${block}\n${familyImports.join('\n')}`)
  rest = rest.replace(/\n{3,}/g, '\n\n')
  writeFileSync(mainPath, rest)
  written.push(MAIN)

  try {
    biome(written.map((f) => join(srcDir, f)))
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer }
    console.log(String(err.stdout ?? ''), String(err.stderr ?? ''))
    throw e
  }
  console.log(`wrote ${written.join(', ')}`)
}

// ---------------------------------------------------------------------------------------------------------------------
// --check: the split is a move

const show = (ref: string): string =>
  execFileSync('git', ['show', `${ref}:${REL}`], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 })

type Member = { header: string; rest: string; comments: string; params: string; tail: string }

function describeMember(sf: ts.SourceFile, node: ts.Node, start: number): Member {
  const text = sf.text
  const m = node as ts.MethodDeclaration
  const open = m.parameters.pos - 1
  return {
    comments: text.slice(start, m.getStart(sf)),
    header: text.slice(m.getStart(sf), open).replace(/^(private |public )/, ''),
    rest: text.slice(open, m.end),
    // the parameter list (whitespace does not count: a longer list is wrapped by Biome) and everything after it, exact
    params: text.slice(open + 1, m.parameters.end),
    tail: text.slice(m.parameters.end, m.end),
  }
}

/** Class methods of Hub, and methods of the `xFrames` objects, by name. */
function collect(sf: ts.SourceFile): Map<string, Member> {
  const out = new Map<string, Member>()
  const add = (m: ts.MethodDeclaration) => {
    if (ts.isIdentifier(m.name)) out.set(m.name.text, describeMember(sf, m, attachedStart(sf, m)))
  }
  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st) && st.name?.text === 'Hub')
      for (const m of st.members) if (ts.isMethodDeclaration(m)) add(m)
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (d.initializer && ts.isObjectLiteralExpression(d.initializer))
          for (const m of d.initializer.properties) if (ts.isMethodDeclaration(m)) add(m)
  }
  return out
}

/** Whitespace and trailing commas do not count: re-indenting a block can let Biome join lines. Words, quotes and comments do. */
const norm = (s: string) => s.replace(/\s+/g, '').replace(/,([)\]}])/g, '$1')

/** Lines of a file outside import declarations, trimmed and without blanks. */
function codeLines(name: string, text: string): string[] {
  const sf = parse(name, text)
  let t = text
  for (const st of [...sf.statements].reverse())
    if (ts.isImportDeclaration(st)) t = t.slice(0, st.getStart(sf)) + t.slice(st.end)
  return t
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/^export /, '')
        .replace(/^(case [^:]*:) \{$/, '$1'),
    )
    .filter(Boolean)
}

const modsOf = (m: ts.ClassElement | ts.ParameterDeclaration) =>
  (ts.canHaveModifiers(m) ? (ts.getModifiers(m) ?? []) : [])
    .map((x) => x.getText())
    .sort()
    .join(' ')

function check(base: string): number {
  const origText = show(base)
  const origSf = parse(MAIN, origText)
  const origCls = classOf(origSf)
  const orig = collect(origSf)
  const files = [MAIN, ...Object.values(FAMILIES).map((f) => f.file)]
  const texts = new Map(files.map((f) => [f, existsSync(join(srcDir, f)) ? readFileSync(join(srcDir, f), 'utf8') : '']))
  const rows: string[] = []
  let bad = 0
  const fail = (s: string) => {
    rows.push(s)
    bad++
  }

  const hubSf = parse(MAIN, texts.get(MAIN) as string)
  const hubCls = classOf(hubSf)
  const hubMembers = collect(hubSf)
  const famMembers = new Map<string, Map<string, Member>>()
  const famSf = new Map<string, ts.SourceFile>()
  for (const [key, fam] of Object.entries(FAMILIES)) {
    const t = texts.get(fam.file) as string
    if (!t) {
      fail(`MISSING FILE ${fam.file}`)
      continue
    }
    famSf.set(key, parse(fam.file, t))
    famMembers.set(key, collect(famSf.get(key) as ts.SourceFile))
  }

  const origMethodNames = new Set(orig.keys())
  let identical = 0
  let movedMethods = 0
  let movedCases = 0
  const excluded = new Set<string>() // original lines that belong to a moved unit, compared above instead

  for (const [key, fam] of Object.entries(FAMILIES)) {
    const fm = famMembers.get(key)
    if (!fm) continue
    for (const unit of fam.units) {
      const moved = fm.get(unit.name)
      if (!moved) {
        fail(`MISSING   ${unit.name} (not in ${fam.file})`)
        continue
      }
      // the forwarder in hub.ts calls this family's own handler, and nobody else's
      if (unit.kind === 'method') {
        const o = orig.get(unit.name)
        const fwd = hubMembers.get(unit.name)
        if (!o) {
          fail(`MISSING   ${unit.name} (not in ${base})`)
          continue
        }
        const want = `{returnxFrames.${unit.name}.apply(this.xCtx,args)}`
          .replaceAll('xFrames', objName(key))
          .replaceAll('xCtx', ctxField(key))
        if (!fwd || norm(fwd.rest.slice(fwd.rest.indexOf('{'))) !== norm(want))
          fail(`FORWARDER ${unit.name} does not call ${objName(key)}.${unit.name}`)
        else if (norm(fwd.header) !== norm(`${unit.name}`) && !fwd.header.startsWith(unit.name))
          fail(`FORWARDER ${unit.name} header ${fwd.header}`)
        const movedParams = moved.params.replace(new RegExp(`^\\s*this: ${ctxType(key)},?\\s*`), '')
        const tailOk = o.tail === moved.tail.replace(/,$/, '')
        const ok =
          o.comments === moved.comments && o.header === moved.header && norm(o.params) === norm(movedParams) && tailOk
        if (ok) {
          identical++
          movedMethods++
        } else {
          fail(`DIFFERS   ${unit.name} (${fam.file})`)
          if (o.comments !== moved.comments) rows.push('   comments differ')
          if (o.header !== moved.header)
            rows.push(`   header: ${JSON.stringify(o.header)} -> ${JSON.stringify(moved.header)}`)
          if (!tailOk || norm(o.params) !== norm(movedParams)) rows.push('   parameters or body differ')
        }
        const op = methodsOf(origSf, origCls).get(unit.name) as Piece
        for (const l of origText
          .slice(op.start, op.end)
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean))
          excluded.add(l)
      } else {
        // a case block: the original block's text must equal the new method's body, apart from the one added line
        const { block } = findCase(origSf, origCls, unit.inMethod, unit.labels)
        const origInner = blockInner(origSf, block)
        const fsf = famSf.get(key) as ts.SourceFile
        let method: ts.MethodDeclaration | undefined
        const visit = (n: ts.Node) => {
          if (
            ts.isMethodDeclaration(n) &&
            ts.isIdentifier(n.name) &&
            n.name.text === unit.name &&
            !ts.isClassDeclaration(n.parent)
          )
            method = n
          ts.forEachChild(n, visit)
        }
        visit(fsf)
        if (!method?.body) {
          fail(`MISSING   ${unit.name} body`)
          continue
        }
        const newInner = blockInner(fsf, method.body).replace(/^\s*const store = this\.d\.store\s*\n/, '')
        const usedPreamble = blockInner(fsf, method.body).trimStart().startsWith(PREAMBLE)
        const origUsesStore = usedNames(parse('x.ts', `function f() {\n${origInner}\n}`)).has('store')
        if (usedPreamble !== origUsesStore)
          fail(`DIFFERS   ${unit.name}: the added "${PREAMBLE}" line is ${usedPreamble ? 'unneeded' : 'missing'}`)
        if (norm(origInner) !== norm(newInner)) {
          fail(`DIFFERS   ${unit.name} (${fam.file}): block text differs`)
        } else {
          identical++
          movedCases++
        }
        // the dispatch in hub.ts: the same labels, now one call to this family's handler with the same arguments
        const { block: hubBlockOrNone, clause } = (() => {
          try {
            const r = findCaseCall(hubSf, hubCls, unit.inMethod, unit.labels)
            return r
          } catch (e) {
            fail(`DISPATCH  ${unit.name}: ${(e as Error).message}`)
            return { block: undefined, clause: undefined }
          }
        })()
        void hubBlockOrNone
        if (clause) {
          const want = `return${objName(key)}.${unit.name}.call(this.${ctxField(key)},a,frame,raw)`
          const got = clause.statements.map((s) => s.getText(hubSf)).join('')
          if (norm(got) !== norm(want))
            fail(
              `DISPATCH  ${unit.name}: case ${unit.labels.join(' / ')} does not call ${objName(key)}.${unit.name} (${got})`,
            )
        }
        for (const l of origInner
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean))
          excluded.add(l)
      }
    }
    for (const name of fam.classes ?? []) {
      const o = topLevel(origSf).get(name)
      const n = topLevel(famSf.get(key) as ts.SourceFile).get(name)
      if (!o || !n || origText.slice(o.start, o.end) !== (texts.get(fam.file) as string).slice(n.start, n.end))
        fail(`DIFFERS   class ${name}`)
      else identical++
    }
  }

  // nothing is public that was private: every member of Hub that is still there has the modifiers it had
  const origMods = new Map<string, string>()
  for (const m of origCls.members) if (m.name && ts.isIdentifier(m.name)) origMods.set(m.name.text, modsOf(m))
  let loosened = 0
  for (const m of hubCls.members) {
    if (!m.name || !ts.isIdentifier(m.name)) continue
    const was = origMods.get(m.name.text)
    if (was === undefined) {
      if (!Object.keys(FAMILIES).map(ctxField).includes(m.name.text)) fail(`NEW MEMBER ${m.name.text}`)
      else if (modsOf(m) !== 'private') fail(`NEW MEMBER ${m.name.text} is not private`)
      continue
    }
    if (was !== modsOf(m)) {
      loosened++
      fail(`MODIFIERS CHANGED ${m.name.text}: "${was}" -> "${modsOf(m)}"`)
    }
  }
  for (const n of origMods.keys())
    if (!hubCls.members.some((m) => m.name && ts.isIdentifier(m.name) && m.name.text === n)) fail(`MEMBER GONE ${n}`)

  // Every other method is untouched: same comments, header and text, except the dispatch method whose cases were swapped
  const moved = new Set(
    Object.values(FAMILIES).flatMap((f) => f.units.filter((u) => u.kind === 'method').map((u) => u.name)),
  )
  const casesIn = new Set(
    Object.values(FAMILIES).flatMap((f) =>
      f.units.filter((u) => u.kind === 'case').map((u) => (u as { inMethod: string }).inMethod),
    ),
  )
  let untouched = 0
  for (const name of origMethodNames) {
    if (moved.has(name) || casesIn.has(name)) continue
    const o = orig.get(name) as Member
    const n = hubMembers.get(name)
    if (n && o.comments === n.comments && o.header === n.header && o.rest === n.rest) untouched++
    else fail(`DIFFERS   ${name} (stayed in hub.ts, must be untouched)`)
  }

  // Independent of the per-function view: every code line outside imports, before and after. Original lines that sit in a
  // moved unit were compared above; every other original line must still be in the split, and what the split adds must be glue.
  const count = (lines: string[]) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>())
  const origLines = codeLines(MAIN, origText)
  const before = count(origLines)
  const after = count([...texts].flatMap(([f, t]) => codeLines(f, t)))
  const removed: string[] = []
  for (const [l, c] of before)
    if ((after.get(l) ?? 0) < c && !excluded.has(l)) removed.push(`${c - (after.get(l) ?? 0)}x ${l}`)
  const hubAfter = count(codeLines(MAIN, texts.get(MAIN) as string))
  const glue: RegExp[] = [
    /^\/\/ ----/,
    /^\/\/ (The handlers live|method here forwards|Hub hands)/,
    /^\/\*\* .* \*\/$/,
    /^(private )?[a-zA-Z]+\(\.\.\.args: Parameters<typeof [a-z]+Frames\.[a-zA-Z]+>\) \{$/,
    /^return [a-z]+Frames\.[a-zA-Z]+\.(apply|call)\(this\.[a-z]+Ctx, (args|a, frame, raw)\)$/,
    /^private [a-z]+Ctx: [A-Za-z]+Ctx$/,
    /^this\.[a-z]+Ctx = \{$/,
    /^[a-zA-Z]+: [^=]*,$/,
    /^[a-zA-Z]+: \([a-zA-Z, ]*\) => this\.[a-zA-Z]+\([a-zA-Z, ]*\),$/,
    /^[a-zA-Z]+,$/,
    /^\}$/,
    /^[a-zA-Z]+: \([a-zA-Z, ]*\) =>$/,
    /^this\.[a-zA-Z]+\([a-zA-Z, ]*\),$/,
    /^export (type|interface) /,
    /^export type /,
  ]
  const unexplained: string[] = []
  for (const [l, c] of hubAfter)
    if ((before.get(l) ?? 0) < c) {
      const bare = l.replace(/^export /, '')
      if ((before.get(bare) ?? 0) >= c) continue // only `export` was added to a type
      if (!glue.some((g) => g.test(l))) unexplained.push(`${c - (before.get(l) ?? 0)}x ${l}`)
    }
  void unexplained // reported below
  if (removed.length) bad++
  if (unexplained.length) bad++

  console.log(`compared with ${base}:${REL}`)
  console.log(`${orig.size} methods in the original; ${untouched} stayed in hub.ts byte-identical`)
  console.log(
    `${movedMethods} whole methods moved byte-identical (header, comments, text from "("; a dropped \`private\` is allowed, the \`this: <Family>Ctx\` parameter is the only text added)`,
  )
  console.log(
    `${movedCases} switch cases moved; compared as text ignoring whitespace and trailing commas (re-indenting lets Biome join lines); only the added \`${PREAMBLE}\` line differs`,
  )
  console.log(`${identical} moved blocks identical; members of Hub that lost "private" or gained anything: ${loosened}`)
  for (const r of rows) console.log(r)
  console.log(`\noriginal lines (outside imports and moved units) missing from the split: ${removed.length}`)
  for (const l of removed) console.log(`  - ${l}`)
  console.log(`lines added to hub.ts that are not forwarder or context glue: ${unexplained.length}`)
  for (const l of unexplained) console.log(`  + ${l}`)
  return bad ? 1 : 0
}

/** In the split hub.ts the case clause (last label) now holds the forwarding call; find it by its labels. */
function findCaseCall(_sf: ts.SourceFile, cls: ts.ClassDeclaration, inMethod: string, labels: string[]) {
  const m = cls.members.find(
    (x): x is ts.MethodDeclaration => ts.isMethodDeclaration(x) && ts.isIdentifier(x.name) && x.name.text === inMethod,
  )
  if (!m?.body) throw new Error(`method ${inMethod} not found`)
  let clause: ts.CaseClause | undefined
  const visit = (n: ts.Node) => {
    if (ts.isSwitchStatement(n)) {
      const cl = n.caseBlock.clauses
      for (let i = 0; i < cl.length; i++) {
        const c = cl[i] as ts.CaseOrDefaultClause
        if (!ts.isCaseClause(c) || !ts.isStringLiteral(c.expression) || c.expression.text !== labels[0]) continue
        const run = labels.map((_, j) => cl[i + j])
        const ok = run.every(
          (x, j) => x && ts.isCaseClause(x) && ts.isStringLiteral(x.expression) && x.expression.text === labels[j],
        )
        const last = run[labels.length - 1]
        if (ok && last && ts.isCaseClause(last)) clause = last
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(m.body)
  if (!clause) throw new Error(`case ${labels.join(' / ')} not found in ${inMethod}`)
  return { block: undefined, clause }
}

const args = process.argv.slice(2)
if (args.includes('--check')) {
  const i = args.indexOf('--base')
  process.exit(check(i >= 0 ? (args[i + 1] as string) : 'origin/main'))
} else split()
