import Foundation
import TalosDesktopCore

/// Option C, the lead fence: what a running thread session was started with is compared with the config on every tick, and the lines the
/// thread gets about the launch. Split out of `WorkerManager` to keep that file under the size limit.
extension WorkerManager {
  /// The folder a thread's session would start in now, resolved the way `start` resolves it.
  func wantedFolder(_ s: ThreadSessionSettings) -> String {
    let wanted = s.cwd ?? options.agentDir
    guard let p = realpath(wanted, nil) else { return wanted }
    defer { free(p) }
    return String(cString: p)
  }

  /// A running session whose folder, model, effort or MCP list differs from the config is restarted, once the difference has stood for
  /// `launchChangeSettle`. It goes through `stopping`: a turn in progress is never cut (the owner's 15-minute limit applies, as for a tap on
  /// Restart). A new folder starts a fresh conversation; the rest resume the same one. A worker with no record of its launch is left alone
  /// until its next start records it.
  func checkLaunchChanges(settings: DedicatedSettings, now t: Double) {
    for id in rt.keys.sorted() {
      guard let r = rt[id], !r.adoptPending, r.entry.state == "live" || r.entry.state == "busy", let s = settings.threads[id] else {
        rt[id]?.change = LaunchChange.Debounce(settle: options.launchChangeSettle)
        continue
      }
      let wanted = LaunchChange.Signature(cwd: wantedFolder(s), model: s.model, effort: s.effort, mcpAllow: s.mcpAllow)
      var debounce = r.change
      debounce.settle = options.launchChangeSettle
      let fire = debounce.observe(LaunchChange.compare(launched: r.entry.launched, wanted: wanted), at: awake())
      rt[id]?.change = debounce
      // Park after the turn, then start again: through `stopping`, and NOT with the owner's stop limit. A tap on Restart gives up on a turn
      // after 15 minutes; a saved setting does not, so "Saving restarts the session when its current turn ends" stays true.
      switch fire {
      case .fresh(let w)?:
        rt[id]?.folderChangeTo = w.cwd
        rt[id]?.afterPark = "fresh"
        requestPark(id, reason: "config", byOwner: false)
      case .restart?:
        rt[id]?.afterPark = "restart"
        requestPark(id, reason: "config", byOwner: false)
      default:
        break
      }
      dirty = true
    }
  }

  /// One plain line into the thread, once for each `kind` the slot sees. A different kind in the same slot (another folder, another set of
  /// servers not found) is a new line; the same kind is never sent twice.
  func tell(_ id: String, slot: WritableKeyPath<Runtime, NoticeState>, kind: String, _ text: String) {
    guard rt[id] != nil else { return }
    if rt[id]?.fenceKinds[slot] != kind {
      rt[id]?[keyPath: slot].reset()
      rt[id]?.fenceKinds[slot] = kind
    }
    sendNotice(id, slot, kind: kind, text: text)
  }

  /// After a start: a new conversation in a new folder, and the servers on the thread's list that exist nowhere.
  func noteLaunch(_ id: String, missing: [String], refused: [String], ownFolder: [String: String]) {
    for (name, scope) in ownFolder.sorted(by: { $0.key < $1.key }) { audit("thread-session-mcp: thread=\(id) server=\(name) scope=\(scope)") }
    if !refused.isEmpty {
      tell(id, slot: \.refusedNote, kind: "mcp refused: \(refused.sorted().joined(separator: ","))", LaunchChange.refusedServersLine(refused))
    }
    if let folder = rt[id]?.folderChangeTo {
      rt[id]?.folderChangeTo = nil
      tell(id, slot: \.folderNote, kind: "folder: \(folder)", LaunchChange.folderLine(folder))
    }
    if !missing.isEmpty {
      tell(
        id, slot: \.missingNote, kind: "mcp not found: \(missing.sorted().joined(separator: ","))",
        LaunchChange.missingServersLine(missing))
    }
  }
}

extension WorkerManager {
  /// One line in the app's log (`Options.auditLogPath`): the time, then the text. Never a value from a server's definition.
  func audit(_ text: String) {
    guard let path = options.auditLogPath else { return }
    try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    let fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
    guard fd >= 0 else { return }
    let line = "\(ISOTime.string(now())) \(text)\n"
    _ = line.withCString { write(fd, $0, strlen($0)) }
    close(fd)
  }
}
