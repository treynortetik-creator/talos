import Foundation

/// A thread folder's Claude Code files that refuse its session's start (R1-1, R1-2, R1-4): checked in the folder, every folder above
/// it up to its git root, and the git roots (`WorkerHook.configFolders`).
///  - `.claude`, anything under it, `.mcp.json` and `.env` may not be links. A link is a file this check reads in one place while
///    the session, or a later edit, reaches another. Everything is opened from the folder down with O_NOFOLLOW, one level at a time,
///    so a link put in while it runs is refused rather than followed. `.claude/worktrees` (checkouts Claude Code makes) is not walked:
///    nothing in it loads for a session started in the folder.
///  - a subagent (`.claude/agents/**/*.md`), a skill (`.claude/skills/**/SKILL.md`) or a command (`.claude/commands/**/*.md`) whose
///    frontmatter carries hooks, allowed-tools, its own MCP servers or its own permission mode, or whose frontmatter cannot be read
///    for certain (`FrontmatterScan`). Thread sessions outside the agent folder do not load the folder's own skills, commands or
///    agents at all (`--setting-sources user`, WorkerSpec.swift); this holds them anyway, and in the agent folder they do load.
/// The kit's permission hook (permission-relay.py) runs the same check at every prompt.
extension WorkerHook {
  /// Frontmatter keys that refuse the start, compared without case and without `-` and `_` (`allowed-tools`, `allowedTools`).
  public static let refusedFrontmatterKeys: Set<String> = ["hooks", "allowed-tools", "mcpServers", "permissionMode"]
  static func refusedKey(_ k: String) -> Bool {
    let norm = { (s: String) in s.lowercased().replacingOccurrences(of: "-", with: "").replacingOccurrences(of: "_", with: "") }
    return refusedFrontmatterKeys.contains { norm($0) == norm(k) }
  }
  /// How many entries under one folder's `.claude` are looked at, and how deep.
  static let treeEntriesCap = 5000
  static let treeDepthCap = 24

  /// Why `folder`'s own Claude Code files refuse the start, or nil (see above). `folder` is a real path (`configFolders`).
  public static func folderFilesProblem(_ folder: String) -> String? {
    let dfd = open(folder, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard dfd >= 0 else { return nil }  // the folder is gone: the start itself fails on it
    defer { close(dfd) }
    for name in [".mcp.json", ".env", ".claude"] {
      var st = stat()
      if fstatat(dfd, name, &st, AT_SYMLINK_NOFOLLOW) != 0 { continue }
      if st.st_mode & S_IFMT == S_IFLNK { return linkLine(folder + "/" + name) }
    }
    var st = stat()
    guard fstatat(dfd, ".claude", &st, AT_SYMLINK_NOFOLLOW) == 0, st.st_mode & S_IFMT == S_IFDIR else { return nil }
    let cfd = openat(dfd, ".claude", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard cfd >= 0 else { return "the thread folder's \(folder)/.claude cannot be opened, so what it loads is not known" }
    defer { close(cfd) }
    var seen = 0
    return walk(cfd, path: folder + "/.claude", area: nil, depth: 0, seen: &seen)
  }

  static func linkLine(_ path: String) -> String {
    "the thread folder's \(path) is a link, which a thread session's Claude Code files may not be: what it loads would not be what was checked (replace the link with the file itself)"
  }

  /// The names in the folder open at `fd`, without `.` and `..`.
  static func names(_ fd: Int32) -> [String]? {
    let d = dup(fd)
    guard d >= 0, let dir = fdopendir(d) else { return nil }
    defer { closedir(dir) }
    var out: [String] = []
    while let e = readdir(dir) {
      let name = withUnsafePointer(to: e.pointee.d_name) { $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) } }
      if name != "." && name != ".." { out.append(name) }
    }
    return out.sorted()
  }

  /// `area`: which of agents, skills or commands the walk is under (lower case), nil at the top of `.claude`.
  static func walk(_ fd: Int32, path: String, area: String?, depth: Int, seen: inout Int) -> String? {
    guard depth <= treeDepthCap, let list = names(fd) else { return "the thread folder's \(path) cannot be read, so what it loads is not known" }
    for name in list {
      seen += 1
      if seen > treeEntriesCap { return "the thread folder's \(path) has more files than are checked (\(treeEntriesCap)), so what it loads is not known" }
      let full = path + "/" + name
      var st = stat()
      guard fstatat(fd, name, &st, AT_SYMLINK_NOFOLLOW) == 0 else { return "the thread folder's \(full) cannot be read, so what it loads is not known" }
      switch st.st_mode & S_IFMT {
      case S_IFLNK: return linkLine(full)
      case S_IFDIR:
        if area == nil, name.lowercased() == "worktrees" { continue }
        let sub = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard sub >= 0 else { return "the thread folder's \(full) cannot be read, so what it loads is not known" }
        let why = walk(sub, path: full, area: area ?? name.lowercased(), depth: depth + 1, seen: &seen)
        close(sub)
        if let why { return why }
      default:
        guard let kind = loadedKind(area: area, name: name) else { continue }
        if let why = frontmatterProblem(fd, name: name, path: full, kind: kind) { return why }
      }
    }
    return nil
  }

  /// What Claude Code loads the file as, when it loads it: a subagent, a skill or a command.
  static func loadedKind(area: String?, name: String) -> String? {
    let lower = name.lowercased()
    switch area {
    case "agents"?: return lower.hasSuffix(".md") ? "subagent" : nil
    case "commands"?: return lower.hasSuffix(".md") ? "command" : nil
    case "skills"?: return lower == "skill.md" ? "skill" : nil
    default: return nil
    }
  }

  static func frontmatterProblem(_ dirfd: Int32, name: String, path: String, kind: String) -> String? {
    guard let data = readSmallAt(dirfd, name, cap: settingsCap), let text = String(data: data, encoding: .utf8) else {
      return "the thread folder's \(kind) \(path) cannot be read, so what it runs is not known"
    }
    switch FrontmatterScan.scan(text) {
    case .unclear(let why):
      return "the thread folder's \(kind) \(path) cannot be read for certain (\(why)), so what it runs is not known"
    case .keys(let keys):
      if let k = keys.first(where: refusedKey) {
        return "the thread folder's \(kind) \(path) has \(shownKey(k)) of its own, which a thread session's \(kind)s may not carry: it runs beside the permission hook or widens the session (remove it from that file)"
      }
      return nil
    }
  }

  /// The bytes of `name` in the folder open at `dirfd` when it is a regular file, not a link, of at most `cap` bytes, read through
  /// one descriptor that never blocks; nil otherwise.
  static func readSmallAt(_ dirfd: Int32, _ name: String, cap: Int) -> Data? {
    let fd = openat(dirfd, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    let h = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    var st = stat()
    guard fstat(fd, &st) == 0, st.st_mode & S_IFMT == S_IFREG, st.st_size <= cap else { return nil }
    guard let d = try? h.read(upToCount: cap + 1), d.count <= cap else { return nil }
    return d
  }
}
