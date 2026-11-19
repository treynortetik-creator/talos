import Foundation
import TalosDesktopCore

/// A thread session's permission hook at its start (`WorkerHook`): checked before the start takes a slot, copied into the fenced
/// home when the start is made, and a start refused, with one line in the thread, when it cannot run. Split out of `WorkerManager`
/// to keep that file under the size limit.
extension WorkerManager {
  /// The login shell has not been read yet, so the PATH may be the app's bare one: a python3 not found on it says nothing yet.
  private var pathIsProvisional: Bool { hasLoginEnv.map { !$0() } ?? false }

  /// Every thread's folder the agent config names (a sub-thread's too) and the folder of every session this app has made; nil
  /// until the config has been read once (the fence fails closed: such a start is refused). Read now, at each start.
  var threadFolders: [String]? {
    guard let s = loadSettings() else { return nil }
    return Array(Set(s.threads.values.compactMap(\.cwd) + rt.values.map(\.entry.cwd))).sorted()
  }

  /// Where a python3 may not be, besides the start's own folders: every thread's folder and the owner's home (R1-2: thread B edits
  /// its own folder without a prompt, so a python3 there must never run thread A's hook).
  func pythonRules(_ folders: [String]) -> WorkerHook.PythonRules { .init(folders: folders, home: options.home) }

  /// Why the hook cannot be trusted in `folder`, for the config not read yet or the folder's own Claude Code files, or nil.
  func folderProblem(_ folder: String) -> String? {
    if threadFolders == nil { return WorkerHook.noConfig }
    return folderCheck(folder).refusal
  }

  private func folderCheck(_ folder: String) -> WorkerHook.FolderCheck {
    WorkerHook.folderCheck(folder: folder, isAgentFolder: WorkerSpec.folderKey(folder) == WorkerSpec.folderKey(options.agentDir))
  }

  /// What the session started in `folder` does not load and the owner should know: one line in the thread for each new set (the audit
  /// has every one). Nothing when there is none.
  func noteIgnoredSettings(_ id: String, folder: String) {
    var warnings = folderCheck(folder).warnings
    // and the instruction files the session is not given (a link out of its folder, a name it cannot carry)
    if WorkerSpec.folderKey(folder) != WorkerSpec.folderKey(options.agentDir) {
      let env = baseEnv()
      let home = env["HOME"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? options.home
      let skipped = WorkerInstructions.collect(
        folder: folder, home: home, configDir: WorkerMcp.claudeDir(home: home, env: env), mode: WorkerSpec.instructionMode).notRead
      warnings += skipped.map { "the instruction file \($0) was not given to the session" }
    }
    guard !warnings.isEmpty else { return }
    for w in warnings { audit("worker_folder_settings_ignored thread=\(id) why=\"\(WorkerNotice.logValue(w))\"") }
    // its own slot and its own clock: a new set at most once a minute (a folder can be edited to give a new one at every start)
    let kind = "ignored: " + warnings.joined(separator: "|")
    if rt[id]?.fenceKinds[\Runtime.ignoredSettingsNote] != kind {
      let now = awake()
      if let last = ignoredToldAt[id], now - last < Self.hookNoticeGap { return }
      ignoredToldAt[id] = now
    }
    tell(id, slot: \.ignoredSettingsNote, kind: kind, WorkerHook.ignoredLine(warnings))
  }

  /// True when the start is refused: nothing was made, no slot taken and no other session parked for it. Nothing is written here.
  /// `cwd`: the thread's folder as its settings name it (the start resolves it for good). That folder and the agent folder are
  /// where neither the app nor a python3 may be (`WorkerHook.BundleSource`, `WorkerHook.findPython3`).
  func refuseWithoutHook(_ id: String, cwd: String?) -> Bool {
    guard let source = options.permissionHook else { return refuseHook(id, WorkerHook.noBundledHook) }
    if let why = folderProblem(cwd ?? options.agentDir) { return refuseHook(id, why) }
    let fenced = [options.agentDir] + (cwd.map { [$0] } ?? [])
    let rules = pythonRules(threadFolders ?? [])
    guard let why = WorkerHook.problem(source: source, path: baseEnv()["PATH"], talosHome: options.talosHome, fenced: fenced, python: rules)
    else { return false }
    if why == WorkerHook.noPython, pathIsProvisional { return false }  // `start` keeps it for a later tick
    return refuseHook(id, why)
  }

  /// The copy this start's session runs and the python3 that runs it, or nil: the start was refused (or kept for a later tick while
  /// the login shell's PATH is not known yet), and the caller makes nothing. The python3 and the folder's settings are looked at
  /// again here, at every start.
  func installHook(_ id: String, cwd: String, resume: Bool, now t: Double) -> WorkerHook.Installed? {
    guard let source = options.permissionHook else {
      _ = refuseHook(id, WorkerHook.noBundledHook)
      return nil
    }
    if let why = folderProblem(cwd) {
      _ = refuseHook(id, why)
      return nil
    }
    noteIgnoredSettings(id, folder: cwd)
    let rules = pythonRules(threadFolders ?? [])
    switch WorkerHook.install(talosHome: options.talosHome, source: source, path: baseEnv()["PATH"], fenced: [options.agentDir, cwd], python: rules) {
    case .installed(let hook, let replaced):
      // the script that answers every thread session's prompts is not the one the last start ran: a newer app's hook
      if replaced { audit("worker_hook_replaced thread=\(id) source=\"\(WorkerNotice.logValue(source.script ?? ""))\"") }
      return hook
    case .problem(let why):
      if why == WorkerHook.noPython, pathIsProvisional {
        if rt[id]?.heldSince == nil { audit("worker_start_held thread=\(id) reason=login_env_unreadable_and_python3_not_on_path") }
        hold(id, resume: resume, now: t)
        return nil
      }
      _ = refuseHook(id, why)
      return nil
    }
  }

  /// The thread's live state file in the agent folder (`threads/<id>.state.md`), made when it is missing at a real start (never at a dry
  /// plan; never overwritten, never through a link). A problem is audited and never stops the start.
  func seedThreadState(_ id: String, name: String?) {
    if case .problem(let why) = ThreadStateSeed.seed(agentDir: options.agentDir, id: id, name: name) {
      audit("worker_state_seed_failed thread=\(id) why=\"\(WorkerNotice.logValue(why))\"")
    }
  }

  /// The least time between two new reasons told to one thread.
  static let hookNoticeGap: Double = 60

  private func refuseHook(_ id: String, _ why: String) -> Bool {
    audit("worker_hook_missing thread=\(id) why=\"\(WorkerNotice.logValue(why))\"")
    fail(id, "start_failed", why)
    // a folder's settings can be edited to give a new reason at every start: a new reason is told at most once a minute (the audit
    // has every one); the same reason is never told twice (`tell`)
    let kind = "hook missing: \(why)"
    let now = awake()
    if rt[id]?.fenceKinds[\Runtime.hookNote] != kind {
      if let last = rt[id]?.hookToldAt, now - last < Self.hookNoticeGap { return true }
      rt[id]?.hookToldAt = now
    }
    tell(id, slot: \.hookNote, kind: kind, WorkerHook.missingLine(why: why))
    return true
  }
}
