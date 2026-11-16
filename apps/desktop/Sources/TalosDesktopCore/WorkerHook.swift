import Foundation

/// The PermissionRequest hook a thread session runs: where it comes from, the copy the session runs, and the python3 that runs it.
/// A thread session is not a channel, so this hook is how its approval prompts reach the phone. A command that runs nothing leaves
/// every prompt at the terminal with no card and no word (2026-11-11: the settings named `<agent folder>/hooks/permission-relay.py`,
/// and an older agent folder has no `hooks/`), so a start whose hook cannot run is refused. The source is the app bundle's sealed
/// copy and nothing else (WorkerHookSource.swift). The Linux twin is apps/bridge/src/supervisor/worker-hook.ts; the reasons the two
/// share are word for word the same (swift-parity.test.ts).
public enum WorkerHook {
  /// What the session's settings run: the copy's path and the python3 that runs it, both absolute.
  public struct Installed: Equatable, Sendable {
    public var script: String
    public var python: String
    /// The bytes of the copy and of its helper (nil: none), as written: the launch spec hashes them (`permission-hook`,
    /// `permission-hook-helper`). Not part of `==`, which is where the session runs the hook from.
    public var hookBytes: Data?
    public var helperBytes: Data?
    public init(script: String, python: String, hookBytes: Data? = nil, helperBytes: Data? = nil) {
      self.script = script
      self.python = python
      self.hookBytes = hookBytes
      self.helperBytes = helperBytes
    }
    public static func == (a: Installed, b: Installed) -> Bool { a.script == b.script && a.python == b.python }
  }

  public enum Outcome: Equatable, Sendable {
    /// `replaced`: a copy was there and its text was not the source's (a newer kit, or a source someone edited): in the log.
    case installed(Installed, replaced: Bool = false)
    case problem(String)
  }

  /// The hook's file name, and the helper it imports from its own folder (optional there: the hook runs without it, minus its
  /// kill-switch file).
  public static let scriptName = "permission-relay.py"
  static let helper = "_talos_common.py"

  public static let noPython = "python3 is not on the thread session's PATH (outside its own folders), so its permission hook cannot run"

  /// The folder the session's copy lives in: inside the Talos home, which every thread session is fenced out of and only the owner
  /// can write. A copy in a checkout could be edited without a prompt by a thread working there (acceptEdits): it could make its
  /// own approvals answer themselves. `_hook` is no thread id (ids are letters, digits and dashes).
  public static func dir(talosHome: String) -> String { talosHome + "/workers/_hook" }

  /// Why `script` is not a hook that can be run, or nil: an absolute path to a readable regular file (links followed).
  static func scriptProblem(_ script: String) -> String? {
    guard script.hasPrefix("/") else { return "the permission hook \(script) is not an absolute path" }
    var st = stat()
    guard stat(script, &st) == 0 else { return "the permission hook \(script) is missing or cannot be read" }
    guard st.st_mode & S_IFMT == S_IFREG else { return "the permission hook \(script) is not a file" }
    guard access(script, R_OK) == 0 else { return "the permission hook \(script) is missing or cannot be read" }
    return nil
  }

  /// Why the copy's folder is not one only the owner controls, or nil. `workers/` and `workers/_hook` must each be a real folder (a
  /// link planted there, by a thread session's shell say, would carry the copy into a folder the thread can write and so let it
  /// answer its own prompts), owned by this account, writable by no other, and where the Talos home really puts them.
  /// `existingOnly`: the preflight's read, before anything is made. A folder that is not there yet is not a problem; one that is
  /// there is held to the same rule.
  static func folderProblem(talosHome: String, dir: String, existingOnly: Bool = false) -> String? {
    for d in [(dir as NSString).deletingLastPathComponent, dir] {
      var st = stat()
      guard lstat(d, &st) == 0 else {
        if existingOnly, errno == ENOENT { return nil }
        return "\(d) cannot be read"
      }
      guard st.st_mode & S_IFMT == S_IFDIR else { return "\(d) is not a plain folder" }
      guard st.st_uid == getuid() else { return "\(d) belongs to another account" }
      guard st.st_mode & 0o022 == 0 else { return "\(d) can be written by other accounts" }
    }
    guard let real = realpath(dir, nil), let home = realpath(talosHome, nil) else { return "\(dir) cannot be read" }
    defer {
      free(real)
      free(home)
    }
    return String(cString: real) == String(cString: home) + "/workers/_hook" ? nil : "\(dir) is not inside the Talos home"
  }

  /// Why a session started with this `path` could not run the hook from `source`, or nil (the start's preflight: nothing is written).
  /// With `talosHome`, the copy's folder is looked at too, as far as it exists: a start that `install` would refuse for it takes no slot.
  /// `fenced`: the starting thread's folder and the agent folder. Neither the app nor the python3 may be inside one. `python`:
  /// where else a python3 may not be (every other thread's folder, the owner's home).
  public static func problem(
    source: BundleSource, path: String?, talosHome: String? = nil, fenced: [String] = [], python: PythonRules = .init()
  ) -> String? {
    if case .problem(let why) = source.verified(outside: fenced) { return why }
    if findPython3(path: path, fenced: fenced, rules: python) == nil { return noPython }
    guard let talosHome, let unsafe = folderProblem(talosHome: talosHome, dir: dir(talosHome: talosHome), existingOnly: true) else { return nil }
    return "the permission hook's folder \(unsafe)"
  }

  /// One folder of the copy's path, made if it is not there. Never through a link: `mkdir` on a link's name fails, and the check
  /// that follows refuses it before anything is made beneath it.
  private static func makeFolder(_ d: String) throws {
    if mkdir(d, 0o700) != 0, errno != EEXIST { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
  }

  /// The hook the session runs: `source`'s script and its helper written into the fenced folder (0600, written whole), made only
  /// of the bytes the check verified (read once, checked, then those bytes written: a swap between check and copy cannot land),
  /// and the python3 the session's PATH names, resolved now (at every start: one that was fine last time is checked again) and
  /// written into the command. Or why not: then the start is refused. A source with no helper leaves none in the copy's folder
  /// either: an old one would be imported in its place.
  public static func install(
    talosHome: String, source: BundleSource, path: String?, fenced: [String] = [], python rules: PythonRules = .init(),
    resolvePython: ((String?) -> String?)? = nil, dry: Bool = false
  ) -> Outcome {
    let checked: BundleSource.Verified
    switch source.verified(outside: fenced) {
    case .problem(let why): return .problem(why)
    case .ok(let v): checked = v
    }
    let python: String
    if let resolvePython {
      guard let given = resolvePython(path), given.hasPrefix("/") else { return .problem(noPython) }
      python = given
    } else {
      guard let found = findPython3(path: path, fenced: fenced, rules: rules) else { return .problem(noPython) }
      python = found
    }
    let dir = dir(talosHome: talosHome)
    let script = dir + "/" + scriptName
    let made = Installed(script: script, python: python, hookBytes: checked.script, helperBytes: checked.helper)
    // a dry plan (the update check): what would be written, checked as far as the folders exist, and nothing made or copied
    if dry {
      if let unsafe = folderProblem(talosHome: talosHome, dir: dir, existingOnly: true) { return .problem("the permission hook's folder \(unsafe)") }
      return .installed(made)
    }
    var replaced = false
    do {
      // `workers/` first, checked before `_hook` is made in it: a link planted at `workers` gets nothing made through it
      let parent = (dir as NSString).deletingLastPathComponent
      try makeFolder(parent)
      if let unsafe = folderProblem(talosHome: talosHome, dir: dir, existingOnly: true) { return .problem("the permission hook's folder \(unsafe)") }
      try makeFolder(dir)
      if let unsafe = folderProblem(talosHome: talosHome, dir: dir) { return .problem("the permission hook's folder \(unsafe)") }
      if let old = FileManager.default.contents(atPath: script), old != checked.script { replaced = true }
      try AtomicFile.write(checked.script, to: script, mode: 0o600)
      if let helperText = checked.helper {
        try AtomicFile.write(helperText, to: dir + "/" + helper, mode: 0o600)
      } else if unlink(dir + "/" + helper) != 0, errno != ENOENT {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
      }
    } catch {
      return .problem("the permission hook could not be copied into \(dir): \(error.localizedDescription)")
    }
    return .installed(made, replaced: replaced)
  }

  /// What the hook's command is written for: the thread, its Talos home and the owner's home. They go into the command as text, so
  /// the session's own environment cannot name another hub, another thread or another home for the hook.
  /// `folder`: the session's own folder, whose Claude Code settings the hook reads again at every prompt (`TALOS_APP_HOOK_CHECK_DIR`;
  /// WorkerHookFolder.swift has the rules), and `folderHooksCount`: whether hooks of its own count there (not in the agent folder).
  public struct Session: Equatable, Sendable {
    public var home: String
    public var talosHome: String
    public var threadId: String
    public var folder: String?
    public var folderHooksCount: Bool
    public init(home: String, talosHome: String, threadId: String, folder: String? = nil, folderHooksCount: Bool = true) {
      self.home = home
      self.talosHome = talosHome
      self.threadId = threadId
      self.folder = folder
      self.folderHooksCount = folderHooksCount
    }
  }

  /// The home the hook runs with: the session's, when it is a folder that is there, else this account's. A HOME that is not there
  /// costs Apple's tools seconds at every run, and the hook reads its kill switch below it.
  public static func hookHome(_ given: String?) -> String {
    var isDir: ObjCBool = false
    if let h = given, h.hasPrefix("/"), FileManager.default.fileExists(atPath: h, isDirectory: &isDir), isDir.boolValue { return h }
    return NSHomeDirectory()
  }

  /// The only variables the hook is run with that come from the session: each is a value the hook reads (the thread's proof, the
  /// kill switch and where its file is, the wait, Claude Code's own three), never one that picks a program or a library.
  static let passedThrough = [
    "TALOS_APP_WORKER_NONCE", "TALOS_PERMISSION_RELAY_OFF", "TALOS_PERMISSION_HOOK_WAIT_S", "CLAUDE_PID", "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_PROJECT_DIR", "XDG_STATE_HOME", "CHRONOS_CONFIG",
  ]

  /// The shell line that runs in the clean environment: `$0` is the copy, `$1` the interpreter. Every test of the command is made
  /// here, by a shell that started with nothing of the session's.
  static let cleanLine = "[ -f \"$0\" ] || exit 0; exec \"$1\" -I -S \"$0\""

  /// The hook's command: `script` run by `python` (both absolute, resolved at the start) in an EMPTY environment (`/usr/bin/env -i`)
  /// that holds only what is listed here. A thread folder's `.claude/settings*.json` can set any variable for the session's hooks
  /// (`env`), and the hook is the program that answers that thread's prompts: DEVELOPER_DIR picks the program Apple's
  /// /usr/bin/python3 launcher runs, DYLD_* loads a library into the interpreter, PYTHON* changes what it imports, and
  /// TALOS_APP_HOME names the hub it asks (R1-1). None of them reaches the interpreter: the home, the Talos home, the thread and
  /// the PATH are written here as text, and the rest are the few values of `passedThrough`. `-I` and `-S` besides: no user site, no
  /// site-packages, no `.pth` file (the hook is standard library only; it adds its own folder for its helper). Marked as the
  /// session's own copy (the agent folder's stays silent, so one prompt raises one card). No `command -v`: the interpreter is
  /// never looked up when the hook runs.
  /// The shell Claude Code runs this line with has the SESSION's environment, so this part of it does nothing but assign `f` and
  /// call `exec`, a special builtin (found before any function, so an imported `exec` or `[` function changes nothing). The test
  /// that the copy is there, and the run, are made by a second `/bin/sh` that `env -i` starts clean (`cleanLine`).
  /// What this cannot cover: that first shell reads SHELLOPTS and PS4 from the session (xtrace with a PS4 that runs a program). The
  /// session never has them: the app strips them, BASH_ENV, ENV, BASHOPTS and every BASH_FUNC_ from its environment
  /// (`ClaudeEnvScrub.shellStartup`), and a session outside the agent folder does not load the folder's settings that could set them
  /// (`--setting-sources user`); the agent folder's own are held to the env list (WorkerHookFolder.swift).
  public static func command(_ hook: Installed, for s: Session) -> String {
    let fixed = [
      "HOME=\(quote(s.home))", "PATH=/usr/bin:/bin", "LANG=en_US.UTF-8", "TALOS_APP_HOME=\(quote(s.talosHome))",
      "TALOS_APP_WORKER_THREAD=\(quote(s.threadId))", "TALOS_APP_PERM_HOOK_SOURCE=worker",
    ] + (s.folder.map { ["TALOS_APP_HOOK_CHECK_DIR=\(quote($0))", "TALOS_APP_HOOK_CHECK_HOOKS=\(s.folderHooksCount ? "1" : "0")"] } ?? [])
    let passed = passedThrough.map { "\($0)=\"${\($0)-}\"" }
    return "f=\(quote(hook.script)); exec /usr/bin/env -i \((fixed + passed).joined(separator: " ")) /bin/sh -c \(quote(cleanLine)) \"$f\" \(quote(hook.python))"
  }

  /// Always quoted, as the Linux twin quotes its paths.
  static func quote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

  /// The one line the thread gets when its session starts without settings files of its folder that carry more than a thread
  /// session may have (WorkerHookFolder.swift): the start goes ahead, since those files are not loaded.
  public static func ignoredLine(_ whys: [String]) -> String {
    let list = whys.prefix(3).map(WorkerInstructions.shown).joined(separator: "; ") + (whys.count > 3 ? "; and \(whys.count - 3) more" : "")
    return "Note: this thread's session started without its folder's own Claude Code files: \(list). A thread session loads only your own settings (~/.claude) and what Talos gives it (its folder's CLAUDE.md and AGENTS.md as text), so those files are ignored and change nothing. Nothing is wrong with the session."
  }

  /// The one line the thread gets when its start is refused for this.
  public static func missingLine(why raw: String) -> String {
    let why = WorkerInstructions.shown(raw)
    return "This thread's session doesn't start: \(why), and without it the session's approval prompts would wait at the terminal on the Mac and never reach your phone. Reinstall Talos on the Mac (or fix the hook), then restart this thread's session."
  }
}
