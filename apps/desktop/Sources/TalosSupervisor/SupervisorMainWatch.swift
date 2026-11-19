import Foundation
import TalosDesktopCore

/// Main running, its bridge live, and still nobody hears the owner: the bridge cannot reach the relay, or the agent stopped reading
/// what it is told (`MainWatch` decides both). Each is one needs-you line, told once per episode and cleared when it is over: the
/// relay connected again, or the message taken in (a bridge tool call; the pane printing only keeps the line from being raised).
/// Nothing is restarted for either. Main
/// only, once its bridge has been seen live in this start (before that `checkBridge` owns the slot).
extension Supervisor {
  func watchMain(_ l: inout Launch) {
    guard options.checksBridge, options.name == TmuxCommands.mainSession, l.bridgeSeenLive else { return }
    let awake = options.awake()
    let status = liveBridgeStatus(l)
    settleUnstickAnswer(&l, awake: awake)  // before `observe`: a message taken in meanwhile still gets its line
    // the pane's output time is a tmux call: read only while a message waits and Main has not printed since
    // (from the tick after the message is first seen; the quiet counts from that first read)
    let out = l.mainWatch.wantsPaneOutput ? host.lastOutputAt() : nil
    l.mainWatch.observe(status: status, paneOutputAt: out, awakeNow: awake)
    let relay = l.mainWatch.relayDown(awakeNow: awake)
    let notReading = l.mainWatch.notReading(awakeNow: awake) != nil
    // the pane's rows and the end of Main's transcript, only while a message waits and its stall is still to be told (or is up)
    if l.mainWatch.wantsStallReads {
      let rows = host.visibleRows()
      l.mainWatch.observeStall(
        rows: rows, transcript: transcript(&l, awake: awake), awakeNow: awake, idle: rows.map { MainStall.idlePrompt(escapedRows: $0) })
    }
    unstickTick(&l, awake: awake)
    missedTurnTick(&l, awake: awake)
    let stalled = l.mainWatch.stalled()
    settle(relay.down ? .relayUnreachable(relay.closeCode) : nil, key: "relay", launch: &l)
    settle(notReading ? .notReading : nil, key: "unseen", launch: &l)
    settle(stalled.map { .stalled($0, l.mainWatch.unstick) }, key: "stall", launch: &l)
  }

  /// How often the folder is listed for the newest file (a /clear starts a new session id and a new file); between looks the file found
  /// last is read. A folder that is not there yet is looked for at the same pace, so a missing one costs no listing per tick.
  private static let transcriptLookEvery: Double = 15

  /// Main's transcript: the newest-modified `.jsonl` in Main's own project folder (`<claude dir>/projects/<folder name>/`, only that
  /// one folder listed), so a session id that changed under `/clear` is followed. nil when there is none or it cannot be read, which the
  /// watch takes as "unknown", not "unchanged".
  private func transcript(_ l: inout Launch, awake: Double) -> MainStall.Transcript? {
    let fm = FileManager.default
    let due = l.transcriptLook.lookedAt.map { awake - $0 >= Self.transcriptLookEvery } ?? true
    if due || l.transcriptLook.file.map({ !fm.fileExists(atPath: $0) }) == true {
      l.transcriptLook.lookedAt = awake
      let dir = launchClaudeDir ?? WorkerMcp.claudeDir(home: options.home, env: [:])
      if l.transcriptLook.folder == nil {
        l.transcriptLook.folder = [PathUtil.canonical(l.agentDir), l.agentDir]
          .map { dir + "/projects/" + SessionTranscript.projectFolderName($0) }
          .first { fm.fileExists(atPath: $0) }
      }
      l.transcriptLook.file = l.transcriptLook.folder.flatMap { folder in
        ((try? fm.contentsOfDirectory(atPath: folder)) ?? []).filter { $0.hasSuffix(".jsonl") }
          .compactMap { name -> (String, Date)? in
            let path = folder + "/" + name
            guard let at = (try? fm.attributesOfItem(atPath: path))?[.modificationDate] as? Date else { return nil }
            return (path, at)
          }
          .max { $0.1 < $1.1 }?.0
      }
    }
    return l.transcriptLook.file.flatMap { MainStall.transcript(atPath: $0) }
  }

  /// Raises `alarm` once (the slot must be free: a dialog or a start question comes first), puts it back quietly when the slot
  /// frees again, and clears it, ready to be told again, once it is over.
  private func settle(_ alarm: NeedsYou?, key: String, launch l: inout Launch) {
    guard let alarm else {
      if let n = needsYou, Self.watchKey(n) == key { needsYou = nil }
      l.notifiedScreens.remove(key)
      return
    }
    if let n = needsYou, Self.watchKey(n) == key, n != alarm { needsYou = alarm }  // a newer close code
    guard needsYou == nil else { return }
    if l.notifiedScreens.contains(key) { needsYou = alarm } else { raiseNeedsYou(alarm, key: key, launch: &l) }
  }

  private static func watchKey(_ n: NeedsYou) -> String? {
    switch n {
    case .relayUnreachable: return "relay"
    case .notReading: return "unseen"
    case .stalled: return "stall"
    default: return nil
    }
  }
}
