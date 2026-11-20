import Foundation

/// The thread-state hook a thread session runs (the kit's thread-state.py): its own live state file, `<agent>/threads/<id>.state.md`,
/// put back in front of it at every start, resume, clear, fork and after a compaction, and its own compaction carry kept apart from
/// Main's. The Linux twin is worker-hook.ts (staging), worker-spec.ts (the command, the settings, the flag) and worker-policy.ts (the
/// allow rules); swift-parity.test.ts holds the two to the same text.
///
/// Staged exactly like the permission hook (WorkerHook.install): the bytes of the app bundle's sealed copy, nothing else. The two files
/// are the hook and the compaction guard it shares its carry with; both come with the helper they import, or none does, and a session
/// with none runs without the hook (today's behaviour, exactly): `TALOS_APP_THREAD_STATE` is set for a session only when its settings
/// register the hook, and `WorkerSpec.validate` holds the two together.
extension WorkerHook {
  /// The hook's file name, and the two files that are staged for it (the second is the compaction guard: with the flag set it does
  /// nothing, which is what stops a thread's compaction overwriting Main's carry).
  public static let stateScriptName = "thread-state.py"
  public static let stateFileNames = [stateScriptName, "compaction-guard.py"]

  /// In a worker's environment (value `1`) exactly when its settings register the thread-state hook.
  public static let threadStateEnv = "TALOS_APP_THREAD_STATE"

  /// Where the hook's bytecode would go: nowhere (`-B` writes none, and none is read from the staged folder beside the script).
  static let stateBytecodeDir = "/nonexistent"

  /// The shell line the hook's clean shell runs: `$0` the copy, `$1` the interpreter, `$2` the mode, `$3` the agent folder, `$4` the
  /// bytecode prefix.
  static let stateCleanLine = "[ -f \"$0\" ] || exit 0; exec \"$1\" -B -X \"pycache_prefix=$4\" -I -S \"$0\" \"$2\" \"$3\""

  /// Where the session's copy of the hook is: beside the permission hook, inside the fenced Talos home.
  public static func stateScript(talosHome: String) -> String { dir(talosHome: talosHome) + "/" + stateScriptName }

  /// The hook's command (`mode`: `inject` or `save`), built like the permission hook's: the copy run by the resolved python3, isolated,
  /// in an EMPTY environment where the role, the thread, the agent folder and the home are written here as text and never the
  /// session's own (a thread folder's settings `env` cannot change whose state it reads). Only XDG_STATE_HOME passes through, as it
  /// picks where the thread's compaction carry is kept, the same folder Main's hooks use.
  public static func stateCommand(script: String, python: String, mode: String, session s: Session, agentDir: String) -> String {
    let set = [
      "HOME=\(quote(s.home))", "PATH=/usr/bin:/bin", "LANG=en_US.UTF-8", "TALOS_SESSION_ROLE=worker",
      "TALOS_APP_WORKER_THREAD=\(quote(s.threadId))", "CLAUDE_PROJECT_DIR=\(quote(agentDir))", "XDG_STATE_HOME=\"${XDG_STATE_HOME-}\"",
    ]
    return "f=\(quote(script)); exec /usr/bin/env -i \(set.joined(separator: " ")) /bin/sh -c \(quote(stateCleanLine)) \"$f\" \(quote(python)) \(mode) \(quote(agentDir)) \(quote(stateBytecodeDir))"
  }

  /// True when `settings` run the hook for both events (SessionStart `inject`, PreCompact `save`) from the session's own staged copy.
  /// Only a command that starts with that copy's assignment counts: another script, or the right words elsewhere, is not the hook.
  public static func stateRegistered(settings: [String: Any], talosHome: String) -> Bool {
    let script = stateScript(talosHome: talosHome)
    func runs(_ event: String, _ mode: String) -> Bool {
      guard let list = (settings["hooks"] as? [String: Any])?[event] as? [Any] else { return false }
      return list.contains { entry in
        ((entry as? [String: Any])?["hooks"] as? [Any])?.contains { h in
          guard let c = (h as? [String: Any])?["command"] as? String else { return false }
          return c.hasPrefix("f=\(quote(script)); ") && c.contains(" \(mode) ")
        } ?? false
      }
    }
    return runs("SessionStart", "inject") && runs("PreCompact", "save")
  }

  /// The thread's state file as rules name it: the agent folder as given and as it really is (a link in the path), nothing lower-cased
  /// (the allow side stays narrow: a spelling no rule names asks). A folder whose name Claude Code would read as a glob, a quote or a
  /// control character gets none, so the session asks (the safe side), as the Talos-home fence refuses such a home.
  private static func stateRules(agentDir: String, threadId: String, tail: String) -> [String] {
    guard WorkerSpec.isThreadId(threadId) else { return [] }
    func trim(_ p: String) -> String {
      var h = p
      while h.count > 1, h.hasSuffix("/") { h.removeLast() }
      return h
    }
    var forms = [trim(agentDir)]
    if let r = realpath(forms[0], nil) {
      let real = trim(String(cString: r))
      free(r)
      if !forms.contains(real) { forms.append(real) }
    }
    let refused = CharacterSet(charactersIn: "*?[]{}()!\\\"'`").union(CharacterSet(charactersIn: "\u{0}"..."\u{1f}")).union(CharacterSet(charactersIn: "\u{7f}"))
    let ok = forms.filter { $0.hasPrefix("/") && $0.rangeOfCharacter(from: refused) == nil }
    // Edit( ) alone: it covers the Write tool too (WorkerFence.tools)
    return ok.map { "Edit(/\($0)/threads/\(threadId).state.md\(tail))" }
  }

  /// The rules that let a thread's session edit its own live state file without a prompt: that exact path, as Edit( ) (it covers Write). No
  /// glob, no folder: a sibling (another thread's file, a `.bak`, a `..` path) is not covered.
  public static func stateAllowRules(agentDir: String, threadId: String) -> [String] {
    stateRules(agentDir: agentDir, threadId: threadId, tail: "")
  }

  /// The matching deny rules: Claude Code reads a path rule gitignore-style, where a pattern that names a file also names everything
  /// under it, so the allow rule would let a session write `<id>.state.md/anything` (Write makes parent folders). Deny wins over
  /// allow, and `<file>/**` leaves the file itself alone.
  public static func stateDenyRules(agentDir: String, threadId: String) -> [String] {
    stateRules(agentDir: agentDir, threadId: threadId, tail: "/**")
  }

  /// The staged files as the launch spec hashes them: a release that changes either restarts sessions for it, as for the permission hook.
  public static func stateLaunchFiles(_ hook: Installed) -> [String: Data?] {
    [
      "thread-state-hook": hook.stateBytes?[stateFileNames[0]],
      "thread-state-compaction": hook.stateBytes?[stateFileNames[1]],
    ]
  }
}

extension WorkerSpec {
  /// `settings` with the thread-state hook under hooks.SessionStart (`inject`, at start, resume, clear, fork and after a compaction)
  /// and hooks.PreCompact (`save`), next to the hooks already there. nil when the settings' hooks are of a shape these cannot be added
  /// to (never replaced, never skipped: the start is refused).
  public static func withThreadStateHooks(
    _ settings: [String: Any], script: String, python: String, session: WorkerHook.Session, agentDir: String
  ) -> [String: Any]? {
    var hooks: [String: Any] = [:]
    if let existing = settings["hooks"] {
      guard let dict = existing as? [String: Any] else { return nil }
      hooks = dict
    }
    func add(_ event: String, mode: String, matcher: String?) -> Bool {
      var list: [Any] = []
      if let had = hooks[event] {
        guard let l = had as? [Any] else { return false }
        list = l
      }
      var entry: [String: Any] = [
        "hooks": [["type": "command", "timeout": 5, "command": WorkerHook.stateCommand(script: script, python: python, mode: mode, session: session, agentDir: agentDir)]]
      ]
      if let matcher { entry["matcher"] = matcher }
      hooks[event] = list + [entry]
      return true
    }
    guard add("SessionStart", mode: "inject", matcher: "startup|resume|clear|compact|fork"), add("PreCompact", mode: "save", matcher: nil) else {
      return nil
    }
    var out = settings
    out["hooks"] = hooks
    return out
  }

  /// `settings` with the thread-state hooks and the allow rules for its own state file (and the deny rules for what is under it), or
  /// nil when the settings' hooks or permissions are of a shape they cannot be added to.
  static func addingThreadState(
    _ settings: [String: Any], hook: WorkerHook.Installed, session: WorkerHook.Session, talosHome: String, agentDir: String, threadId: String
  ) -> [String: Any]? {
    guard var out = withThreadStateHooks(
      settings, script: WorkerHook.stateScript(talosHome: talosHome), python: hook.python, session: session, agentDir: agentDir)
    else { return nil }
    var perms = out["permissions"] as? [String: Any] ?? [:]
    func union(_ key: String, _ rules: [String]) -> Bool {
      var have: [String] = []
      if let existing = perms[key] {
        guard let list = existing as? [String] else { return false }
        have = list
      }
      for r in rules where !have.contains(r) { have.append(r) }
      perms[key] = have
      return true
    }
    guard union("allow", WorkerHook.stateAllowRules(agentDir: agentDir, threadId: threadId)),
      union("deny", WorkerHook.stateDenyRules(agentDir: agentDir, threadId: threadId))
    else { return nil }
    out["permissions"] = perms
    return out
  }
}
