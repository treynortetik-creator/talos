import Foundation

/// What a thread folder's own Claude Code settings may carry. Claude Code runs the hook's command, and every Bash command, in the
/// SESSION's environment, and a folder's `.claude/settings.json` and `.claude/settings.local.json` (the folder's, and its git root's
/// when the folder sits below one) add to that environment (`env`) and to what the session runs (`hooks`, `statusLine`,
/// `apiKeyHelper`, `CLAUDE_CODE_SHELL_PREFIX`). Closing that by lists kept missing a way in, so a thread session outside the agent
/// folder does not load those files at all: it starts with `--setting-sources user` (WorkerSpec.swift). The lists stay, as defence in
/// depth and to tell the owner:
///  - `env` may hold only Claude Code's own tunables (`allowedEnv`), each a plain value;
///  - outside the agent folder, only the settings keys of `allowedKeys`, and `permissions` with only `deny`, `ask` and `defaultMode`;
///  - the agent folder's settings carry the kit's own hooks and status line by design, so only their `env` is held to this there.
/// Outside the agent folder a file that carries anything else is a WARNING: the start goes ahead (the file is ignored) and the thread
/// gets one line naming the file and, when it is a plain name, the key; so are links, hooked subagents, skills and commands, and a
/// git pointer that cannot be followed (WorkerFolderTree.swift), none of which load there. A session in the agent folder loads its
/// files as main does, so there each is a refusal (`worker_hook_missing`). The files are read at every start, and again by the hook at every prompt; a session's own edits to them
/// are denied in its settings (`WorkerFence.settingsDeny`).
/// The same lists are the kit hook script's, permission-relay.py (swift-parity.test.ts holds them equal, and to the shared table).
extension WorkerHook {
  /// Claude Code's own tunables: numbers and switches, none of which names a program, a library or a folder to run from.
  public static let allowedEnv: Set<String> = [
    "BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS", "BASH_MAX_OUTPUT_LENGTH", "MAX_THINKING_TOKENS", "MAX_MCP_OUTPUT_TOKENS", "MCP_TIMEOUT",
    "MCP_TOOL_TIMEOUT", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR", "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "DISABLE_AUTOUPDATER", "DISABLE_ERROR_REPORTING", "DISABLE_BUG_COMMAND",
    "DISABLE_COST_WARNINGS", "DISABLE_NON_ESSENTIAL_MODEL_CALLS", "DISABLE_PROMPT_CACHING",
  ]
  /// The settings keys a thread folder's project settings may have (outside the agent folder).
  public static let allowedKeys: Set<String> = [
    // each names text or a choice, never a path, a program or a deletion (cleanupPeriodDays went: it deletes transcripts, R1-6)
    "$schema", "env", "permissions", "model", "includeCoAuthoredBy", "alwaysThinkingEnabled", "outputStyle",
    // which CLAUDE.md files and skills load: text the session reads, never a program (this repository's own settings use both)
    "claudeMdExcludes", "skillOverrides",
  ]
  /// `defaultMode` too: the session's own settings (`--settings`) name main's mode and outrank the project's, and Claude Code
  /// ignores `auto` and `bypassPermissions` from a project file, so the folder's value is never the one in force.
  public static let allowedPermissionKeys: Set<String> = ["deny", "ask", "defaultMode"]

  public static let noConfig =
    "the agent config has not been read yet, so the thread folders a thread session's permission hook is fenced from are not known"

  /// A key as the owner's line may show it: a plain name, or a word that says it is not one (a key is the folder's text, and the
  /// line goes to the phone).
  public static func shownKey(_ k: String) -> String {
    let plain = !k.isEmpty && k.utf8.count <= 64 && k.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || "_$.-".unicodeScalars.contains($0)) }
    return plain ? k : "a key that is not a plain name"
  }

  /// The folder holding `folder`'s git repository (the nearest folder at or above it with a `.git`), or nil.
  public static func gitRoot(of folder: String) -> String? {
    guard var d = resolved(folder) else { return nil }
    while true {
      var st = stat()
      if lstat(d + "/.git", &st) == 0 { return d }
      if d == "/" { return nil }
      d = (d as NSString).deletingLastPathComponent
    }
  }

  /// The git roots whose project settings Claude Code reads for a session in `folder`, or why they cannot be known. The nearest
  /// folder with a `.git` (its working tree), and when that `.git` is a FILE (a linked worktree, or a submodule) the CANONICAL root
  /// it leads to: Claude Code reads `settings.local.json` there, following `.git` -> `gitdir:` -> `commondir`. A thread can write
  /// such a file in its own folder to name any repository, so the chain is followed here too, the way Claude Code follows it (Hestia's
  /// B1a, B1b): the whole trimmed text after `gitdir:` (not its first line), each path resolved by its text alone (`..` takes away a
  /// name), and each step must be where its text says, with no link on the way (its real path is that text). A `.git` that is a
  /// link, text with a control character or a line separator, or a step that does not resolve that way, refuses the start.
  public static func gitRoots(of folder: String) -> (roots: [String], problem: String?) {
    guard let top = gitRoot(of: folder) else { return ([], nil) }
    let dotGit = top + "/.git"
    let broken = "the thread folder's git repository at \(dotGit) points somewhere that cannot be followed, so the settings Claude Code reads for it are not known"
    var st = stat()
    guard lstat(dotGit, &st) == 0 else { return ([top], broken) }
    switch st.st_mode & S_IFMT {
    case S_IFDIR: return ([top], nil)
    case S_IFREG: break
    default: return ([top], "the thread folder's \(dotGit) is a link, so the settings Claude Code reads for it are not known")
    }
    guard let text = readSmall(dotGit, cap: 4096).flatMap({ String(data: $0, encoding: .utf8) }), text.hasPrefix("gitdir:"),
      let gitdir = pointer(String(text.dropFirst("gitdir:".count)), from: top), isDir(gitdir)
    else { return ([top], broken) }
    // a submodule's git folder has no commondir: its working tree is the canonical root
    let commonFile = gitdir + "/commondir"
    guard lstat(commonFile, &st) == 0 else { return errno == ENOENT ? ([top], nil) : ([top], broken) }
    guard let ct = readSmall(commonFile, cap: 4096).flatMap({ String(data: $0, encoding: .utf8) }), let common = pointer(ct, from: gitdir),
      isDir(common)
    else { return ([top], broken) }
    // the main working tree is the folder holding the common git folder (`<root>/.git`); a bare repository has none
    guard (common as NSString).lastPathComponent == ".git" else { return ([top], nil) }
    let canonical = (common as NSString).deletingLastPathComponent
    guard resolved(canonical) == canonical else { return ([top], broken) }
    return canonical == top ? ([top], nil) : ([top, canonical], nil)
  }

  /// A path a git pointer file names: its whole text trimmed, taken from `base` when relative, resolved by its text alone, and only
  /// when that is also where it really is. nil for text with a control character or any non-ASCII space (U+0085, U+2028, U+2029,
  /// U+00A0 ...: Claude Code trims some of those and not others), or a path through a link.
  static func pointer(_ raw: String, from base: String) -> String? {
    // ASCII spaces only: Claude Code's trim takes more, so what is left of it is refused below
    let text = raw.trimmingCharacters(in: CharacterSet(charactersIn: " \t\n\r\u{0B}\u{0C}"))
    guard !text.isEmpty, !text.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F || (!$0.isASCII && $0.properties.isWhitespace) })
    else { return nil }
    let lexical = lexicalPath(text.hasPrefix("/") ? text : base + "/" + text)
    return resolved(lexical) == lexical ? lexical : nil
  }

  /// An absolute path with `.`, `..` and repeated slashes taken out by its text, as Node's `path.resolve` does.
  static func lexicalPath(_ p: String) -> String {
    var parts: [Substring] = []
    for c in p.split(separator: "/", omittingEmptySubsequences: true) {
      if c == "." { continue }
      if c == ".." {
        if !parts.isEmpty { parts.removeLast() }
        continue
      }
      parts.append(c)
    }
    return "/" + parts.joined(separator: "/")
  }

  private static func isDir(_ p: String) -> Bool {
    var st = stat()
    return stat(p, &st) == 0 && st.st_mode & S_IFMT == S_IFDIR
  }

  /// The settings files' size cap: far past any real settings file, and a reader never holds a session's start on a big one.
  public static let settingsCap = 256 * 1024

  /// The bytes of `p` when it is a regular file of at most `cap` bytes and not a link, read through one open descriptor that never
  /// blocks; nil otherwise. A FIFO, a device or a huge file at a settings path cannot hold the reader.
  static func readSmall(_ p: String, cap: Int) -> Data? {
    let fd = open(p, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    let h = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    var st = stat()
    guard fstat(fd, &st) == 0, st.st_mode & S_IFMT == S_IFREG, st.st_size <= cap else { return nil }
    guard let d = try? h.read(upToCount: cap + 1), d.count <= cap else { return nil }
    return d
  }

  /// The folders whose Claude Code files a session in `folder` could load: it, every folder above it up to its git root (R1-8), and
  /// the git roots (`gitRoots`), as real paths; or why they are not known.
  public static func configFolders(_ folder: String) -> (folders: [String], problem: String?) {
    let me = resolved(folder) ?? folder
    let g = gitRoots(of: folder)
    var out = [me]
    if let top = g.roots.first, me != top, me.hasPrefix(top == "/" ? "/" : top + "/") {
      var d = (me as NSString).deletingLastPathComponent
      while d != top, d.count > top.count {
        out.append(d)
        d = (d as NSString).deletingLastPathComponent
      }
    }
    for r in g.roots where !out.contains(r) { out.append(r) }
    return (out, g.problem)
  }

  /// The two project settings files Claude Code reads in `folder`.
  public static func projectSettingsFiles(_ folder: String) -> [String] {
    let f = folder.hasSuffix("/") ? String(folder.dropLast()) : folder
    return [f + "/.claude/settings.json", f + "/.claude/settings.local.json"]
  }

  /// What a start in `folder` finds in its folders' Claude Code files: why it is refused (nil: it is not), and what the session
  /// ignores that the owner is told about. `isAgentFolder`: `folder` is the agent folder, whose sessions load its settings.
  public struct FolderCheck: Equatable, Sendable {
    public var refusal: String?
    public var warnings: [String]
  }

  /// Outside the agent folder nothing of this loads (`--setting-sources user`), so every finding is a warning (Hestia's F2): the
  /// tree is walked once per start, never at a prompt. In the agent folder, whose files load as main's do, each is a refusal.
  public static func folderCheck(folder: String, isAgentFolder: Bool) -> FolderCheck {
    let found = configFolders(folder)
    var warnings: [String] = []
    if let why = found.problem {
      if isAgentFolder { return .init(refusal: why, warnings: []) }
      warnings.append(why)
    }
    for f in found.folders {
      guard let why = folderFilesProblem(f) else { continue }
      if isAgentFolder { return .init(refusal: why, warnings: []) }
      warnings.append(why)
    }
    for (n, f) in found.folders.enumerated() {
      for file in projectSettingsFiles(f) {
        guard let why = fileProblem(file, kitOwned: isAgentFolder && n == 0) else { continue }
        if isAgentFolder { return .init(refusal: why, warnings: []) }
        warnings.append(why)
      }
    }
    return .init(refusal: nil, warnings: warnings)
  }

  /// The refusal alone (`folderCheck`).
  public static func folderSettingsProblem(folder: String, isAgentFolder: Bool) -> String? {
    folderCheck(folder: folder, isAgentFolder: isAgentFolder).refusal
  }

  static func fileProblem(_ file: String, kitOwned: Bool) -> String? {
    let unknown = "the thread folder's \(file) cannot be read as settings, so what it sets for the session is not known"
    var st = stat()
    if lstat(file, &st) != 0 {
      if errno == ENOENT || errno == ENOTDIR { return nil }
      return unknown
    }
    guard let data = readSmall(file, cap: settingsCap) else { return unknown }
    if data.allSatisfy({ $0 == 0x20 || $0 == 0x0A || $0 == 0x0D || $0 == 0x09 }) { return nil }  // empty: Claude Code reads nothing from it
    guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return unknown }
    if let env = json["env"] {
      guard let dict = env as? [String: Any] else { return unknown }
      for k in dict.keys.sorted() {
        let plainValue = dict[k] is String || dict[k] is NSNumber
        if !allowedEnv.contains(k) || !plainValue {
          return "the thread folder's \(file) sets \(shownKey(k)) for the session, which is not one of Claude Code's own settings a thread session may change (remove it from that file's env)"
        }
      }
    }
    if kitOwned { return nil }
    if let k = json.keys.sorted().first(where: { !allowedKeys.contains($0) }) {
      return "the thread folder's \(file) has \(shownKey(k)), which a thread session's project settings may not carry: it can run a program beside the permission hook or widen the session (move it out of that file)"
    }
    if let perms = json["permissions"] {
      guard let dict = perms as? [String: Any] else { return unknown }
      if let k = dict.keys.sorted().first(where: { !allowedPermissionKeys.contains($0) }) {
        return "the thread folder's \(file) has permissions.\(shownKey(k)), and a thread session's project settings may only deny, ask or name a default mode (move it out of that file)"
      }
    }
    return nil
  }
}
