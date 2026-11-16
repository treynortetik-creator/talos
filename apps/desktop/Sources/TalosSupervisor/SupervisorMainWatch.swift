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
    // the pane's output time is a tmux call: read only while a message waits and Main has not printed since
    // (from the tick after the message is first seen; the quiet counts from that first read)
    let out = l.mainWatch.wantsPaneOutput ? host.lastOutputAt() : nil
    l.mainWatch.observe(status: status, paneOutputAt: out, awakeNow: awake)
    let relay = l.mainWatch.relayDown(awakeNow: awake)
    let notReading = l.mainWatch.notReading(awakeNow: awake) != nil
    settle(relay.down ? .relayUnreachable(relay.closeCode) : nil, key: "relay", launch: &l)
    settle(notReading ? .notReading : nil, key: "unseen", launch: &l)
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
    default: return nil
    }
  }
}
