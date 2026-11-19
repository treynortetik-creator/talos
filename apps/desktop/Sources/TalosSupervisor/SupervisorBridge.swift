import Foundation
import TalosDesktopCore

/// The success signal of a Main start is its bridge being live, not a channels notice (Claude Code 2.1.322 prints none on a resumed start,
/// even with its MCP server connected; 2026-11-09). The live bridge writes `status.json` in the Talos home every 15 seconds; this start's
/// bridge is one stamped after the spawn, in `live` mode, from a process that is still there.
extension Supervisor {
  /// Claude is ready for typing: its input box is on a screen with no dialog shape on it (`DialogMatcher.liveDialog`) (so the warning is gone).
  /// A plain loading line ("Setting up the workspace") is not ready; a resumed conversation ends in the box.
  static func claudeIsReady(rows: [String], live: DialogMatcher.Screen, warningLive: Bool) -> Bool {
    live == .none && !warningLive && PointerTyper.inputBox(rows: rows) != nil
  }

  /// Which needs-you lines open the terminal beside them. Main's warning and its bridge have a popup and a line of their own; the pane tells
  /// nothing more.
  static func opensTerminal(for n: NeedsYou) -> Bool {
    switch n {
    // a dialog never to be answered (computer use: Enter opens System Settings) is not brought forward, so no stray key can reach it
    case .dialog(let label): return !DialogMatcher.Screen.answerless(label: label)
    case .stuck, .startStalled, .notReading, .stalled: return true
    case .confirmColdStart, .restartNotConfirmed, .bridgeNotLive, .relayUnreachable: return false
    }
  }

  /// This start's bridge is up: `status.json` says `live`, from a running process, stamped after the spawn and under 45 seconds old.
  func bridgeIsLive(_ l: Launch) -> Bool { liveBridgeStatus(l) != nil }

  /// This start's bridge status when it is live (as `bridgeIsLive`), else nil.
  func liveBridgeStatus(_ l: Launch) -> BridgeStatus? {
    guard let data = probe.readFile(talosAppHome + "/status.json"), let status = BridgeStatus.decode(data), status.mode == .live else { return nil }
    let nowMs = options.wallClock()
    let stampMs = status.updatedAt.timeIntervalSince1970 * 1000
    // the bridge is Main's child: a process of Main's group (as `recordHolders` finds it), so an old bridge still running does not count
    guard stampMs >= l.startedWallMs && nowMs - stampMs < 45_000 && probe.snapshot(status.pid)?.pgid == l.childPid else { return nil }
    return status
  }

  /// Main only, and only when the app asks (`Options.checksBridge`): a live bridge is seen once and ends the check (the Bridge line and the
  /// recovery watch it from there); none within `bridgeWait` of the warning being answered is a Needs-you line, with the reason from Claude
  /// Code's MCP log when it can be read. Main is not stopped for it: the owner decides.
  func checkBridge(_ l: inout Launch, now: Double) {
    guard options.checksBridge, options.name == TmuxCommands.mainSession, !l.bridgeSeenLive else { return }
    if bridgeIsLive(l) {
      l.bridgeSeenLive = true
      if case .bridgeNotLive = needsYou { needsYou = nil }
      return
    }
    guard phase == .running, let answered = l.answeredAt ?? (l.expectsDevDialog ? nil : l.startedAt), now - answered >= timings.bridgeWait else { return }
    if needsYou == nil || needsYou == .startStalled {
      if l.notifiedScreens.contains("bridge"), let a = l.bridgeAlarm {
        needsYou = a  // a dialog took the slot and is answered: the alarm comes back, told no second time
      } else {
        // the bridge's own config.json first: a damaged one stops the bridge, and the MCP log often says only "connection closed"
        let configPath = talosAppHome + "/config.json"
        let a = NeedsYou.bridgeNotLive(BridgeConfigCheck.problem(probe.readFile(configPath), path: configPath) ?? mcpLogReason(l))
        l.bridgeAlarm = a
        raiseNeedsYou(a, key: "bridge", launch: &l)
      }
    }
  }

  /// Why the bridge did not start, from Claude Code's MCP log for the talos-app server of this folder. It keeps the log under
  /// `~/Library/Caches/claude-cli-nodejs/<folder, every non-alphanumeric as "-">/mcp-logs-talos-app/*.jsonl`, one JSON object per line with
  /// `debug` or `error` text and a `sessionId` (not matched: a resume can change it). The newest `error` line of the newest log wins over the
  /// debug lines around it; with no error, the newest debug line; nothing readable is nil.
  func mcpLogReason(_ l: Launch) -> String? {
    let folder = String(l.agentDir.map { $0.isASCII && ($0.isLetter || $0.isNumber) ? $0 : "-" })
    let dir = options.home + "/Library/Caches/claude-cli-nodejs/" + folder + "/mcp-logs-talos-app"
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return nil }
    for name in names.filter({ $0.hasSuffix(".jsonl") }).sorted(by: >) {
      guard let data = probe.readFile(dir + "/" + name) else { continue }
      var debug: String?
      for line in String(decoding: data, as: UTF8.self).split(separator: "\n").reversed() {
        guard let o = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { continue }
        if let e = o["error"] as? String, !e.isEmpty { return String(e.prefix(300)) }
        if debug == nil, let d = o["debug"] as? String, !d.isEmpty { debug = String(d.prefix(300)) }
      }
      if let debug { return debug }
    }
    return nil
  }
}
