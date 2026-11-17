import Foundation
import TalosDesktopCore

/// The folder a thread session starts in, and the sub-thread rules that decide it. Split out of `WorkerManager` to keep that file under the
/// size limit.
extension WorkerManager {
  /// The resolved folder to start in, and for a sub-thread with a folder of its own the parent's folder it was checked against. nil when
  /// the start is refused: the thread is already marked failed, and nothing was written.
  func startFolder(_ id: String, _ s: ThreadSessionSettings) -> (cwd: String, parent: String?)? {
    var wanted = s.cwd ?? options.agentDir
    var parent: String?
    if let sub = s.sub {
      if let why = sub.refusal {
        fail(id, "start_failed", why)
        return nil
      }
      // an option the sub-thread set that is not valid was read as not set; said once per start
      for (key, value) in sub.unreadable.sorted(by: { $0.key < $1.key }) {
        audit("thread-session-sub: thread=\(id) setting=\(key) unreadable=\"\(value.replacingOccurrences(of: "\"", with: "'"))\" not set")
      }
      // a sub-thread's own folder is checked inside its parent's, and made when it is missing, before anything else looks at it
      if sub.ownCwd, let p = sub.parentCwd {
        // nothing is made inside a folder no session may use (the home folder itself, ~/.claude, the Talos data folder)
        if p != options.agentDir, let why = WorkerSpec.folderProblem(p, home: options.home, talosHome: options.talosHome) {
          fail(id, "start_failed", "sub-thread folder: the parent's folder: \(why)")
          return nil
        }
        switch SubThreadFolder.prepare(cwd: wanted, parentCwd: p) {
        case .success(let made): wanted = made
        case .failure(let refusal):
          fail(id, "start_failed", "sub-thread folder: \(refusal.why)")
          return nil
        }
        parent = p
      } else if !sub.shares {
        fail(id, "start_failed", "sub-thread folder: it has none of its own inside its parent's")
        return nil
      }  // one that shares its parent's folder is a thread in that folder like any other: nothing is made or checked against the parent
    }
    // the worker runs in the resolved folder
    let cwd = realpath(wanted, nil).map { p -> String in
      defer { free(p) }
      return String(cString: p)
    } ?? wanted
    // the bridge checked this folder when it was set; it may have become a symlink since (docs/OPTION-C.md). The value
    // used is a value checked.
    if wanted != options.agentDir {
      for path in [wanted, cwd] {
        if let why = WorkerSpec.folderProblem(path, home: options.home, talosHome: options.talosHome) {
          fail(id, "start_failed", "thread folder: \(why)")
          return nil
        }
      }
    }
    return (cwd, parent)
  }
}

extension WorkerManager {
  /// The folder this thread's conversation was last launched in: the launch record's, or, for an entry an older build wrote, the
  /// entry's own `cwd` (every start set it to the folder it launched in, resolved). nil for a thread that never had a session.
  func lastFolder(_ id: String) -> String? {
    guard let e = rt[id]?.entry, e.session_id != nil else { return nil }
    return e.launched?.cwd ?? e.cwd
  }

  /// A `session_opts` (or its `cwd`) that cannot be read gives the agent folder, which is not the owner's setting. A start there would
  /// resume a conversation whose transcript is somewhere else, or begin a thread's first session in the wrong folder: it is refused, the
  /// field is named, and the session id is kept for when the config is fixed. nil when the folder can be read, or is the one the
  /// conversation was in already.
  func unreadFolderRefusal(_ id: String, _ s: ThreadSessionSettings) -> String? {
    guard let field = s.unreadFolderField else { return nil }
    if let last = lastFolder(id), last == wantedFolder(s) { return nil }
    return "the thread's \(field) cannot be read, so its folder is not known; fix it in config.json"
  }

  /// Why a running sub-thread's own folder is not (or can no longer be) one its session may run in, as the disk has it now; nil when
  /// it is fine or cannot be told. The folder as configured and, with no record of its launch (an older build's entry), the folder it
  /// really runs in, each FIRMLY outside the parent's; or a parent folder no session may use (the home folder itself, `~/.claude`, the
  /// Talos data folder), as a start would refuse. A folder that cannot be resolved for a moment (a rename, a permission, a network
  /// mount) is no verdict: never a reason to stop a session that runs.
  func subFenceProblem(_ id: String, _ s: ThreadSessionSettings) -> String? {
    guard let sub = s.sub, sub.ownCwd, let parent = sub.parentCwd, let own = s.cwd, let entry = rt[id]?.entry else { return nil }
    let folders = entry.launched == nil ? [own, entry.cwd] : [own]
    if folders.contains(where: { SubThreadFolder.fence(cwd: $0, parentCwd: parent) == .outside }) { return SubThreadFolder.outside }
    func real(_ p: String) -> String? {
      guard let r = realpath(p, nil) else { return nil }
      defer { free(r) }
      return String(cString: r)
    }
    guard let r = real(parent), r != real(options.agentDir) else { return nil }
    return WorkerSpec.folderProblem(parent, home: options.home, talosHome: options.talosHome).map { "the parent's folder: \($0)" }
  }

  /// A running sub-thread whose settings now refuse a start (its parent archived or gone, its parent link or folder setting
  /// unreadable), or whose folder is no longer strictly inside its parent's (the parent moved; read from the disk each tick, and only
  /// for a session that is running): once that has stood for `launchChangeSettle`, it is parked after its turn, through `stopping`,
  /// with no stop limit and no restart queued. Its next start is refused with the reason (`requestStart`, `startFolder`). A refusal
  /// put right before the settle time passes changes nothing. True while it is refused: the caller looks at no launch change then.
  func checkRefusedSub(_ id: String, _ s: ThreadSessionSettings) -> Bool {
    guard let sub = s.sub, (sub.refusal ?? subFenceProblem(id, s)) != nil else {
      rt[id]?.subRefusedSince = nil
      return false
    }
    let t = awake()
    let since = rt[id]?.subRefusedSince ?? t
    rt[id]?.subRefusedSince = since
    guard t - since >= options.launchChangeSettle else { return true }
    rt[id]?.subRefusedSince = nil
    audit("worker_sub_refused thread=\(id)")
    rt[id]?.afterPark = nil
    requestPark(id, reason: "sub_refused", byOwner: false)
    dirty = true
    return true
  }

  /// Entries of `config.threads` that were left out (`DedicatedSettings.droppedEntries`): one line in the log and one in the default
  /// thread, once per set of them, so a typo never silently costs the owner a session. A clear failure of the post is tried again at a
  /// later tick (after `noticeRetry`), three times, and then said in the log; a timeout is not (it may have been sent).
  func noteDroppedEntries(_ s: DedicatedSettings) {
    let said = s.droppedEntries.map(String.init).joined(separator: ",")
    guard said != droppedSaid else { return }
    let retry = droppedSaid == "retry:" + said
    if retry, awake() < droppedRetryAt { return }  // a clear failure waits `noticeRetry`, as every notice does
    droppedSaid = said
    guard !s.droppedEntries.isEmpty else { return }
    if !retry {
      droppedTries = 0
      audit("config_threads_entries_ignored entries=\(said)")
    }
    guard let post = postNotice else { return }
    let thread = s.defaultThread
    let text = DedicatedSettings.droppedEntriesLine(s.droppedEntries)
    Thread.detachNewThread { [weak self] in
      guard post(thread, text) == .failed else { return }
      self?.queue.async {
        guard let self, self.droppedSaid == said else { return }
        self.droppedTries += 1
        if self.droppedTries >= 3 {
          self.audit("config_threads_entries_notice_failed entries=\(said)")
        } else {
          self.droppedSaid = "retry:" + said
          self.droppedRetryAt = self.awake() + self.options.noticeRetry
        }
      }
    }
  }
}
