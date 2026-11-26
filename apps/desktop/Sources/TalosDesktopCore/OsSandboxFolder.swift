import CryptoKit
import Foundation

/// The OS sandbox and the session's own folder (OsSandbox.swift; the twin of os-sandbox-folder.ts). The folder is the session's cwd, so it is
/// writable, and Claude Code RUNS OUTSIDE the sandbox what the settings and `.mcp.json` name: hook commands, the status line, helper programs
/// and stdio MCP servers. A session that could change one (or what it loads) would run its own code unsandboxed at the next tool call. So:
///  (1) the fixed protected paths are unwritable (`denyWrite`): the folder's `.claude`, `.mcp.json`, the kit's links and the instruction files,
///      the owner's `~/Library/LaunchAgents` and the kit release, each by real path (a symlink in the folder by its own name);
///  (2) a command from the PROJECT or LOCAL settings (the folder's and its git root's) or from `.mcp.json` is allowed only when it is the kit
///      release's own (reached through the folder's `hooks`/`scripts`/`kit` link, or the release itself): anything else refuses the start and
///      says to move it to the owner's user settings; a remote (http/sse) MCP server runs nothing here and is fine;
///  (3) a command from the owner's USER settings is allowed only as an absolute path to a file outside the session folder and every folder a
///      session can write (the temp roots), with nothing that depends on the working folder (npx, uvx, bunx, `bun x`, `-m`, a relative script);
///  (4) a start is refused when the kit's link is gone, when a settings file carries a `sandbox` key outside the short allow-list, a
///      `permissions.additionalDirectories`, or an Edit/Write allow rule with a path.
///  (5) the one server Talos itself writes into `.mcp.json`, `talos-app`, is allowed only as exactly `<bun> --no-env-file --config=<bridge bunfig>
///      <bridge server.ts>`, with the bun and the bridge Talos recorded in a place the sandbox cannot write (`TrustedBridge`), and an env of
///      only the keys Talos writes: bun reads `bunfig.toml` (a preload that runs code) and `.env*` from its working folder, which is the
///      writable session folder, unless it is told not to (measured, docs/SECURITY.md).
/// A file or command that is refused is never "protected instead": there is no folder-of-the-script deny any more.
enum OsSandboxFolder {
  private typealias P = OsSandboxPaths
  /// Names in a session's folder that are protected when they exist (the kit's links, the settings, the instruction files, a lead's marker).
  static let folderNames = ["hooks", "scripts", "kit", ".mcp.json", "CLAUDE.md", "AGENTS.md", ".talos-lead"]
  /// Protected even when absent: a session that created either would have settings or servers run outside the sandbox.
  static let alwaysNames = [".claude", ".mcp.json"]
  /// The kit folders the settings' hooks run scripts from.
  static let kitLinks = ["hooks", "scripts"]
  /// The names the kit install links into the release (`kit` too where present).
  static let kitNames = ["hooks", "scripts", "kit"]

  /// The kit's vendor folder (releases, `current`, the lock): the same place kit/scripts/plugin-release.py puts it (kitVendorDir in talos.ts).
  /// `env` is the session's own login environment (where `claudeDir` comes from), never the app's: a GUI process has none of the owner's variables.
  static func defaultKitDir(userHome: String, env: [String: String] = [:]) -> String {
    let base = env["TALOS_VENDOR_DIR"] ?? ((env["XDG_DATA_HOME"] ?? userHome + "/.local/share") + "/talos")
    return env["TALOS_KIT_HOME"] ?? base + "/kit"
  }

  private static func readJSON(_ path: String) -> [String: Any]? {
    guard let d = FileManager.default.contents(atPath: path) else { return nil }
    return SettingsJSON.object(d)
  }

  /// The settings files a session loads from `dir` that it could write: project and local.
  private static func projectSettings(_ dir: String) -> [(name: String, file: String)] {
    ["settings.json", "settings.local.json"].map { ($0, dir + "/.claude/" + $0) }
  }

  /// Every command string of a settings object: hooks (by event name, so the order is the same every run), the status line, and the helpers
  /// Claude Code runs.
  private static func settingsCommands(_ s: [String: Any]) -> [String] {
    var out: [String] = []
    let hooks = s["hooks"] as? [String: Any] ?? [:]
    for event in hooks.keys.sorted() {
      for g in (hooks[event] as? [Any] ?? []) {
        for h in ((g as? [String: Any])?["hooks"] as? [Any] ?? []) {
          if let c = (h as? [String: Any])?["command"] as? String { out.append(c) }
        }
      }
    }
    if let line = (s["statusLine"] as? [String: Any])?["command"] as? String { out.append(line) }
    for k in ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper"] {
      if let v = s[k] as? String { out.append(v) }
    }
    return out
  }

  private static let wordBreaks = CharacterSet(charactersIn: "\"'`;|&()<>=").union(.whitespacesAndNewlines)
  private static let projectDir = #"\$(?:\{CLAUDE_PROJECT_DIR\}|CLAUDE_PROJECT_DIR)"#

  /// The one form of a hook line in which the shell certainly keeps the folder's path as ONE word, and so does this check: an optional plain
  /// interpreter (no flag), then the folder variable inside double quotes, then a path of plain characters (`"$CLAUDE_PROJECT_DIR"/hooks/x.sh`,
  /// `python3 "$CLAUDE_PROJECT_DIR/hooks/x.py"`). That is what the kit writes. Anything else with a space in the folder's path is cut like the shell would.
  private static let simpleHook = try? NSRegularExpression(
    pattern: #"^(?:(bash|sh|zsh|python3?|node|bun) )?(?:"\#(projectDir)"/([A-Za-z0-9._@+/-]*)|"\#(projectDir)/([A-Za-z0-9._@+/-]*)")\z"#)

  /// The words of a shell command line that may name a file: quotes, `;`, `|`, `&`, `(`, `)`, `<`, `>`, `=` taken apart. The project folder
  /// variable (and its braced form, with a quote that closes right after it) becomes the folder BEFORE the cut, as the shell cuts what it expands,
  /// so a folder path with a space in it is cut there too (and refused), except in the simple hook form (`simpleHook`) whose folder path stays one word.
  private static func words(_ cmd: String, _ folder: String) -> [String] { tokens(cmd, folder).filter { $0.utf16.count > 1 } }

  /// All the words, one-letter ones too (`bun x`). A command with a NUL in it has none (nothing real carries one).
  private static func tokens(_ cmd: String, _ folder: String) -> [String] {
    if cmd.unicodeScalars.contains("\u{0}") { return [] }
    let ns = cmd as NSString
    if let m = simpleHook?.firstMatch(in: cmd, range: NSRange(location: 0, length: ns.length)) {
      var out: [String] = []
      if m.range(at: 1).location != NSNotFound { out.append(ns.substring(with: m.range(at: 1))) }
      let rel = m.range(at: 2).location != NSNotFound ? m.range(at: 2) : m.range(at: 3)
      out.append(folder + "/" + ns.substring(with: rel))
      return out
    }
    let replaced = cmd.replacingOccurrences(
      of: #"\$\{CLAUDE_PROJECT_DIR\}["']?|\$CLAUDE_PROJECT_DIR(?![A-Za-z0-9_])["']?"#, with: NSRegularExpression.escapedTemplate(for: folder), options: .regularExpression)
    return replaced.components(separatedBy: wordBreaks).filter { !$0.isEmpty }
  }

  /// A flag that makes a program read an argument as code or a command line (`-c`, `-e`, `-p`, `-m`, `--eval`): its other arguments are then not plain file names.
  private static let runsItsArgument = try? NSRegularExpression(pattern: #"^(?:-[A-Za-z]*[cepm][A-Za-z]*|--eval|--print|--command)$"#)
  /// The programs that take a file argument as one file, with no flag that says otherwise: not env, xargs, ssh, su, watch, script (they cut an argument again).
  private static let fileTakers = try? NSRegularExpression(pattern: #"^(?:node|bun|python[\d.]*|bash|sh|zsh)$"#)
  private static func matches(_ re: NSRegularExpression?, _ s: String) -> Bool { re?.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }

  /// The words of a stdio MCP server's command and arguments. They are no shell line: the program gets each one as it is. For a program that
  /// takes a file argument as one file (`fileTakers`), with no flag that makes it run an argument as code, an absolute path with a space in it that
  /// exists as written is that one file (a kit release in a folder with a space). Any other argument is cut as a shell line is, which only ever finds more.
  private static func argvWords(_ argv: [String], _ folder: String) -> [String] {
    let whole = matches(fileTakers, ((argv.first ?? "") as NSString).lastPathComponent) && !argv.contains { matches(runsItsArgument, $0) }
    let others = wordBreaks.subtracting(CharacterSet(charactersIn: " "))
    return argv.flatMap { a -> [String] in
      let plain = whole && a.hasPrefix("/") && a.contains(" ") && a.rangeOfCharacter(from: others) == nil && P.lstatOk(a)
      return plain ? [a] : words(a, folder)
    }
  }

  private static let scriptExt = try? NSRegularExpression(pattern: #"\.(?:py|sh|js|mjs|cjs|ts|rb|pl)$"#)
  private static func isScriptName(_ w: String) -> Bool { scriptExt?.firstMatch(in: w, range: NSRange(w.startIndex..., in: w)) != nil }

  /// The words of a command that name a file or folder: a path (a slash in it, `~`, a `$`) or a script by its extension; flags are not.
  private static func pathWords(_ cmd: String, _ folder: String) -> [String] { naming(words(cmd, folder)) }
  private static func naming(_ ws: [String]) -> [String] {
    ws.filter { !$0.hasPrefix("-") && ($0.contains("/") || $0.hasPrefix("~") || $0.contains("$") || isScriptName($0)) }
  }

  /// A command on one plain line for a refusal: control characters and runs of blanks become one space, and a long one is cut.
  private static func shown(_ cmd: String) -> String {
    let one = cmd.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : String($0) }.joined()
      .split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
    return one.count > 160 ? String(one.prefix(160)) + "..." : one
  }

  /// The folders every program can write to, by real path, in the order the TypeScript side lists them: the process's TMPDIR, the app's temp
  /// folder, /tmp, /private/tmp, /var/folders, /private/var/folders.
  static func tempRoots() -> [String] {
    var roots: [String] = []
    let listed = [ProcessInfo.processInfo.environment["TMPDIR"], NSTemporaryDirectory(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
    for t in listed.compactMap({ $0 }) where !t.isEmpty {
      if let r = try? P.real(t), r != "/", !roots.contains(r) { roots.append(r) }
    }
    return roots
  }

  /// A path by its real spelling, its own name kept: the folders on its way are resolved (the file need not exist).
  private static func realName(_ p: String) -> String {
    var rest: [String] = []
    var d = (p as NSString).deletingLastPathComponent
    while true {
      if let r = try? P.real(d) { return P.join(r, (rest.reversed() + [(p as NSString).lastPathComponent]).joined(separator: "/")) }
      let up = (d as NSString).deletingLastPathComponent
      if up == d || up.isEmpty { return p }
      rest.append((d as NSString).lastPathComponent)
      d = up
    }
  }

  /// What the sandbox never lets a session write: the fixed protected names of the folder (the kit's links by their own name), the files bun
  /// would load from its working folder (`bunfig.toml`, `.env`, and `.env.*` as a pattern: Claude Code's sandbox takes patterns), the owner's
  /// `~/Library/LaunchAgents` (a session could otherwise plant a login job that runs outside the sandbox), the kit release and the clone Talos's
  /// bridge runs from, each by real path. The session's own scripts are not here: a command that would need them locked is refused instead.
  static func denyWrite(_ folder: String, userHome: String? = nil, kitDir: String? = nil, clone: String? = nil) -> [String] {
    var out: [String] = []
    func add(_ p: String) { if !out.contains(p) { out.append(p) } }
    func real(_ p: String) -> String { (try? P.real(p)) ?? realName(p) }  // a link is followed (the kernel compares real paths); a missing folder is where it would be
    for n in alwaysNames { add(folder + "/" + n) }
    for n in folderNames where P.lstatOk(folder + "/" + n) { add(folder + "/" + n) }
    for n in bunFiles { add(folder + "/" + n) }
    if let h = userHome { add(real(h + "/Library/LaunchAgents")) }
    if let k = kitDir { add(real(k)) }
    if let c = clone { add(real(c)) }
    return out
  }

  /// What bun loads from its working folder, which for an MCP server Claude Code starts is the writable session folder.
  static let bunFiles = ["bunfig.toml", ".env", ".env.*"]

  /// What Talos recorded in a place the sandbox cannot write: the bun it runs (by real path) and the bridge folder it runs from
  /// (`<clone>/apps/bridge`, by real path).
  struct Trusted {
    var bun: String
    var bridgeDir: String
    /// The clone the bridge runs from: two folders above `apps/bridge`; the bridge folder itself when it is not laid out so.
    var clone: String {
      let up = ((bridgeDir as NSString).deletingLastPathComponent as NSString)
      return bridgeDir.hasSuffix("/apps/bridge") ? up.deletingLastPathComponent : bridgeDir
    }
  }

  // MARK: the kit's own, and what a user setting may run

  private static func leadsInto(_ p: String, _ dir: String) -> Bool {
    guard let target = try? P.real(p), let root = try? P.real(dir) else { return false }
    return target == root || target.hasPrefix(root + "/")
  }

  /// Is every file this command names the kit release's own: reached through the folder's `hooks`/`scripts`/`kit` link into the release, or
  /// inside the release? A command that names no file is not.
  private static func isKitOwn(_ cmd: String, _ folder: String, _ kitDir: String, templates: String? = nil, argv: [String]? = nil) -> Bool {
    let named = argv.map { naming(argvWords($0, folder)) } ?? pathWords(cmd, folder)
    guard !named.isEmpty else { return false }
    for w in named {
      guard !w.contains("$"), !w.hasPrefix("~") else { return false }
      let abs = w.hasPrefix("/") ? w : P.resolve(folder, w)
      if abs.hasPrefix(folder + "/") {
        if isLeadHook(abs, folder, templates) { continue }
        let first = String(abs.dropFirst(folder.count + 1).split(separator: "/").first ?? "")
        if kitNames.contains(first), P.isLink(folder + "/" + first), leadsInto(folder + "/" + first, kitDir) { continue }
        return false
      }
      let rp = realName(abs)
      let root = (try? P.real(kitDir)) ?? kitDir
      if rp.hasPrefix(root + "/") { continue }
      return false
    }
    return true
  }

  /// A lead's hook: `<folder>/.claude/hooks/<name>`, directly there, a regular file (never a link) whose bytes are exactly those of `<name>` in the lead
  /// templates of the clone Talos recorded (`kit/templates/lead`, what `lead init` copies). The folder's `.claude` is unwritable from a session, but a
  /// file put there before the switch went on is only as good as its content, so the content is what is compared, never the place.
  private static func isLeadHook(_ abs: String, _ folder: String, _ templates: String?) -> Bool {
    guard let templates, (abs as NSString).deletingLastPathComponent == folder + "/.claude/hooks" else { return false }
    let name = (abs as NSString).lastPathComponent
    var st = stat()
    guard lstat(abs, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, let have = FileManager.default.contents(atPath: abs),
      let want = FileManager.default.contents(atPath: templates + "/" + name)
    else { return false }
    return SHA256.hash(data: have) == SHA256.hash(data: want)
  }

  /// May the owner's user settings run this command: an absolute path to a file outside the session folder and every temp root (the folders a
  /// session can write), with nothing that depends on the working folder: no npx, uvx, bunx, `bun x`, `-m`, no relative script.
  private static func userCommandOK(_ cmd: String, _ folder: String) -> Bool {
    let w = tokens(cmd, folder)
    guard let program = w.first else { return false }
    let base = (program as NSString).lastPathComponent
    if ["npx", "uvx", "bunx"].contains(base) { return false }
    if base == "bun", w.count > 1, w[1] == "x" { return false }
    // bun loads `bunfig.toml` (a preload that runs code) and `.env*` from its working folder unless told not to: both flags, the config an absolute path
    if base == "bun" {
      let given = cmd.range(of: #"(^|\s)--config=/\S"#, options: .regularExpression) != nil
      if !(w.contains("--no-env-file") && given) { return false }
    }
    if w.contains("-m") { return false }
    let paths = pathWords(cmd, folder)
    guard !paths.isEmpty else { return false }
    let realFolder = (try? P.real(folder)) ?? folder
    let roots = [realFolder] + tempRoots()
    for p in paths {
      guard p.hasPrefix("/"), !p.contains("$") else { return false }
      let rp = realName(p)
      if roots.contains(where: { rp == $0 || rp.hasPrefix($0 + "/") }) { return false }
    }
    return true
  }

  /// The servers of the folder's `.mcp.json` that start a program, as `(name, entry, command line)`, by server name. A server with no
  /// `command` (a remote http or sse one) runs nothing on this machine and is not listed.
  private static func stdioServers(_ folder: String) -> [(name: String, entry: [String: Any], line: String, argv: [String])] {
    let servers = readJSON(folder + "/.mcp.json")?["mcpServers"] as? [String: Any] ?? [:]
    return servers.keys.sorted().compactMap { k -> (String, [String: Any], String, [String])? in
      guard let s = servers[k] as? [String: Any] else { return (k, [:], "", []) }
      let type = (s["type"] as? String)?.lowercased()
      if type == "http" || type == "sse" { return nil }
      guard let command = s["command"] as? String else { return s["url"] != nil ? nil : (k, s, "", []) }
      let argv = [command] + ((s["args"] as? [Any]) ?? []).compactMap { $0 as? String }
      return (k, s, argv.joined(separator: " "), argv)
    }
  }

  /// The env keys Talos writes into its server's entry (mcpEntry in mcp-config.ts): nothing else may be set (NODE_OPTIONS, BUN_*, DYLD_*, PATH, ...).
  static let talosEnvKeys = ["TALOS_APP_HOME", "TALOS_AGENT_DIR"]

  /// Why the folder's `talos-app` entry is not Talos's own, or nil when it is: `<bun> --no-env-file --config=<bridge>/bunfig.toml
  /// <bridge>/src/server.ts` by real paths equal to the recorded ones, an env of Talos's keys only. `old` is the form earlier installs wrote
  /// (`bun run --cwd <bridge> --silent src/server.ts`), which is refused with its own line.
  enum TalosEntry: Equatable { case ok, old, noRecord, why(String) }

  static func talosEntry(_ entry: [String: Any], folder: String, talosHome: String, trusted: Trusted?) -> TalosEntry {
    let allowed: Set<String> = ["command", "args", "env", "type"]
    if let k = entry.keys.sorted().first(where: { !allowed.contains($0) }) { return .why("it sets \(k)") }
    if let t = entry["type"] as? String, t.lowercased() != "stdio" { return .why("its type is \(t)") }
    guard let trusted else { return .noRecord }
    let realFolder = (try? P.real(folder)) ?? folder
    guard let bridge = try? P.real(trusted.bridgeDir) else { return .why("the bridge Talos recorded is not there") }
    if bridge == realFolder || bridge.hasPrefix(realFolder + "/") { return .why("the bridge Talos recorded is inside the session folder") }
    guard let command = entry["command"] as? String, command.hasPrefix("/"), let bun = try? P.real(command), bun == ((try? P.real(trusted.bun)) ?? trusted.bun)
    else { return .why("its command is not the bun Talos uses") }
    let args = (entry["args"] as? [Any])?.compactMap { $0 as? String } ?? []
    if let env = entry["env"] {
      guard let e = env as? [String: Any] else { return .why("its env is not a list of settings") }
      if let k = e.keys.sorted().first(where: { !talosEnvKeys.contains($0) }) { return .why("its env sets \(k)") }
      if let h = e["TALOS_APP_HOME"] as? String, (try? P.real(h)) != (try? P.real(talosHome)) { return .why("its TALOS_APP_HOME is not this Talos home") }
      if e.values.contains(where: { !($0 is String) }) { return .why("an env value is not a string") }
    }
    let server = bridge + "/src/server.ts", config = bridge + "/bunfig.toml"
    func same(_ a: String, _ b: String) -> Bool { (try? P.real(a)) == (try? P.real(b)) && (try? P.real(a)) != nil }
    if args.count == 3, args[0] == "--no-env-file", args[1].hasPrefix("--config="), same(String(args[1].dropFirst("--config=".count)), config) {
      return same(args[2], server) ? .ok : .why("its script is not Talos's bridge")
    }
    if args.count == 5, args[0] == "run", args[1] == "--cwd", args[3] == "--silent", args[4] == "src/server.ts", same(args[2], bridge) { return .old }
    return .why("it is not `--no-env-file --config=<bridge>/bunfig.toml <bridge>/src/server.ts`")
  }

  /// Every command that runs outside the sandbox, and where it comes from, in a fixed order: the folder's project and local settings, then its
  /// git root's, then `.mcp.json`, then the owner's user settings. One plain line for the first one that may not run, or nil.
  static func commandProblem(
    _ folder: String, claudeDir: String, loadsProject: Bool, kitDir: String, talosHome: String = "", trusted: Trusted? = nil
  ) -> String? {
    let templates = trusted.map { $0.clone + "/kit/templates/lead" }
    func moved(_ where_: String, _ what: String) -> String {
      "\(where_) runs \(what), which is not the kit's own; move it to your user settings (~/.claude/settings.json), then start again"
    }
    if loadsProject {
      var dirs: [String] = []
      for d in [folder, gitRoot(folder)] where !dirs.contains(d) { dirs.append(d) }
      for d in dirs {
        for (_, file) in projectSettings(d) {
          for c in settingsCommands(readJSON(file) ?? [:]) where !isKitOwn(c, folder, kitDir, templates: templates) { return moved(file, "\"\(shown(c))\"") }
        }
      }
    }
    for (name, entry, line, argv) in stdioServers(folder) {
      if name == "talos-app" {
        switch talosEntry(entry, folder: folder, talosHome: talosHome, trusted: trusted) {
        case .ok: continue
        case .noRecord:
          return "\(folder)/.mcp.json has a talos-app server, and Talos can't confirm which bridge this folder runs (the guards aren't installed); install them from Settings, then start again"
        case .old:
          return "\(folder)/.mcp.json has a talos-app server in the old form; run talos-app doctor to rewrite it, then start again"
        case .why(let why):
          return "\(folder)/.mcp.json has a talos-app server that is not Talos's own (\(why)); run talos-app adopt for this folder, then start again"
        }
      }
      if !isKitOwn(line, folder, kitDir, templates: templates, argv: argv) { return moved(folder + "/.mcp.json", "the \(name) server (\"\(shown(line))\")") }
    }
    for c in settingsCommands(readJSON(claudeDir + "/settings.json") ?? [:]) where !userCommandOK(c, folder) {
      return "\(claudeDir)/settings.json runs \"\(shown(c))\", which the extra lock cannot allow (it must be an absolute path to a file outside the session folder and every folder a session can write, with no npx, uvx, bunx, bun x, -m or relative script); change it, then start again"
    }
    return nil
  }

  /// The folder's `hooks` or `scripts` link is gone while the settings still run scripts from it: the hooks would silently not run. Only a command
  /// that names a file directly in the folder's `hooks` or `scripts` counts: a lead's `.claude/hooks/...` is a different folder.
  static func kitProblem(_ folder: String) -> String? {
    let commands = projectSettings(folder).flatMap { settingsCommands(readJSON($0.file) ?? [:]) }
    for n in kitLinks where !P.lstatOk(folder + "/" + n) {
      for c in commands where pathWords(c, folder).contains(where: { $0.hasPrefix(folder + "/" + n + "/") }) {
        return "\(n) is missing from \(folder) (its link into the kit release is gone) while .claude/settings.json runs scripts from it, so the guards would silently not run; run the kit's install again, then start again"
      }
    }
    return nil
  }

  /// The folder above `folder` that holds a `.git`, or `folder` itself when none does.
  private static func gitRoot(_ folder: String) -> String {
    var d = folder
    while true {
      if P.lstatOk(d + "/.git") { return d }
      let up = (d as NSString).deletingLastPathComponent
      if up == d || up.isEmpty { return folder }
      d = up
    }
  }

  // MARK: settings keys

  /// The `sandbox` keys a settings file may carry, and the value each may have: `enabled` and `failIfUnavailable` true and
  /// `autoAllowBashIfSandboxed` and `allowUnsandboxedCommands` false (what the lock itself says; a lead's own settings carry the last), and `ignoreViolations` (silences a log). Everything else, a key of a Claude
  /// Code newer than this list included, refuses: `ripgrep` is a program path run outside the sandbox (Claude Code 2.1.330 holds it to managed
  /// settings itself).
  static func foreignSandboxKey(_ s: [String: Any]) -> String? {
    guard let raw = s["sandbox"] else { return nil }
    guard let sb = raw as? [String: Any] else { return "sandbox" }
    func isBool(_ v: Any?, _ want: Bool) -> Bool {
      guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return false }
      return n.boolValue == want
    }
    for k in sb.keys.sorted() {
      switch k {
      case "ignoreViolations": continue
      case "enabled", "failIfUnavailable": if isBool(sb[k], true) { continue }
      case "autoAllowBashIfSandboxed", "allowUnsandboxedCommands": if isBool(sb[k], false) { continue }
      default: break
      }
      return k
    }
    return nil
  }

  private static let writeRule = try? NSRegularExpression(pattern: #"^(?:Edit|Write|MultiEdit|NotebookEdit)\(.+\)$"#)

  /// Settings that could take a command out of the sandbox or let a session write outside its folder, in any settings file the session loads
  /// (the folder's and its git root's project and local settings for Main and a thread in the agent folder; the owner's user settings for every
  /// session): a `sandbox` key outside the allow-list, `permissions.additionalDirectories`, or an Edit/Write allow rule with a path. A Bash
  /// allow rule is none of these. One plain line naming the file and the key, or nil.
  static func settingsProblem(_ folder: String, claudeDir: String, loadsProject: Bool) -> String? {
    var files: [String] = []
    if loadsProject {
      var dirs: [String] = []
      for d in [folder, gitRoot(folder)] where !dirs.contains(d) { dirs.append(d) }
      files = dirs.flatMap { d in projectSettings(d).map { $0.file } }
    }
    files.append(claudeDir + "/settings.json")
    for f in files {
      guard let s = readJSON(f) else { continue }
      if let key = foreignSandboxKey(s) {
        return "\(f) sets sandbox.\(key), which the extra lock does not allow (it could take a command out of the sandbox); remove it, then start again"
      }
      let perms = s["permissions"] as? [String: Any] ?? [:]
      if let extra = perms["additionalDirectories"] as? [Any], !extra.isEmpty {
        return "\(f) sets permissions.additionalDirectories, which lets a session write outside its folder; remove it, then start again"
      }
      for rule in (perms["allow"] as? [Any] ?? []).compactMap({ $0 as? String })
      where writeRule?.firstMatch(in: rule, range: NSRange(rule.startIndex..., in: rule)) != nil {
        return "\(f) allows \"\(shown(rule))\", a write to a path the sandbox does not decide; remove it, then start again"
      }
    }
    return nil
  }

  /// Main's launch arguments with `--add-dir` (before any `--`): the same as `additionalDirectories`, on the command line.
  static func launchArgsProblem(_ args: [String]) -> String? {
    for a in args.prefix(while: { $0 != "--" }) where a == "--add-dir" || a.hasPrefix("--add-dir=") {
      return "Main's launch arguments include --add-dir, which lets a session write outside its folder; remove it, then start again"
    }
    return nil
  }

  /// Everything about the folder that refuses a start while the switch is on, or nil.
  static func launchProblem(
    _ folder: String, claudeDir: String, loadsProject: Bool, kitDir: String, userHome: String? = nil, talosHome: String = "", trusted: Trusted? = nil
  ) -> String? {
    (loadsProject ? kitProblem(folder) : nil) ?? settingsProblem(folder, claudeDir: claudeDir, loadsProject: loadsProject)
      ?? commandProblem(folder, claudeDir: claudeDir, loadsProject: loadsProject, kitDir: kitDir, talosHome: talosHome, trusted: trusted)
      ?? linkProblem(folder, kitDir: kitDir, userHome: userHome, clone: trusted?.clone)
  }

  /// A file the session could write through another name: every existing fixed protected path in the folder (the files inside, for a folder)
  /// must be a regular file with link count 1. A hard link made earlier outside the sandbox would let a sandboxed session write a protected
  /// file. The kit's own links (`hooks`, `scripts`, `kit`) are links on purpose and point outside the folder: not walked, but they must lead
  /// into the kit release. One plain line naming the file relative to the folder, or nil.
  static func linkProblem(_ folder: String, kitDir: String, userHome: String? = nil, clone: String? = nil) -> String? {
    var budget = OsSandbox.walkCap
    for p in denyWrite(folder, userHome: userHome, kitDir: kitDir, clone: clone) {
      // outside the session folder (LaunchAgents, the kit release) nothing is writable from the sandbox: not walked
      guard p.hasPrefix(folder + "/") else { continue }
      let rel = String(p.dropFirst(folder.count + 1))
      if kitNames.contains(rel), P.isLink(p) {
        if !leadsInto(p, kitDir) {
          return "\(rel) is a symbolic link that does not lead into the kit release (\(kitDir)); put the kit's link back (run the kit's install again), then start again"
        }
        continue
      }
      if let why = OsSandbox.entryProblem(p, rel, &budget) { return why }
    }
    return nil
  }
}
