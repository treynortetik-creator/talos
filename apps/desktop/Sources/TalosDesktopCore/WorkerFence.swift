import Foundation

/// The Talos-home deny on every dedicated worker (docs/OPTION-C.md "Leads and the fence"). A thread session works for one thread; the
/// Talos home holds every thread's messages, keys and databases. Read, Grep, Glob, Edit, Write and NotebookEdit are denied on the whole
/// home, and Claude Code also applies those rules to Bash `cat`, `head`, `tail`, `sed`, `tee` and redirections. They do not stop a program
/// that opens the file itself (`sqlite3`, `python`, `grep -r`): only a sandbox does, and a worker has none.
///
/// The spelling is the one the bridge's lead fence uses (apps/bridge/src/lead/settings.ts): `Tool(//abs/**)` and `Tool(//abs)`, in the
/// spelling given and in lower case (macOS compares names without case). There is no `!` rule of any kind: a `!` pattern is read against
/// the current folder and cannot reopen a folder a rule blocks whole. The per-thread inbox lives outside the home for that reason.
public enum WorkerFence {
  /// Readers, then writers: the bridge's order.
  public static let tools = ["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit"]

  /// Claude Code reads `* ? [ ] { }` in a rule as a glob, and `(` `)` end the pattern, so a home with one of them cannot be named by a rule.
  public static func isSafe(talosHome: String) -> Bool {
    guard talosHome.hasPrefix("/"), talosHome.count > 1 else { return false }
    return !talosHome.unicodeScalars.contains { "*?[]{}()".unicodeScalars.contains($0) || $0.value < 0x20 || $0.value == 0x7f }
  }

  /// The spellings of the home a rule names: as given, then where it really is (a symbolic link in the path), each also in lower case.
  static func spellings(_ talosHome: String) -> [String] {
    func trim(_ p: String) -> String {
      var h = p
      while h.count > 1, h.hasSuffix("/") { h.removeLast() }
      return h
    }
    let given = trim(talosHome)
    var out: [String] = []
    var candidates = [given]
    if let r = realpath(given, nil) {
      candidates.append(trim(String(cString: r)))
      free(r)
    }
    for c in candidates { for f in [c, c.lowercased()] where !out.contains(f) { out.append(f) } }
    return out
  }

  public static func denyRules(talosHome: String) -> [String] {
    let forms = spellings(talosHome)
    return tools.flatMap { tool in forms.flatMap { ["\(tool)(/\($0)/**)", "\(tool)(/\($0))"] } }
  }

  /// The Talos home's `workers` folder, whole: what every thread session runs under and the supervisor writes for it (the permission
  /// hook's copy in `workers/_hook`, a hook that answered "allow" would keep every prompt off the phone; and each session's
  /// settings.json, MCP config, nonce, launch file and project-check.json). Denied to the file-tool writers (Edit, Write, NotebookEdit,
  /// as the Linux twin worker-spec.ts has it, and MultiEdit beside them as the settings-file deny spells it) on every session,
  /// whatever the developer thread fence says: with the fence off a session has main's access, and main's own hook and settings are
  /// not in the Talos home, so this is what keeps it from being wider. `validate` asks for every rule, fence on or off.
  public static func workerFilesDeny(talosHome: String) -> [String] {
    let forms = spellings(talosHome).map { $0 + "/workers" }
    return writers.flatMap { tool in forms.flatMap { ["\(tool)(/\($0)/**)", "\(tool)(/\($0))"] } }
  }

  /// The worker-files rules a settings text lacks (all of them when it cannot be read).
  public static func workerFilesMissing(settingsJSON: String, talosHome: String) -> [String] {
    let want = workerFilesDeny(talosHome: talosHome)
    guard let have = denyList(settingsJSON: settingsJSON) else { return want }
    return want.filter { !have.contains($0) }
  }

  /// The developer thread fence (packages/protocol/src/dev.ts; owner ruling 2026-11-15), as config.json's bytes say it, read again at
  /// every start (the Linux twin is worker-config.ts `threadFenceOn`). Off ONLY for `"dev": {"thread_fence": false}`, the JSON literal
  /// false: a missing file, broken JSON, no `dev`, a `dev` that is not an object, `true`, `0`, `"false"` or null all keep it on, so the
  /// fence never opens by accident. Off, a thread session's settings carry no Talos-home deny (`denyRules`); everything else stays.
  public static func threadFenceOn(configJSON: Data?) -> Bool {
    guard let d = configJSON, let root = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
      let dev = root["dev"] as? [String: Any], let v = dev["thread_fence"] as? NSNumber
    else { return true }
    // JSONSerialization gives `0` and `false` both as an NSNumber: only the boolean false counts
    return !(CFGetTypeID(v) == CFBooleanGetTypeID() && v === kCFBooleanFalse)
  }

  /// A best-effort layer on every worker's settings: a thread session's shell is not to run `talos-app post`, since a post from there
  /// speaks in any thread as the agent. These rules match a command's text, so a spelling they do not see (a variable, `xargs`) gets past
  /// them, and the CLI's own refusal knows a thread session only by variables a shell can shed. The real fix is the ROADMAP's "Agent
  /// isolation" (a worker with no key). Not part of the checked Talos-home fence (`missing`), so a spec without them still validates.
  public static let extraDeny = ["Bash(talos-app post:*)", "Bash(*talos-app post*)", "Bash(*cli.ts post*)"]

  /// The tools that write a file, for the settings-file deny.
  public static let writers = ["Edit", "Write", "MultiEdit", "NotebookEdit"]

  /// Tools no thread session may call: a worktree it enters is a checkout whose settings this start never read (Hestia's third
  /// review, F6).
  public static let deniedTools = ["EnterWorktree"]

  /// What a session may not edit in each folder a thread session could load Claude Code files from (`projectFolders`: its own, every
  /// folder above it up to its git root, its git roots, the agent folder, every other thread's): the whole `.claude` folder (settings,
  /// subagents, skills, commands, hooks, output styles), `.mcp.json` and every `.env*` (R1-8).
  public static let projectFiles = ["/.claude", "/.claude/**", "/.mcp.json", "/.env", "/.env*"]
  /// And in the owner's config folders (`configDirs`: ~/.claude and CLAUDE_CONFIG_DIR), what every session of his loads, main's too:
  /// the settings, and the subagents, skills and commands whose frontmatter can carry hooks.
  public static let configFiles = [
    "/settings.json", "/settings.local.json", "/agents", "/agents/**", "/skills", "/skills/**", "/commands", "/commands/**",
    // and the global config CLAUDE_CONFIG_DIR keeps, the plugins, hooks, instructions, rules and output styles there (F6)
    "/.claude.json", "/CLAUDE.md", "/plugins", "/plugins/**", "/hooks", "/hooks/**", "/rules", "/rules/**", "/output-styles",
    "/output-styles/**",
  ]

  /// The programs a settings file runs (each hook's `command`, the status line's), as paths. A PreToolUse hook can answer "allow",
  /// so a session that edits one could approve its own calls, and main's: every session's settings deny editing them. Each command
  /// is split into words as a shell would (quotes, backslashes, `;` `&` `|` `(` `)` `<` `>`), and in each word `$HOME`, `${HOME}`, a
  /// leading `~`, `$CLAUDE_PROJECT_DIR` and `${CLAUDE_PROJECT_DIR}` are filled in; the value of a `NAME=value` word counts as a word.
  /// A word that names a path is kept: absolute, or relative with a `/` or a script's extension, taken from the settings file's own
  /// folder (`files`: each settings file with the folder its relative paths start from). A word with any other variable in it, or
  /// a path a command builds at run time, is not seen: the hooks folders are denied whole besides.
  public static func scripts(files: [(settings: String, base: String)], projectDir: String, home: String) -> [String] {
    var out: [String] = []
    for (file, base) in files {
      guard let data = WorkerHook.readSmall(file, cap: WorkerHook.settingsCap),
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      else { continue }
      var commands: [String] = []
      func collect(_ v: Any) {
        if let d = v as? [String: Any] {
          if let c = d["command"] as? String { commands.append(c) }
          // by key: a Dictionary's own order is drawn per process, and this list reaches the settings' bytes (the launch spec's hash)
          for k in d.keys.sorted() { collect(d[k] as Any) }
        } else if let a = v as? [Any] {
          for x in a { collect(x) }
        }
      }
      if let h = obj["hooks"] { collect(h) }
      if let sl = obj["statusLine"] { collect(sl) }  // after the hooks, whatever the file's order
      for c in commands {
        for w in shellWords(c, home: home, projectDir: projectDir) {
          guard let p = scriptPath(w, base: base), !p.hasPrefix("/dev/"), !out.contains(p) else { continue }
          out.append(p)
        }
      }
    }
    return out
  }

  static let scriptExtensions = [".py", ".sh", ".bash", ".zsh", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl"]

  /// A word as a path, or nil when it names none.
  static func scriptPath(_ word: String, base: String) -> String? {
    var w = word
    if let eq = w.firstIndex(of: "="), let f = w.first, f == "_" || f.isLetter,
      w[..<eq].allSatisfy({ $0 == "_" || $0.isLetter || $0.isNumber }) { w = String(w[w.index(after: eq)...]) }
    guard !w.isEmpty, !w.hasPrefix("-"), !w.contains("\u{0}") else { return nil }
    if w.hasPrefix("/") { return WorkerHook.lexicalPath(w) }
    guard w.contains("/") || scriptExtensions.contains(where: { w.lowercased().hasSuffix($0) }) else { return nil }
    return WorkerHook.lexicalPath(base + "/" + w)
  }

  /// `cmd` split into words as a shell would, with the variables above filled in; a word holding another variable gets a NUL.
  static func shellWords(_ cmd: String, home: String, projectDir: String) -> [String] {
    var words: [String] = []
    var cur = ""
    var inWord = false
    var quote: Character?
    let chars = Array(cmd)
    var i = 0
    func end() {
      if inWord { words.append(cur) }
      cur = ""
      inWord = false
    }
    func variable() {
      // at chars[i] == "$"
      var j = i + 1
      var name = ""
      if j < chars.count, chars[j] == "{" {
        j += 1
        while j < chars.count, chars[j] != "}" { name.append(chars[j]); j += 1 }
        j += 1
        // `${NAME:-default}`: the variable is set, so its value is the one used
        if let r = name.range(of: ":-") { name = String(name[..<r.lowerBound]) }
      } else {
        while j < chars.count, chars[j] == "_" || chars[j].isLetter || chars[j].isNumber { name.append(chars[j]); j += 1 }
      }
      switch name {
      case "HOME": cur += home
      case "CLAUDE_PROJECT_DIR": cur += projectDir
      default: cur += "\u{0}"
      }
      inWord = true
      i = j
    }
    while i < chars.count {
      let c = chars[i]
      if let q = quote {
        if c == q {
          quote = nil
          i += 1
        } else if q == "\"", c == "\\", i + 1 < chars.count {
          cur.append(chars[i + 1])
          i += 2
        } else if q == "\"", c == "$" {
          variable()
        } else {
          cur.append(c)
          i += 1
        }
        continue
      }
      switch c {
      case "'", "\"":
        quote = c
        inWord = true
        i += 1
      case "\\":
        if i + 1 < chars.count { cur.append(chars[i + 1]) }
        inWord = true
        i += 2
      case "$": variable()
      case " ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">":
        end()
        i += 1
      case "~" where !inWord && (i + 1 == chars.count || chars[i + 1] == "/"):
        cur += home
        inWord = true
        i += 1
      default:
        cur.append(c)
        inWord = true
        i += 1
      }
    }
    end()
    return words
  }

  /// `files`: single files besides (the global config, `~/.claude.json`, which holds the user-scope MCP servers, and the scripts
  /// the agent folder's and the owner's settings run, `scripts`). `trees`: whole folders (the agent folder's hooks). `nested`: every
  /// `.claude` at any depth below these folders.
  /// Those files add variables and hooks to a session, and so to the shell that runs its permission hook (WorkerHookFolder.swift).
  /// Each path in every spelling `spellings` gives. A folder whose name Claude Code would read as a glob is left out: no rule can
  /// name it (its start is refused by the folder check instead, which reads the files themselves).
  public static func settingsDeny(
    projectFolders: [String], configDirs: [String], files extra: [String] = [], trees: [String] = [], nested: [String] = []
  ) -> [String] {
    var files: [String] = []
    for n in nested where isSafe(talosHome: n) { files += spellings(n).flatMap { [$0 + "/**/.claude", $0 + "/**/.claude/**"] } }
    for f in extra where isSafe(talosHome: f) { files += spellings(f) }
    for t in trees where isSafe(talosHome: t) { files += spellings(t).flatMap { [$0, $0 + "/**"] } }
    for f in projectFolders where isSafe(talosHome: f) {
      files += spellings(f).flatMap { base in projectFiles.map { base + $0 } }
    }
    for d in configDirs where isSafe(talosHome: d) {
      files += spellings(d).flatMap { base in configFiles.map { base + $0 } }
    }
    var out: [String] = []
    var seen = Set<String>()
    for tool in writers {
      for file in files where file.hasPrefix("/") {
        let rule = "\(tool)(/\(file))"
        if seen.insert(rule).inserted { out.append(rule) }
      }
    }
    return out
  }

  /// `settings` with `rules` added to `permissions.deny` (a union: what is there stays, nothing repeats). nil when `permissions` or its
  /// `deny` is there in a shape that cannot be added to: it is never replaced.
  public static func adding(deny rules: [String], to settings: [String: Any]) -> [String: Any]? {
    var out = settings
    var perms: [String: Any] = [:]
    if let existing = out["permissions"] {
      guard let dict = existing as? [String: Any] else { return nil }
      perms = dict
    }
    var deny: [String] = []
    if let existing = perms["deny"] {
      guard let list = existing as? [String] else { return nil }
      deny = list
    }
    for r in rules where !deny.contains(r) { deny.append(r) }
    perms["deny"] = deny
    out["permissions"] = perms
    return out
  }

  /// `settings` with every path rule in `permissions.deny` made absolute where it was defined (`PrivilegeCeiling.absolutize`). The guards'
  /// file was written for main, which runs in the agent folder: `Read(.private)` there is not a rule about the worker's own folder.
  public static func anchoring(_ settings: [String: Any], slashAnchor: String, cwdAnchor: String) -> [String: Any] {
    guard var perms = settings["permissions"] as? [String: Any], let deny = perms["deny"] as? [String] else { return settings }
    perms["deny"] = deny.map { PrivilegeCeiling.absolutize($0, slashAnchor: slashAnchor, cwdAnchor: cwdAnchor) }
    var out = settings
    out["permissions"] = perms
    return out
  }

  public static func applying(_ settings: [String: Any], talosHome: String) -> [String: Any]? {
    adding(deny: denyRules(talosHome: talosHome), to: settings)
  }

  /// The deny rules in a settings file's text, nil when it cannot be read.
  static func denyList(settingsJSON: String) -> [String]? {
    guard let obj = (try? JSONSerialization.jsonObject(with: Data(settingsJSON.utf8))) as? [String: Any] else { return nil }
    guard let perms = obj["permissions"] as? [String: Any] else { return [] }
    return perms["deny"] as? [String] ?? []
  }

  /// The fence rules a settings text lacks (all of them when it cannot be read).
  public static func missing(settingsJSON: String, talosHome: String) -> [String] {
    let want = denyRules(talosHome: talosHome)
    guard let have = denyList(settingsJSON: settingsJSON) else { return want }
    return want.filter { !have.contains($0) }
  }
}
